// src/server/approval.ts
// Run B: long-running Express server for human review.
// GET  /review/:draftId  — renders the review page with approve/reject/request-edits buttons
// POST /action/:draftId  — handles the action; approve triggers publish()

import 'dotenv/config';
import express from 'express';
import type { Post, CritiqueOutput } from '../types';
import { getDraft, updateDraft, getPostById, getMeta } from '../db';
import { publish } from '../pipeline/publish';
import { repurpose } from '../pipeline/repurpose';
import { regenerate } from '../pipeline/regenerate';
import { LAST_POLL_KEY } from '../pipeline/cycle';
import { renderMarkdown, escapeHtml } from '../lib/markdown';
import { buildScorecard } from '../lib/scorecard';

const esc = escapeHtml;

const app = express();
// HTML forms POST as application/x-www-form-urlencoded — must parse that, not JSON
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// ---------------------------------------------------------------------------
// GET /status — last live-ingestion poll result (written by the watcher process)
// ---------------------------------------------------------------------------

app.get('/status', (_req, res) => {
  const raw = getMeta(LAST_POLL_KEY);
  if (!raw) {
    res.json({ lastPoll: null, message: 'no poll has run yet' });
    return;
  }
  res.json({ lastPoll: JSON.parse(raw) as unknown });
});

// ---------------------------------------------------------------------------
// GET /review/:draftId
// ---------------------------------------------------------------------------

app.get('/review/:draftId', (req, res) => {
  const draft = getDraft(req.params.draftId);
  if (!draft) {
    res.status(404).send('Draft not found');
    return;
  }

  const rawContent = draft.revised_draft ?? draft.raw_draft ?? '[No content generated]';
  // Extract TITLE: line from the revise-pass output contract (Stage 4)
  let proposedTitle: string | null = null;
  let content = rawContent;
  const firstLine = rawContent.split('\n')[0]?.trim() ?? '';
  if (firstLine.startsWith('TITLE:')) {
    proposedTitle = firstLine.replace(/^TITLE:\s*/, '').trim();
    const rest = rawContent.split('\n').slice(1);
    const bodyStart = rest.findIndex(l => l.trim() !== '');
    content = rest.slice(bodyStart >= 0 ? bodyStart : 0).join('\n').trim();
  }

  const statusColors: Record<string, { bg: string; fg: string }> = {
    pending:     { bg: '#fef3c7', fg: '#92400e' },
    approved:    { bg: '#d1fae5', fg: '#065f46' },
    published:   { bg: '#bfdbfe', fg: '#1e3a8a' },
    rejected:    { bg: '#fee2e2', fg: '#991b1b' },
    needs_edits: { bg: '#fde8d8', fg: '#7c2d12' },
    failed:      { bg: '#fce7f3', fg: '#831843' },
  };
  const color = statusColors[draft.status] ?? { bg: '#f3f4f6', fg: '#374151' };

  // Statuses where action buttons are shown
  const canAct = ['pending', 'needs_edits', 'failed'].includes(draft.status);
  const maxRevisions = parseInt(process.env.MAX_REVISIONS ?? '3', 10);
  const atCap = draft.revision_count >= maxRevisions;

  const id = draft.id;

  // Source posts: a pillar draft synthesizes several. Resolve each from the posts table;
  // degrade gracefully to the bare id if a post isn't found (e.g. live-ingested, not in seed).
  const n = draft.source_post_ids.length;
  const isPillar = n > 1;
  let sourceItems = '';
  try {
    sourceItems = draft.source_post_ids
      .map((pid) => {
        const p: Post | undefined = getPostById(pid);
        if (!p) return `<li><span class="muted">${esc(pid)}</span> (not in posts table)</li>`;
        const label = esc(p.text.split('\n').find((l) => l.trim())?.slice(0, 110) ?? pid);
        return `<li><a href="${esc(p.url)}" target="_blank" rel="noopener noreferrer">${label}</a></li>`;
      })
      .join('');
  } catch {
    sourceItems = draft.source_post_ids.map((pid) => `<li>${esc(pid)}</li>`).join('');
  }

  // Rendered article (markdown → HTML; renderer escapes internally).
  const articleHtml = renderMarkdown(content);

  // Deterministic AEO scorecard (read-only). critique is a JSON string on the row.
  let critiqueObj: CritiqueOutput | undefined;
  try {
    critiqueObj = draft.critique ? (JSON.parse(draft.critique) as CritiqueOutput) : undefined;
  } catch {
    critiqueObj = undefined;
  }
  const scorecard = buildScorecard(content, proposedTitle, critiqueObj);
  const scoreWarnings = scorecard.filter((c) => c.status === 'warn').length;
  const scorecardRows = scorecard
    .map(
      (c) => `<tr>
        <td class="sc-icon ${c.status}">${c.status === 'pass' ? '✓' : '!'}</td>
        <td class="sc-label">${esc(c.label)}</td>
        <td class="sc-detail">${esc(c.detail)}</td>
      </tr>`,
    )
    .join('');

  const v = draft.verification;
  const verificationHtml = v
    ? v.passed
      ? `<div class="panel-body ok"><strong>Passed</strong> — no slop terms or ungrounded figures detected.</div>`
      : `<div class="panel-body warn">
           <strong>Issues found — review before approving.</strong>
           ${v.bannedTerms.length > 0 ? `<p class="chips"><span class="chip-label">Banned terms:</span> ${v.bannedTerms.map((t) => `<code>${esc(t)}</code>`).join(' ')}</p>` : ''}
           ${v.ungroundedNumbers.length > 0 ? `<p class="chips"><span class="chip-label">Ungrounded figures:</span> ${v.ungroundedNumbers.map((x) => `<code>${esc(x)}</code>`).join(' ')}</p>` : ''}
         </div>`
    : `<div class="panel-body muted">Not verified (draft predates the verification layer).</div>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Review — ${proposedTitle ? esc(proposedTitle.slice(0, 50)) : id.slice(0, 8)}</title>
  <style>
    :root {
      --ink:#1a1a1a; --muted:#6b7280; --line:#e5e7eb; --bg:#ffffff; --soft:#f9fafb;
      --blue:#2563eb; --green:#059669; --amber:#b45309; --red:#dc2626;
    }
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      max-width: 820px; margin: 0 auto; padding: 40px 24px 96px; color: var(--ink);
      background: var(--bg); line-height: 1.5;
    }
    a { color: var(--blue); }
    .muted { color: var(--muted); }
    /* Header */
    .topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    .eyebrow { font-size: 12px; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); font-weight: 700; }
    .badge {
      display: inline-block; padding: 4px 14px; border-radius: 999px;
      font-size: 12px; font-weight: 700; letter-spacing: .05em;
      background: ${color.bg}; color: ${color.fg};
    }
    h1.title { font-size: 28px; line-height: 1.25; margin: 10px 0 6px; font-weight: 700; letter-spacing: -.01em; }
    h1.title.untitled { color: var(--muted); font-weight: 600; }
    .submeta { font-size: 13px; color: var(--muted); margin: 0; }
    .submeta code { font-size: 12px; }
    .rev-pill {
      display:inline-block; font-size:12px; font-weight:600; padding:2px 9px; border-radius:999px;
      background:#f3f4f6; color:#374151; margin-left:4px;
    }
    .rev-pill.cap { background:#fef3c7; color:#92400e; }
    /* Section + panels */
    section { margin-top: 30px; }
    h2.section { font-size: 13px; letter-spacing: .06em; text-transform: uppercase; color: var(--muted);
      font-weight: 700; margin: 0 0 10px; }
    .panel { border: 1px solid var(--line); border-radius: 10px; overflow: hidden; }
    .panel-body { padding: 14px 16px; font-size: 14px; }
    .panel-body.ok { background: #ecfdf5; color: #065f46; }
    .panel-body.warn { background: #fff7ed; color: #9a3412; }
    .panel-body.muted { background: var(--soft); }
    .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
    @media (max-width: 680px) { .grid2 { grid-template-columns: 1fr; } }
    /* Theme + sources */
    .theme { display: inline-block; background: #eef2ff; color: #3730a3; border: 1px solid #c7d2fe;
      border-radius: 8px; padding: 5px 12px; font-size: 13px; font-weight: 600; }
    ul.sources { margin: 10px 0 0; padding-left: 20px; font-size: 14px; }
    ul.sources li { margin: 4px 0; }
    /* Scorecard */
    table.scorecard { width: 100%; border-collapse: collapse; font-size: 14px; }
    table.scorecard td { padding: 9px 8px; border-bottom: 1px solid var(--line); vertical-align: middle; }
    table.scorecard tr:last-child td { border-bottom: none; }
    .sc-icon { width: 26px; text-align: center; font-weight: 800; border-radius: 6px; }
    .sc-icon.pass { color: var(--green); }
    .sc-icon.warn { color: var(--amber); }
    .sc-label { font-weight: 600; }
    .sc-detail { color: var(--muted); text-align: right; }
    .chips { margin: 8px 0 0; }
    .chip-label { font-weight: 600; }
    .panel-body code, .chips code {
      background: rgba(0,0,0,.06); padding: 1px 6px; border-radius: 4px; font-size: 12.5px;
    }
    /* Article */
    article {
      font-family: Georgia, "Times New Roman", serif; font-size: 17px; line-height: 1.72; color: #222;
    }
    article h1 { font-size: 24px; line-height: 1.3; margin: 28px 0 10px; }
    article h2 { font-size: 20px; line-height: 1.3; margin: 30px 0 8px; }
    article h3 { font-size: 17px; margin: 22px 0 6px; }
    article p { margin: 0 0 16px; }
    article ul { margin: 0 0 16px; padding-left: 24px; }
    article li { margin: 4px 0; }
    article a { color: var(--blue); }
    article hr { border: none; border-top: 1px solid var(--line); margin: 28px 0; }
    article code { background: rgba(0,0,0,.06); padding: 1px 6px; border-radius: 4px; font-size: 15px; }
    /* Actions */
    .actions { margin-top: 36px; padding-top: 24px; border-top: 1px solid var(--line); }
    .action-buttons { display: flex; gap: 12px; flex-wrap: wrap; }
    form { margin: 0; }
    button { padding: 11px 22px; font-size: 15px; border-radius: 8px; cursor: pointer;
      font-weight: 600; border: none; line-height: 1.4; }
    .btn-approve { background: var(--green); color: #fff; }
    .btn-reject { background: #fff; color: var(--red); border: 1px solid #fca5a5; }
    .btn-edits { background: var(--amber); color: #fff; }
    .edits { margin-top: 18px; max-width: 560px; }
    textarea { display: block; width: 100%; padding: 11px; border: 1px solid #d1d5db; border-radius: 8px;
      font-size: 14px; font-family: inherit; margin: 6px 0 10px; resize: vertical; }
    label { font-size: 14px; font-weight: 600; display: block; }
    .cap-note { color: #92400e; background: #fef3c7; padding: 12px 16px; border-radius: 8px;
      border: 1px solid #fcd34d; font-size: 14px; margin-top: 16px; }
    .no-actions { color: var(--muted); font-size: 14px; }
    .cms-link { margin-top: 18px; font-size: 15px; }
    .note-block { background: #fffbeb; border: 1px solid #fcd34d; border-radius: 8px;
      padding: 12px 16px; font-size: 14px; margin-top: 14px; }
  </style>
</head>
<body>
  <div class="topbar">
    <span class="eyebrow">Content Review</span>
    <span class="badge">${draft.status.toUpperCase()}</span>
  </div>

  <h1 class="title${proposedTitle ? '' : ' untitled'}">${proposedTitle ? esc(proposedTitle) : 'Untitled draft'}</h1>
  <p class="submeta">
    ${proposedTitle ? `${proposedTitle.length} chars &middot; ` : ''}Draft <code>${id}</code>
    <span class="rev-pill${atCap ? ' cap' : ''}">rev ${draft.revision_count}/${maxRevisions}</span>
  </p>
  <p class="submeta">Updated ${esc(draft.updated_at)}</p>

  ${draft.cms_url
    ? `<p class="cms-link">Published: <a href="${esc(draft.cms_url)}" target="_blank" rel="noopener noreferrer">${esc(draft.cms_url)}</a></p>`
    : ''}

  <section>
    <h2 class="section">${isPillar ? `Source posts — ${n} synthesized into one pillar` : 'Source post'}</h2>
    ${draft.theme ? `<span class="theme">Theme: ${esc(draft.theme)}</span>` : ''}
    <ul class="sources">${sourceItems}</ul>
  </section>

  <section class="grid2">
    <div>
      <h2 class="section">AEO scorecard ${scoreWarnings > 0 ? `<span class="muted">(${scoreWarnings} to review)</span>` : '<span class="muted">(all clear)</span>'}</h2>
      <div class="panel"><table class="scorecard">${scorecardRows}</table></div>
    </div>
    <div>
      <h2 class="section">Verification</h2>
      <div class="panel">${verificationHtml}</div>
    </div>
  </section>

  ${draft.reviewer_note
    ? `<div class="note-block"><strong>Reviewer note:</strong> ${esc(draft.reviewer_note)}</div>`
    : ''}

  <section>
    <h2 class="section">Draft</h2>
    <article>${articleHtml}</article>
  </section>

  <div class="actions">
    ${canAct
      ? `<div class="action-buttons">
           <form method="POST" action="/action/${id}">
             <button type="submit" name="action" value="approve" class="btn-approve">Approve &amp; Publish</button>
           </form>
           <form method="POST" action="/action/${id}">
             <button type="submit" name="action" value="reject" class="btn-reject">Reject</button>
           </form>
         </div>
         ${atCap
           ? `<p class="cap-note"><strong>Revision cap reached (${maxRevisions}/${maxRevisions}).</strong> Approve or Reject this draft — no more re-gens available.</p>`
           : `<form method="POST" action="/action/${id}" class="edits">
                <label for="note-${id}">Request edits <span class="muted" style="font-weight:400">(revision ${draft.revision_count}/${maxRevisions})</span></label>
                <textarea id="note-${id}" name="note" rows="3" placeholder="Describe the changes needed…" required></textarea>
                <button type="submit" name="action" value="needs_edits" class="btn-edits">Request Edits</button>
              </form>`
         }`
      : `<p class="no-actions">No actions available — status is <strong>${draft.status}</strong>.</p>`}
  </div>
</body>
</html>`);
});

// ---------------------------------------------------------------------------
// POST /action/:draftId
// ---------------------------------------------------------------------------

app.post('/action/:draftId', async (req, res) => {
  const id = req.params.draftId;
  const { action, note } = req.body as { action?: string; note?: string };

  // Always re-fetch — never guard on a stale in-memory object
  const draft = getDraft(id);
  if (!draft) {
    res.status(404).send('Draft not found');
    return;
  }

  // --- APPROVE ---
  if (action === 'approve') {
    // 'failed' is allowed: a draft whose publish failed can be retried.
    // 'published' is terminal. 'rejected' cannot be approved.
    if (!['pending', 'needs_edits', 'failed'].includes(draft.status)) {
      res.status(400).send(
        `Cannot approve draft with status: ${draft.status}. ` +
          `Allowed from: 'pending', 'needs_edits', or 'failed'.`,
      );
      return;
    }

    updateDraft(id, { status: 'approved' });
    // Re-fetch so publish() receives the updated status
    const approvedDraft = getDraft(id)!;

    try {
      await publish(approvedDraft);
      const published = getDraft(id)!;
      if (published.cms_url) {
        // Post-publish: generate channel variants + deliver to Slack. The post is already
        // live and persisted — a repurpose failure must NOT revert the publish or error this
        // response. repurpose() never writes status, so publish state is structurally safe.
        try {
          await repurpose(published);
        } catch (err) {
          const rmsg = err instanceof Error ? err.message : String(err);
          console.error(`[approve] repurpose failed draft=${id} (post is live): ${rmsg}`);
        }
        res.redirect(302, published.cms_url);
        return;
      }
      res.status(500).send('Publish completed but returned no CMS URL.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[approve] draft=${id} publish_error="${msg}"`);
      // Set status to 'failed' so the Approve button re-appears on the review page
      updateDraft(id, { status: 'failed' });
      res.status(500).send(`<!DOCTYPE html>
<html><body style="font-family:sans-serif;max-width:640px;margin:40px auto;padding:0 24px">
  <h2>Publish Failed</h2>
  <p>Draft status set to <code>failed</code> — click <strong>Approve</strong> on the review page to retry once the issue is resolved.</p>
  <pre style="background:#fce7f3;border:1px solid #f9a8d4;padding:14px;border-radius:6px;font-size:13px;white-space:pre-wrap">${msg.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>
  <p><a href="/review/${id}">Back to review page</a></p>
</body></html>`);
    }
    return;
  }

  // --- REJECT ---
  if (action === 'reject') {
    updateDraft(id, { status: 'rejected' });
    res.send(`<!DOCTYPE html>
<html><body style="font-family:sans-serif;max-width:640px;margin:40px auto;padding:0 24px">
  <h2>Draft Rejected</h2>
  <p>Draft <code>${id}</code> has been rejected.</p>
  <p><a href="/review/${id}">View draft</a></p>
</body></html>`);
    return;
  }

  // --- REQUEST EDITS ---
  if (action === 'needs_edits') {
    if (!['pending', 'needs_edits'].includes(draft.status)) {
      res.status(400).send(
        `Cannot request edits for draft with status: ${draft.status}. ` +
          `Allowed from: 'pending' or 'needs_edits'.`,
      );
      return;
    }

    const MAX_REVISIONS = parseInt(process.env.MAX_REVISIONS ?? '3', 10);
    if (draft.revision_count >= MAX_REVISIONS) {
      res.status(400).send(
        `Revision cap reached (${MAX_REVISIONS}). Approve or reject this draft — no more re-gens available.`,
      );
      return;
    }

    const noteText = (note ?? '').trim();
    if (!noteText) {
      res.status(400).send('A reviewer note is required when requesting edits.');
      return;
    }

    // Store note and flip to needs_edits. revision_count increments on success only.
    updateDraft(id, { status: 'needs_edits', reviewer_note: noteText });

    // Fire re-gen in background — do NOT await; response goes out immediately
    regenerate(id).catch((err: unknown) => {
      console.error(
        `[action] re-gen fire-and-forget error draft=${id}:`,
        err instanceof Error ? err.message : err,
      );
    });

    res.status(202).send(`<!DOCTYPE html>
<html><body style="font-family:sans-serif;max-width:640px;margin:40px auto;padding:0 24px">
  <h2>Edits Requested</h2>
  <p>Re-generating in the background. The Slack notification will fire when the new draft is ready.</p>
  <pre style="background:#fffbeb;border:1px solid #fcd34d;padding:14px;border-radius:6px;font-size:13px;white-space:pre-wrap">${noteText.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>
  <p><a href="/review/${id}">Check draft status</a></p>
</body></html>`);
    return;
  }

  res.status(400).send(`Unknown action: ${action}`);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export { app };

if (process.env.NODE_ENV !== 'test') {
  const PORT = parseInt(process.env.PORT ?? '3000', 10);
  app.listen(PORT, () => {
    console.log(`[server] Approval server running on http://localhost:${PORT}`);
    console.log(`[server] Review a draft at http://localhost:${PORT}/review/<draftId>`);
  });
}

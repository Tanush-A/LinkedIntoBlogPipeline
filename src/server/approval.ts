// src/server/approval.ts
// Run B: long-running Express server for human review.
// GET  /review/:draftId  — renders the review page with approve/reject/request-edits buttons
// POST /action/:draftId  — handles the action; approve triggers publish()

import 'dotenv/config';
import express from 'express';
import { getDraft, updateDraft } from '../db';
import { publish } from '../pipeline/publish';
import { regenerate } from '../pipeline/regenerate';

const app = express();
// HTML forms POST as application/x-www-form-urlencoded — must parse that, not JSON
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

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

  const escapedContent = content
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  const id = draft.id;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Review Draft — ${id.slice(0, 8)}</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      max-width: 860px; margin: 48px auto; padding: 0 24px; color: #111;
    }
    h1 { font-size: 22px; margin: 0 0 8px; }
    .badge {
      display: inline-block; padding: 4px 14px; border-radius: 20px;
      font-size: 12px; font-weight: 700; letter-spacing: .05em;
      background: ${color.bg}; color: ${color.fg}; margin-bottom: 16px;
    }
    .meta { font-size: 13px; color: #6b7280; margin: 3px 0; }
    h2 { font-size: 16px; margin: 28px 0 8px; }
    .content {
      background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;
      padding: 24px; white-space: pre-wrap; line-height: 1.7;
      font-size: 15px; font-family: Georgia, serif;
      max-height: 520px; overflow-y: auto;
    }
    .actions { margin-top: 28px; display: flex; flex-direction: column; gap: 14px; }
    .action-row { display: flex; align-items: flex-start; gap: 0; }
    form { margin: 0; }
    button {
      padding: 10px 22px; font-size: 15px; border-radius: 6px;
      cursor: pointer; font-weight: 600; border: none; line-height: 1.4;
    }
    .btn-approve { background: #10b981; color: #fff; }
    .btn-reject  { background: #ef4444; color: #fff; }
    .btn-edits   { background: #f59e0b; color: #fff; margin-top: 6px; }
    textarea {
      display: block; width: 100%; padding: 10px;
      border: 1px solid #d1d5db; border-radius: 6px;
      font-size: 14px; margin: 6px 0 8px; resize: vertical;
    }
    label { font-size: 14px; font-weight: 600; display: block; margin-bottom: 4px; }
    .cms-link { margin-top: 20px; font-size: 15px; }
    .cms-link a { color: #2563eb; }
    .note-block {
      background: #fffbeb; border: 1px solid #fcd34d;
      border-radius: 6px; padding: 12px 16px; font-size: 13px; margin-top: 12px;
    }
    .no-actions { color: #6b7280; font-size: 14px; margin-top: 16px; }
  </style>
</head>
<body>
  <h1>Content Review</h1>
  <span class="badge">${draft.status.toUpperCase()}</span>

  <p class="meta">Draft ID: <code>${id}</code></p>
  ${proposedTitle ? `<p class="meta">Proposed title: <strong>${proposedTitle.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</strong> <span style="color:#9ca3af;font-weight:400">(${proposedTitle.length} chars)</span></p>` : ''}
  <p class="meta">Revision: ${draft.revision_count}</p>
  <p class="meta">Created: ${draft.created_at}</p>
  <p class="meta">Updated: ${draft.updated_at}</p>

  <h2>Draft Content</h2>
  <div class="content">${escapedContent}</div>

  ${draft.cms_url
    ? `<p class="cms-link">Published: <a href="${draft.cms_url}" target="_blank">${draft.cms_url}</a></p>`
    : ''}

  ${draft.reviewer_note
    ? `<div class="note-block"><strong>Reviewer note:</strong> ${draft.reviewer_note.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</div>`
    : ''}

  <div class="actions">
    ${canAct ? `
    <form method="POST" action="/action/${id}">
      <button type="submit" name="action" value="approve" class="btn-approve">
        Approve &amp; Publish
      </button>
    </form>

    <form method="POST" action="/action/${id}">
      <button type="submit" name="action" value="reject" class="btn-reject">
        Reject
      </button>
    </form>

    ${atCap
      ? `<p class="no-actions" style="color:#92400e;background:#fef3c7;padding:12px 16px;border-radius:6px;border:1px solid #fcd34d;">
           Revision cap reached (${maxRevisions}/${maxRevisions}). Approve or Reject this draft — no more re-gens available.
         </p>`
      : `<form method="POST" action="/action/${id}">
           <label for="note-${id}">Request edits <span style="font-weight:400;color:#6b7280">(revision ${draft.revision_count}/${maxRevisions})</span></label>
           <textarea id="note-${id}" name="note" rows="3" placeholder="Describe the changes needed…" required></textarea>
           <button type="submit" name="action" value="needs_edits" class="btn-edits">
             Request Edits
           </button>
         </form>`
    }
    ` : `<p class="no-actions">No actions available — status is <strong>${draft.status}</strong>.</p>`}
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

const PORT = parseInt(process.env.PORT ?? '3000', 10);
app.listen(PORT, () => {
  console.log(`[server] Approval server running on http://localhost:${PORT}`);
  console.log(`[server] Review a draft at http://localhost:${PORT}/review/<draftId>`);
});

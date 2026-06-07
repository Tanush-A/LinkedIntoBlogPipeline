// src/pipeline/regenerate.ts
// Stage 3: background re-gen triggered by a reviewer's "request edits" action.
// Runs only the revise pass (Pass 4) — accumulates edits on the previous revised_draft.
// Called fire-and-forget from the approval server; must be self-contained.

import 'dotenv/config';
import OpenAI from 'openai';
import type { CritiqueOutput } from '../types';
import { getDraft, updateDraft, loadPosts } from '../db';
import { notify } from './notify';
import { buildReviseMessages } from '../../prompts/revise';
import { verifyDraft } from '../lib/verify';

/**
 * Re-runs Pass 4 (revise) for a draft in needs_edits state.
 * On success: writes new revised_draft, increments revision_count, sets status to pending, re-notifies.
 * On failure: sets status back to needs_edits (unchanged) and prefixes reviewer_note with error.
 *
 * Called fire-and-forget — the approval server does not await this.
 */
export async function regenerate(draftId: string): Promise<void> {
  // Always re-fetch — never guard on caller's stale object
  const draft = getDraft(draftId);
  if (!draft) {
    console.error(`[regenerate] draft=${draftId} not found — aborting`);
    return;
  }
  if (draft.status !== 'needs_edits') {
    console.log(`[regenerate] draft=${draftId} status=${draft.status} — not needs_edits, skipping`);
    return;
  }

  const currentContent = draft.revised_draft ?? draft.raw_draft;
  if (!currentContent) {
    console.error(`[regenerate] draft=${draftId} has no content to revise`);
    updateDraft(draftId, {
      status: 'needs_edits',
      reviewer_note: '[Re-gen failed] Draft has no content to revise.',
    });
    return;
  }

  if (!draft.critique) {
    console.error(`[regenerate] draft=${draftId} has no critique — cannot revise`);
    updateDraft(draftId, {
      status: 'needs_edits',
      reviewer_note: '[Re-gen failed] Draft has no critique stored.',
    });
    return;
  }

  const reviewerNote = draft.reviewer_note;
  const critique: CritiqueOutput = JSON.parse(draft.critique);
  const posts = loadPosts(draft.source_post_ids);

  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

    console.log(`[regenerate] revise  draft=${draftId} revision=${draft.revision_count}`);
    const reviseResp = await client.chat.completions.create({
      model: process.env.OPENAI_MODEL ?? 'gpt-5.5',
      max_completion_tokens: 4000,
      messages: buildReviseMessages(currentContent, critique, reviewerNote),
    });

    const content = reviseResp.choices[0].message.content;
    if (!content) throw new Error('revise pass returned null content');

    // Re-verify: reviewer may have introduced or removed slop/ungrounded figures.
    // Grounding corpus = ALL source posts so figures the authors cited remain grounded.
    const verification = verifyDraft(content, posts.map((p) => p.text));
    console.log(
      `[regenerate] verify draft=${draftId}` +
      ` passed=${verification.passed}` +
      ` banned=${verification.bannedTerms.length}` +
      ` ungrounded=${verification.ungroundedNumbers.length}`,
    );

    // Increment revision_count on success only (per decision: increment-on-success)
    const updated = updateDraft(draftId, {
      revised_draft: content,
      status: 'pending',
      revision_count: draft.revision_count + 1,
      verification,
    });

    console.log(`[regenerate] done    draft=${draftId} revision=${updated.revision_count} status=pending`);

    // Re-fetch so notify() receives the freshly updated draft
    const fresh = getDraft(draftId)!;
    await notify(fresh, posts);
    console.log(`[regenerate] re-notified Slack for draft=${draftId}`);
  } catch (err) {
    const msg = `[Re-gen failed] ${err instanceof Error ? err.message : String(err)}`;
    console.error(`[regenerate] error   draft=${draftId}: ${msg}`);
    // Revert to needs_edits — do NOT increment revision_count; failure is free
    updateDraft(draftId, { status: 'needs_edits', reviewer_note: msg });
  }
}

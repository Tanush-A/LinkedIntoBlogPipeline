// src/run.ts
// Run A: pipeline entry point.
// Ingest unprocessed seed posts → stub generate → write Draft as 'pending' → Slack notify → exit.
// Run B (src/server/approval.ts) handles all approval interactions.

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { ingestPosts } from './pipeline/ingest';
import { generate } from './pipeline/generate';
import { notify } from './pipeline/notify';
import { insertDraft } from './db';

async function main(): Promise<void> {
  const posts = ingestPosts();

  if (posts.length === 0) {
    console.log('[ingest] No new posts — all seed posts already have drafts. Exiting.');
    return;
  }

  console.log(`[ingest] ${posts.length} new post(s) to process.`);

  for (const post of posts) {
    const draftId = randomUUID();
    console.log(`[generate] post=${post.id} draft=${draftId}`);

    const result = await generate(post);

    const draft = insertDraft({
      id: draftId,
      source_post_id: post.id,
      status: 'pending',
      revision_count: 0,
      extracted_idea: result.extracted_idea,
      raw_draft: result.raw_draft,
      critique: result.critique,
      revised_draft: result.revised_draft,
      verification: result.verification,
    });

    console.log(`[db] draft=${draftId} status=pending`);

    await notify(draft, post);
    console.log(`[notify] Slack notification sent for draft=${draftId}`);

    const baseUrl = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
    console.log(`[run] Review at: ${baseUrl}/review/${draftId}`);
  }

  console.log('[run] Done. Exiting Run A.');
}

main().catch((err: unknown) => {
  console.error('[run] Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});

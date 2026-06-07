// src/run.ts
// Run A: pipeline entry point.
// Ingest → partition (judge) → generate ONE draft per partition → notify → exit.
// A singleton partition (n=1) is the 1:1 case; a group (n≥2) becomes one pillar draft.
// Run B (src/server/approval.ts) handles all approval interactions.

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { ingestPartitions } from './pipeline/ingest';
import { generate } from './pipeline/generate';
import { notify } from './pipeline/notify';
import { insertDraft, getPublishedRefs } from './db';

async function main(): Promise<void> {
  const partitions = await ingestPartitions();

  if (partitions.length === 0) {
    console.log('[ingest] No new partitions — all seed posts already have drafts. Exiting.');
    return;
  }

  console.log(`[ingest] ${partitions.length} partition(s) to process.`);

  const publishedRefs = getPublishedRefs();

  for (const part of partitions) {
    const draftId = randomUUID();
    const postLabel = part.posts.map((p) => p.id).join('+');
    console.log(`[generate] post=${postLabel} n=${part.posts.length} theme="${part.theme}" draft=${draftId}`);

    // Only pass refs whose source material overlaps this partition (topic-cluster linking).
    const refs = publishedRefs.filter((r) =>
      r.source_post_ids.some((id) => part.posts.some((p) => p.id === id)),
    );

    const result = await generate(part.posts, refs);

    const draft = insertDraft({
      id: draftId,
      source_post_ids: part.posts.map((p) => p.id),
      group_fingerprint: part.fingerprint,
      theme: part.theme,
      status: 'pending',
      revision_count: 0,
      extracted_idea: result.extracted_idea,
      raw_draft: result.raw_draft,
      critique: result.critique,
      revised_draft: result.revised_draft,
      verification: result.verification,
    });

    console.log(`[db] draft=${draftId} status=pending`);

    await notify(draft, part.posts);
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

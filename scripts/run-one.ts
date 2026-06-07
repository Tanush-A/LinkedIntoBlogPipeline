// One-shot: run the pipeline for a single post ID. Delete after use.
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Post } from '../src/types';
import { generate } from '../src/pipeline/generate';
import { notify } from '../src/pipeline/notify';
import { insertDraft, getDraftByFingerprint, upsertPost } from '../src/db';
import { groupFingerprint } from '../src/lib/fingerprint';

const TARGET_ID = process.argv[2];
if (!TARGET_ID) {
  console.error('Usage: tsx scripts/run-one.ts <post_id>');
  process.exit(1);
}

const seedPath = resolve(__dirname, '..', 'seed', 'posts.json');
const posts = JSON.parse(readFileSync(seedPath, 'utf-8')) as Post[];
const post = posts.find((p) => p.id === TARGET_ID);

if (!post) {
  console.error(`No post found with id=${TARGET_ID}`);
  process.exit(1);
}

async function main() {
  const fingerprint = groupFingerprint([post!.id]);
  const existing = getDraftByFingerprint(fingerprint);
  if (existing) {
    console.log(`[skip] Draft already exists for post=${post!.id} (draft=${existing.id})`);
    process.exit(0);
  }

  // Make the post resolvable from the DB (loadPosts/regenerate read the posts table).
  upsertPost(post!);

  const draftId = randomUUID();
  console.log(`[generate] post=${post!.id} draft=${draftId}`);

  const result = await generate([post!]);

  const draft = insertDraft({
    id: draftId,
    source_post_ids: [post!.id],
    group_fingerprint: fingerprint,
    status: 'pending',
    revision_count: 0,
    extracted_idea: result.extracted_idea,
    raw_draft: result.raw_draft,
    critique: result.critique,
    revised_draft: result.revised_draft,
    verification: result.verification,
  });

  console.log(`[db] draft=${draftId} status=pending`);

  await notify(draft, [post!]);
  console.log(`[notify] Slack notification sent for draft=${draftId}`);

  const baseUrl = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  console.log(`[run] Review at: ${baseUrl}/review/${draftId}`);
}

main().catch((err: unknown) => {
  console.error('[run-one] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});

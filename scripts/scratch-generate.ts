// scripts/scratch-generate.ts
// Stage 2 verification: run the 4-pass chain on seed post[0], persist, round-trip from DB.
// Does NOT fire Slack or publish — isolated to generate() + db helpers only.

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import posts from '../seed/posts.json';
import { generate } from '../src/pipeline/generate';
import { insertDraft, getDraft } from '../src/db';
import { groupFingerprint } from '../src/lib/fingerprint';

async function main() {
  const post = posts[0];
  console.log(`\n[scratch] Using post: ${post.id} — "${post.text.slice(0, 60)}..."\n`);

  const result = await generate([post]);

  console.log('\n─── extracted_idea ──────────────────────────────────────');
  console.log(JSON.stringify(result.extracted_idea, null, 2));

  console.log('\n─── critique.scores ─────────────────────────────────────');
  console.log(JSON.stringify(JSON.parse(result.critique).scores, null, 2));
  console.log('overall:', JSON.parse(result.critique).overall);

  console.log('\n─── revised_draft (first 600 chars) ────────────────────');
  console.log(result.revised_draft.slice(0, 600));

  // Persist and round-trip to verify serialization
  const id = randomUUID();
  insertDraft({
    id,
    source_post_ids: [post.id],
    group_fingerprint: groupFingerprint([post.id]),
    status: 'pending',
    revision_count: 0,
    extracted_idea: result.extracted_idea,
    raw_draft: result.raw_draft,
    critique: result.critique,
    revised_draft: result.revised_draft,
  });

  const fetched = getDraft(id);
  if (!fetched) throw new Error('Round-trip failed: row not found after insert');
  if (typeof fetched.extracted_idea !== 'object') throw new Error('extracted_idea not an object after round-trip');
  if (typeof fetched.critique !== 'string') throw new Error('critique not a string after round-trip');

  const parsed: unknown = JSON.parse(fetched.critique);
  if (!parsed || typeof parsed !== 'object' || !('scores' in parsed)) {
    throw new Error('critique round-trip JSON invalid');
  }

  console.log('\n[scratch] DB round-trip OK — extracted_idea is object, critique is parseable string');
  console.log('[scratch] Done.\n');
}

main().catch((err: unknown) => {
  console.error('[scratch] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});

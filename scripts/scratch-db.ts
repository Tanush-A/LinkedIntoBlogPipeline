// scripts/scratch-db.ts
// Stage 0 checkpoint: round-trip a Draft through insertDraft / getDraft / updateDraft.
// Uses an in-memory DB so it leaves no artifact. Exits non-zero on any failed assertion.
//
//   npm run scratch:db

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { groupFingerprint } from '../src/lib/fingerprint';

async function main() {
  // Set BEFORE importing db.ts, which reads DATABASE_URL at module load.
  process.env.DATABASE_URL = ':memory:';
  const { insertDraft, getDraft, updateDraft } = await import('../src/db');

  const id = crypto.randomUUID();

  const critique = JSON.stringify({
    scores: {
      hook: 4,
      originality: 4,
      voice_fit: 5,
      value: 4,
      product_integration: 3,
      structure: 4,
      truth: 5,
      extractability: 4,
    },
    overall: 4,
    problems: ['Opening restates the title.'],
    cut_list: ['the second paragraph'],
    strengthen: ['add a concrete number to the hook'],
  });

  // ---- insert ----
  const inserted = insertDraft({
    id,
    source_post_ids: ['linkedin-post-abc123'],
    group_fingerprint: groupFingerprint(['linkedin-post-abc123']),
    status: 'pending',
    revision_count: 0,
    extracted_idea: {
      core_thesis: 'Pipeline reviews fail because reps optimize for activity, not outcomes.',
      supporting_points: ['point one', 'point two'],
      target_audience: 'enterprise CROs managing 50+ reps',
      angle: 'The metric everyone tracks is the one that hides the problem.',
      do_not_reuse: ['some signature phrase'],
      tension: 'The activity metrics that feel like progress are the ones hiding the real problem.',
    },
    raw_draft: 'RAW DRAFT BODY',
    critique, // already a JSON string per the Draft contract
    revised_draft: 'REVISED DRAFT BODY',
    // cms_url intentionally omitted -> must read back as absent (null -> undefined)
  });

  // ---- read back ----
  const got = getDraft(id);
  assert.ok(got, 'getDraft should return the inserted row');

  assert.equal(got.id, id, 'id round-trips');
  assert.deepEqual(got.source_post_ids, ['linkedin-post-abc123'], 'source_post_ids round-trips');
  assert.equal(got.status, 'pending', 'status round-trips');
  assert.equal(got.revision_count, 0, 'revision_count round-trips');

  // object column parsed back into a real object, not a string
  assert.ok(got.extracted_idea, 'extracted_idea present');
  assert.equal(typeof got.extracted_idea, 'object', 'extracted_idea parsed to object');
  assert.equal(
    got.extracted_idea!.target_audience,
    'enterprise CROs managing 50+ reps',
    'nested extracted_idea field round-trips',
  );
  assert.deepEqual(
    got.extracted_idea!.supporting_points,
    ['point one', 'point two'],
    'extracted_idea array round-trips',
  );

  // critique stays a verbatim string (NOT double-serialized)
  assert.equal(typeof got.critique, 'string', 'critique stays a string');
  assert.equal(got.critique, critique, 'critique round-trips verbatim');
  assert.equal(
    (JSON.parse(got.critique!) as { overall: number }).overall,
    4,
    'critique is valid parseable JSON',
  );

  // omitted optional reads back as absent, not null/"null"
  assert.equal(got.cms_url, undefined, 'omitted cms_url is absent (idempotency guard intact)');
  assert.equal(got.reviewer_note, undefined, 'omitted reviewer_note is absent');
  assert.equal(got.eval_scores, undefined, 'omitted eval_scores is absent');

  assert.ok(got.created_at, 'created_at stamped');
  assert.ok(got.updated_at, 'updated_at stamped');

  // ---- update (pending -> approved, set cms_url) ----
  const before = got.updated_at;
  // tiny gap so the ISO timestamp can differ
  await new Promise((r) => setTimeout(r, 5));

  const updated = updateDraft(id, {
    status: 'approved',
    cms_url: 'https://blog.terret.ai/example-post',
  });

  assert.equal(updated.status, 'approved', 'status updated');
  assert.equal(updated.cms_url, 'https://blog.terret.ai/example-post', 'cms_url set');
  assert.equal(updated.revision_count, 0, 'untouched field preserved on partial update');
  assert.equal(
    updated.extracted_idea!.core_thesis,
    'Pipeline reviews fail because reps optimize for activity, not outcomes.',
    'untouched JSON column preserved on partial update',
  );
  assert.ok(updated.updated_at >= before, 'updated_at advanced');

  // ---- missing-id update throws ----
  assert.throws(() => updateDraft('does-not-exist', { status: 'rejected' }), /no draft with id/);

  // ---- missing-id get returns undefined ----
  assert.equal(getDraft('does-not-exist'), undefined, 'getDraft on missing id is undefined');

  console.log('PASS: insertDraft / getDraft / updateDraft round-trip verified (in-memory).');
}

main().catch((err) => {
  console.error('FAIL:', err);
  process.exit(1);
});

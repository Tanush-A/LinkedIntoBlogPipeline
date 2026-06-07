// scripts/verify-live.ts
// Live verification of SOURCE_MODE=live ingestion against a FRESH DB. Frugal by design
// (bounded posts + 1 draft) to protect finite trial credits. Cleans up its demo DB on exit.
//
// Proves: real LinkdAPI fetch → map → triage prefilter (+ text backfill) → judge → pipeline
// fires; re-poll ingests only NEW posts (dedup includes drafted ∪ discarded).
//
// Run: tsx scripts/verify-live.ts

import 'dotenv/config';
import { existsSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const DEMO_DB = resolve(__dirname, '../db/demo-live.sqlite');
for (const f of [DEMO_DB, `${DEMO_DB}-shm`, `${DEMO_DB}-wal`]) if (existsSync(f)) rmSync(f);

process.env.DATABASE_URL = DEMO_DB;
process.env.SOURCE_MODE = 'live';
process.env.PROFILE_ID ??= 'justinshriber';
process.env.MAX_POSTS_PER_CYCLE ??= '6'; // bound API/backfill calls + Slack burst
process.env.MAX_DRAFTS_PER_CYCLE ??= '1'; // generate ONE essay to prove the pipeline fires
process.env.BACKFILL_POST_TEXT ??= 'true';

async function main() {
  const { runCycle } = await import('../src/pipeline/cycle');
  const { ingestPartitions } = await import('../src/pipeline/ingest');
  const { getDiscardedPostIds, getActivePosts } = await import('../src/db');

  console.log('\n[verify-live] === POLL 1 (full cycle: fetch → triage → judge → generate) ===');
  const r1 = await runCycle();
  console.log('[verify-live] cycle 1:', JSON.stringify(r1));
  const discarded1 = getDiscardedPostIds().size;
  const active1 = getActivePosts().length;
  console.log(`[verify-live] after poll 1 → active=${active1} discarded=${discarded1} drafted=${r1.generated}`);

  const fail = (m: string) => { console.log(`  ✗ FAIL ${m}`); process.exitCode = 1; };
  const ok = (c: boolean, m: string) => (c ? console.log(`  ✓ ${m}`) : fail(m));

  console.log('\n[verify-live] assertions:');
  ok(r1.error === null, 'cycle completed without error');
  ok(r1.found > 0, `fetched real posts from LinkdAPI (found=${r1.found})`);
  ok(r1.generated >= 1, `pipeline + judge fired (generated=${r1.generated})`);
  ok(r1.skipped > 0 || discarded1 > 0, `triage discarded non-text/thin posts (skipped=${r1.skipped})`);

  // Re-poll (ingest only, no generation) — only NEW posts should remain.
  console.log('\n[verify-live] === POLL 2 (ingest only) — dedup check ===');
  const r2 = await ingestPartitions();
  console.log(`[verify-live] poll 2 → found=${r2.found} new=${r2.newCount} partitions=${r2.partitions.length}`);
  // Everything handled in poll 1 (1 drafted + N discarded) must NOT count as new again.
  ok(r2.newCount < r1.newCount, `re-poll ingests fewer new posts (was ${r1.newCount}, now ${r2.newCount} — dedup includes drafted+discarded)`);

  console.log(`\n[verify-live] ${process.exitCode ? 'FAILED' : 'PASSED'}\n`);
}

main()
  .catch((err: unknown) => {
    console.error('[verify-live] error:', err instanceof Error ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(() => {
    for (const f of [DEMO_DB, `${DEMO_DB}-shm`, `${DEMO_DB}-wal`]) if (existsSync(f)) rmSync(f);
  });

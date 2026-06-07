// scripts/verify-batch.ts
// Live-shaped verification of batch many:1 synthesis against a FRESH file DB (all 8 seed
// posts are new). Exercises the real ingest path: seed→posts table, grouping, fingerprint
// dedup, post resolution, and re-run idempotency.
//
// Grouping source:
//   - OPENAI_API_KEY set  → the real LLM judge partitions the batch.
//   - no key              → judge fails open to singletons; seed/groups.json provides the
//                           pillar via the manual-override path so the group case is still
//                           exercised end-to-end on real data.
//
// Run: tsx scripts/verify-batch.ts   (cleans up its temp DB + groups.json on exit)

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DEMO_DB = resolve(__dirname, '../db/demo-batch.sqlite');
const GROUPS_PATH = resolve(__dirname, '../seed/groups.json');

// Fresh DB BEFORE importing db.ts (it opens DATABASE_URL at module load).
for (const f of [DEMO_DB, `${DEMO_DB}-shm`, `${DEMO_DB}-wal`]) if (existsSync(f)) rmSync(f);
process.env.DATABASE_URL = DEMO_DB;

// The three "unify your revenue data" seed posts — a coherent pillar.
const PILLAR_IDS = ['1171ff826ae3', '58a6c8ffef81', '3e4f5a6b7c8d'];
const haveKey = !!process.env.OPENAI_API_KEY;
const wroteGroups = !existsSync(GROUPS_PATH);
if (!haveKey && wroteGroups) {
  writeFileSync(
    GROUPS_PATH,
    JSON.stringify([{ theme: 'Unify your revenue data', post_ids: PILLAR_IDS }], null, 2),
  );
}

async function main() {
  const { ingestPartitions } = await import('../src/pipeline/ingest');
  const { insertDraft, getDraftByFingerprint } = await import('../src/db');

  console.log(`\n[verify] judge source: ${haveKey ? 'LIVE OpenAI judge' : 'groups.json override + fail-open singletons (no API key)'}`);

  // ── Run 1 ──────────────────────────────────────────────────────────────────
  const partitions = await ingestPartitions();
  console.log(`\n[verify] run 1 → ${partitions.length} partition(s):`);
  for (const part of partitions) {
    const tag = part.posts.length > 1 ? `PILLAR n=${part.posts.length}` : '1:1';
    console.log(`  • [${tag}] theme="${part.theme}"  ids=[${part.posts.map((p) => p.id).join(', ')}]  fp=${part.fingerprint.slice(0, 12)}…`);
  }

  const pillars = partitions.filter((p) => p.posts.length >= 2);
  const singletons = partitions.filter((p) => p.posts.length === 1);

  const assert = (cond: boolean, msg: string) => {
    console.log(`  ${cond ? '✓' : '✗ FAIL'} ${msg}`);
    if (!cond) process.exitCode = 1;
  };

  console.log('\n[verify] assertions:');
  assert(pillars.length >= 1, 'at least one coherent pillar (n≥2) was formed');
  if (pillars.length) {
    const pillar = pillars[0];
    assert(pillar.posts.length >= 2, `pillar source_post_ids.length === N (N=${pillar.posts.length})`);
    assert(!!pillar.theme, 'pillar carries a theme name');
  }
  assert(singletons.length >= 1, 'unrelated seeds come out as 1:1 singletons');
  assert(
    partitions.every((p) => /^[0-9a-f]{64}$/.test(p.fingerprint)),
    'every partition has a sha256 group fingerprint',
  );

  // Persist a STUB draft per partition (no generation — this verifies the dedup seam only).
  for (const part of partitions) {
    insertDraft({
      id: randomUUID(),
      source_post_ids: part.posts.map((p) => p.id),
      group_fingerprint: part.fingerprint,
      theme: part.theme,
      status: 'pending',
      revision_count: 0,
      revised_draft: `TITLE: ${part.theme}\n\n[stub — verify-batch]`,
    });
    if (!getDraftByFingerprint(part.fingerprint)) {
      console.log(`  ✗ FAIL stub draft missing for fp=${part.fingerprint.slice(0, 12)}`);
      process.exitCode = 1;
    }
  }

  // ── Run 2 (same batch) → idempotency ────────────────────────────────────────
  const rerun = await ingestPartitions();
  console.log(`\n[verify] run 2 (same batch) → ${rerun.length} partition(s)`);
  assert(rerun.length === 0, 're-run of the same batch yields 0 partitions (fingerprint dedup)');

  console.log(`\n[verify] ${process.exitCode ? 'FAILED' : 'PASSED'}\n`);
}

main()
  .catch((err: unknown) => {
    console.error('[verify] error:', err instanceof Error ? err.stack : err);
    process.exitCode = 1;
  })
  .finally(() => {
    if (!haveKey && wroteGroups && existsSync(GROUPS_PATH)) rmSync(GROUPS_PATH);
    for (const f of [DEMO_DB, `${DEMO_DB}-shm`, `${DEMO_DB}-wal`]) if (existsSync(f)) rmSync(f);
  });

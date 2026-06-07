// src/ingest/watch.ts
// Live ingestion driver.
//   npm run poll   → one cycle, then exit (demo-friendly)
//   npm run watch  → poll every POLL_INTERVAL_MINUTES (default 60; trial credits are finite)
//
// The watcher's purpose is live polling, so SOURCE_MODE defaults to 'live' here (an explicit
// SOURCE_MODE=seed still wins). A cycle never crashes the loop — runCycle catches its own
// errors. A reentrancy guard prevents a slow cycle from overlapping the next interval tick.

import 'dotenv/config';
import { runCycle } from '../pipeline/cycle';

process.env.SOURCE_MODE ??= 'live';
// Safe-by-default bounds for the live watcher: a cold first poll against a full feed would
// otherwise backfill + judge + generate the entire history at once (finite trial credits,
// a burst of Slack pings). These apply only to the watcher entry point — `npm run pipeline`
// (seed, 8 posts) stays unbounded. Set MAX_*_PER_CYCLE=0 explicitly to disable.
process.env.MAX_POSTS_PER_CYCLE ??= '20';
process.env.MAX_DRAFTS_PER_CYCLE ??= '5';

const ONCE = process.argv.includes('--once');
const INTERVAL_MIN = parseInt(process.env.POLL_INTERVAL_MINUTES ?? '60', 10);

async function main(): Promise<void> {
  console.log(`[watch] source=${process.env.SOURCE_MODE} mode=${ONCE ? 'once' : `every ${INTERVAL_MIN}m`}`);
  console.log(
    `[watch] bounds: process ≤${process.env.MAX_POSTS_PER_CYCLE} posts, generate ≤${process.env.MAX_DRAFTS_PER_CYCLE} drafts/cycle ` +
    `(set MAX_POSTS_PER_CYCLE=0 / MAX_DRAFTS_PER_CYCLE=0 to disable)`,
  );

  // Always run an immediate first cycle.
  await runCycle();
  if (ONCE) return;

  let running = false;
  setInterval(() => {
    if (running) {
      console.log('[watch] previous cycle still running — skipping this tick');
      return;
    }
    running = true;
    runCycle()
      .catch((err: unknown) => console.error('[watch] unexpected:', err instanceof Error ? err.message : err))
      .finally(() => {
        running = false;
      });
  }, INTERVAL_MIN * 60_000);
}

main().catch((err: unknown) => {
  console.error('[watch] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});

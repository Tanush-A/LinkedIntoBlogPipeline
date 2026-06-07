// src/run.ts
// Run A: one-shot pipeline entry point (`npm run pipeline`).
// Ingest → partition (judge) → generate ONE draft per partition → notify → exit.
// Defaults to SOURCE_MODE=seed. Run B (src/server/approval.ts) handles approvals.

import 'dotenv/config';
import { runCycle } from './pipeline/cycle';

runCycle()
  .then((r) => {
    if (r.error) process.exit(1);
    const baseUrl = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
    if (r.generated > 0) console.log(`[run] Review drafts at: ${baseUrl}/review/<draftId>`);
    console.log('[run] Done. Exiting Run A.');
  })
  .catch((err: unknown) => {
    console.error('[run] Fatal error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });

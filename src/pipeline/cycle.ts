// src/pipeline/cycle.ts
// One ingestion→generation cycle, shared by `npm run pipeline` (one-shot) and the watcher.
// Self-contained and resilient: ingest/judge failures are caught and recorded (never crash
// the watcher), and each partition generates under its own try/catch so one bad draft does
// not lose the rest of the batch. The result is persisted to meta for GET /status.

import { randomUUID } from 'node:crypto';
import { ingestPartitions } from './ingest';
import { generate } from './generate';
import { notify, notifySkipped } from './notify';
import { insertDraft, getPublishedRefs, setMeta } from '../db';

export interface CycleResult {
  at: string;
  found: number;
  newCount: number;
  partitions: number;
  generated: number;
  skipped: number;
  error: string | null;
}

export const LAST_POLL_KEY = 'last_poll';

export async function runCycle(): Promise<CycleResult> {
  const at = new Date().toISOString();
  try {
    const { partitions, skipped, found, newCount } = await ingestPartitions();
    const publishedRefs = getPublishedRefs();

    // Generation cap (credit + Slack-burst guard). 0 = unlimited. Uncapped partitions stay
    // active (no draft) and reappear next cycle — intentional; discards are still persisted.
    const cap = parseInt(process.env.MAX_DRAFTS_PER_CYCLE ?? '0', 10);
    const toGenerate = cap > 0 ? partitions.slice(0, cap) : partitions;

    let generated = 0;
    for (const part of toGenerate) {
      try {
        const refs = publishedRefs.filter((r) =>
          r.source_post_ids.some((id) => part.posts.some((p) => p.id === id)),
        );
        const result = await generate(part.posts, refs);
        const draft = insertDraft({
          id: randomUUID(),
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
        await notify(draft, part.posts);
        generated++;
        console.log(`[cycle] generated draft=${draft.id} theme="${part.theme}" n=${part.posts.length}`);
      } catch (err) {
        console.error(
          `[cycle] partition "${part.theme}" failed (continuing): ${err instanceof Error ? err.message : err}`,
        );
      }
    }

    await notifySkipped(skipped);

    const result: CycleResult = {
      at,
      found,
      newCount,
      partitions: partitions.length,
      generated,
      skipped: skipped.length,
      error: null,
    };
    setMeta(LAST_POLL_KEY, JSON.stringify(result));
    console.log(
      `[poll] found ${found}, new ${newCount}, generated ${generated}, skipped ${skipped.length}`,
    );
    return result;
  } catch (err) {
    // API error / quota exhausted / judge down → log, record, skip cycle. Never crash.
    const msg = err instanceof Error ? err.message : String(err);
    const result: CycleResult = {
      at,
      found: 0,
      newCount: 0,
      partitions: 0,
      generated: 0,
      skipped: 0,
      error: msg,
    };
    setMeta(LAST_POLL_KEY, JSON.stringify(result));
    console.error(`[poll] cycle failed — skipping: ${msg}`);
    return result;
  }
}

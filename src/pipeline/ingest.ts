// src/pipeline/ingest.ts
// Ingestion returns PARTITIONS ready for generation, plus this-cycle triage telemetry.
//
// SOURCE_MODE:
//   'seed' (default) — read seed/posts.json (deterministic fallback + test fixture).
//   'live'           — fetch from LinkdAPI, deterministic-prefilter, persist active/discarded.
//
// Flow (both modes): populate the posts table → dedup (drafted ∪ discarded) → groups.json
// override → grouping judge (partitions + skip list) → persist judge skips → fingerprint
// dedup → resolve to Post objects. The Post contract is the seam: nothing downstream changes.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Post } from '../types';
import {
  getActivePosts,
  getAllPosts,
  getAllSourcePostIds,
  getDiscardedPostIds,
  getDraftByFingerprint,
  getGroupRecords,
  getPostById,
  discardPost,
  upsertPost,
} from '../db';
import { syncSeedToDb, readSeedPosts } from '../lib/seed';
import { groupFingerprint } from '../lib/fingerprint';
import { firstLine } from '../lib/text';
import { partitionPosts, type ExistingGroupSummary, type SkippedPost } from './group';
import { fetchLivePosts } from '../ingest/linkdapi';

export interface IngestPartition {
  theme: string;
  posts: Post[]; // full Post objects, including rolled-up existing members
  fingerprint: string;
}

export interface IngestResult {
  partitions: IngestPartition[];
  /** Everything triaged out this cycle — prefilter skips AND judge skips. */
  skipped: SkippedPost[];
  /** Posts seen this cycle (seed: seed size; live: listing size). */
  found: number;
  /** Posts new to the pipeline this cycle (not previously drafted or discarded). */
  newCount: number;
}

interface ManualGroup {
  theme: string;
  post_ids: string[];
}

function readManualGroups(): ManualGroup[] {
  const groupsPath = resolve(__dirname, '../..', 'seed', 'groups.json');
  if (!existsSync(groupsPath)) return [];
  try {
    return JSON.parse(readFileSync(groupsPath, 'utf-8')) as ManualGroup[];
  } catch (err) {
    console.warn(`[ingest] groups.json unparseable — ignoring: ${err instanceof Error ? err.message : err}`);
    return [];
  }
}

export async function ingestPartitions(): Promise<IngestResult> {
  const mode = (process.env.SOURCE_MODE ?? 'seed').toLowerCase();
  const cycleSkips: SkippedPost[] = [];

  // groups.json forces specific posts through, bypassing prefilter + judge triage (recovery path).
  const manual = readManualGroups();
  const forcedIds = new Set(manual.flatMap((g) => g.post_ids ?? []));

  // Posts already handled (drafted ∪ discarded) — never re-ingested or re-judged.
  const known = new Set<string>([...getAllSourcePostIds(), ...getDiscardedPostIds()]);

  let found = 0;
  let newCount = 0;

  if (mode === 'live') {
    const minChars = parseInt(process.env.MIN_POST_CHARS ?? '400', 10);
    const maxPosts = parseInt(process.env.MAX_POSTS_PER_CYCLE ?? '0', 10);
    const backfill = process.env.BACKFILL_POST_TEXT !== 'false';

    const results = await fetchLivePosts({ knownIds: known, forcedIds, minChars, maxPosts, backfill });
    found = results.length;

    for (const { post, reason, deferred } of results) {
      if (known.has(post.id)) continue; // already drafted or discarded — skip
      newCount++;
      if (deferred) {
        // Text not yet recovered (rate-limited/error/cap). Do NOT persist and do NOT
        // classify as too-short — leave it unknown so it is re-fetched next cycle.
        console.log(`[ingest] defer post=${post.id} — text not yet recovered, retrying next cycle`);
        continue;
      }
      if (reason) {
        discardPost(post, reason);
        cycleSkips.push({ post_id: post.id, reason });
        console.log(`[ingest] prefilter skip post=${post.id} reason="${reason}"`);
      } else {
        upsertPost(post); // active
      }
    }
  } else {
    // seed mode — the seed file feeds the posts table.
    syncSeedToDb();
    const seed = readSeedPosts();
    found = seed.length;
    newCount = seed.filter((p) => !known.has(p.id)).length;
  }

  // Candidate pool = active posts not already handled.
  const byId = new Map(getAllPosts().map((p) => [p.id, p]));
  const newPosts = getActivePosts().filter((p) => !known.has(p.id));
  if (newPosts.length === 0 && forcedIds.size === 0) {
    return { partitions: [], skipped: cycleSkips, found, newCount };
  }

  // ── Manual override partitions (forced; judge never sees these posts) ──
  const overridePartitions: { theme: string; post_ids: string[] }[] = [];
  const overridden = new Set<string>();
  for (const entry of manual) {
    const ids = entry.post_ids ?? [];
    if (ids.length === 0 || !ids.every((id) => byId.has(id))) {
      console.warn(`[ingest] groups.json entry "${entry.theme}" has missing post ids — skipping`);
      continue;
    }
    overridePartitions.push({ theme: entry.theme, post_ids: ids });
    for (const id of ids) overridden.add(id);
  }

  // ── Grouping judge (partitions + skip list) on the remaining new posts ──
  const remaining = newPosts.filter((p) => !overridden.has(p.id));
  const existingGroups = buildExistingGroupSummaries();
  const judged = remaining.length
    ? await partitionPosts(remaining, existingGroups)
    : { partitions: [], skipped: [] };

  // Persist judge skips (forced posts were removed from judge input, but guard anyway).
  for (const s of judged.skipped) {
    if (forcedIds.has(s.post_id)) continue;
    const post = getPostById(s.post_id);
    if (post) discardPost(post, s.reason);
    cycleSkips.push(s);
    console.log(`[ingest] judge skip post=${s.post_id} reason="${s.reason}"`);
  }

  const allPartitions = [
    ...overridePartitions.map((o) => ({ theme: o.theme, post_ids: o.post_ids })),
    ...judged.partitions.map((j) => ({ theme: j.theme, post_ids: j.post_ids })),
  ];

  // ── Fingerprint dedup + resolve to Post objects ──
  const out: IngestPartition[] = [];
  for (const part of allPartitions) {
    const fingerprint = groupFingerprint(part.post_ids);
    if (getDraftByFingerprint(fingerprint)) {
      console.log(`[ingest] skip theme="${part.theme}" — fingerprint already has a draft`);
      continue; // idempotency: re-running the same batch is a no-op
    }
    const posts: Post[] = [];
    let missing = false;
    for (const id of part.post_ids) {
      const post = byId.get(id) ?? getPostById(id);
      if (!post) {
        console.error(`[ingest] post ${id} missing — skipping partition "${part.theme}"`);
        missing = true;
        break;
      }
      posts.push(post);
    }
    if (missing) continue;
    out.push({ theme: part.theme, posts, fingerprint });
  }

  return { partitions: out, skipped: cycleSkips, found, newCount };
}

/**
 * EXISTING THEMES context for the judge: one entry per distinct group (any status), with
 * member summaries (first line of each member post) read from the posts table.
 */
function buildExistingGroupSummaries(): ExistingGroupSummary[] {
  return getGroupRecords().map((g) => ({
    theme: g.theme ?? '(untitled)',
    member_post_ids: g.source_post_ids,
    member_summaries: g.source_post_ids.map((id) => firstLine(getPostById(id)?.text ?? '', 80)),
  }));
}

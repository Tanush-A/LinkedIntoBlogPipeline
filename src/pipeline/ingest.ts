// src/pipeline/ingest.ts
// Ingestion now returns PARTITIONS ready for generation, not raw posts.
// Flow: sync seed → posts table → dedup known post ids → manual groups.json override →
// LLM judge → group-fingerprint dedup → resolve ids to Post objects.
// 1:1 generation is the n=1 case: a singleton partition is one post, exactly as before.

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Post } from '../types';
import {
  getAllPosts,
  getAllSourcePostIds,
  getDraftByFingerprint,
  getGroupRecords,
  getPostById,
} from '../db';
import { syncSeedToDb } from '../lib/seed';
import { groupFingerprint } from '../lib/fingerprint';
import { firstLine } from '../lib/text';
import { partitionPosts, type ExistingGroupSummary } from './group';

export interface IngestPartition {
  theme: string;
  posts: Post[]; // full Post objects, including rolled-up existing members
  fingerprint: string;
}

interface ManualGroup {
  theme: string;
  post_ids: string[];
}

export async function ingestPartitions(): Promise<IngestPartition[]> {
  // Seed feeds the posts table. After this the DB is the only post source.
  syncSeedToDb();

  const byId = new Map(getAllPosts().map((p) => [p.id, p]));
  const known = getAllSourcePostIds();
  const newPosts = [...byId.values()].filter((p) => !known.has(p.id));
  if (newPosts.length === 0) return [];

  // ── Manual override (seed/groups.json) — forced partitions, judge never sees these posts ──
  const overridePartitions: { theme: string; post_ids: string[] }[] = [];
  const overridden = new Set<string>();
  const groupsPath = resolve(__dirname, '../..', 'seed', 'groups.json');
  if (existsSync(groupsPath)) {
    let manual: ManualGroup[] = [];
    try {
      manual = JSON.parse(readFileSync(groupsPath, 'utf-8')) as ManualGroup[];
    } catch (err) {
      console.warn(`[ingest] groups.json unparseable — ignoring: ${err instanceof Error ? err.message : err}`);
    }
    for (const entry of manual) {
      const ids = entry.post_ids ?? [];
      const allPresent = ids.length > 0 && ids.every((id) => byId.has(id));
      if (!allPresent) {
        console.warn(`[ingest] groups.json entry "${entry.theme}" has unknown post ids — skipping`);
        continue;
      }
      overridePartitions.push({ theme: entry.theme, post_ids: ids });
      for (const id of ids) overridden.add(id);
    }
  }

  // ── Judge the remaining new posts ──
  const remaining = newPosts.filter((p) => !overridden.has(p.id));
  const existingGroups = buildExistingGroupSummaries();
  const judged = remaining.length ? await partitionPosts(remaining, existingGroups) : [];

  const allPartitions = [
    ...overridePartitions.map((o) => ({ theme: o.theme, post_ids: o.post_ids })),
    ...judged.map((j) => ({ theme: j.theme, post_ids: j.post_ids })),
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
      const post = byId.get(id);
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

  return out;
}

/**
 * Build EXISTING THEMES context for the judge: one entry per distinct group (any status),
 * with member summaries (first line of each member post) read from the posts table.
 */
function buildExistingGroupSummaries(): ExistingGroupSummary[] {
  return getGroupRecords().map((g) => ({
    theme: g.theme ?? '(untitled)',
    member_post_ids: g.source_post_ids,
    member_summaries: g.source_post_ids.map((id) => firstLine(getPostById(id)?.text ?? '', 80)),
  }));
}

// src/pipeline/group.ts
// One grouping-judge call + deterministic validation. The judge is untrusted input:
// every partition is re-checked against the known id sets, and ANY failure fails open
// to singletons. Generation must never be blocked by grouping.

import OpenAI from 'openai';
import type { Post, GroupPartition } from '../types';
import { buildGroupingMessages, type ExistingGroupSummary } from '../../prompts/group';
import { firstLine } from '../lib/text';

export type { ExistingGroupSummary };

/** A post the judge triaged out as having no extractable argument. */
export interface SkippedPost {
  post_id: string;
  reason: string;
}

export interface PartitionResult {
  partitions: GroupPartition[];
  /** Posts the judge deemed too thin/promotional to inspire a blog post. */
  skipped: SkippedPost[];
}

interface JudgePartition {
  theme?: unknown;
  post_ids?: unknown;
  confidence?: unknown;
}

/**
 * Partition a batch of new posts into theme groups + singletons, plus a judge skip list.
 * Every NEW post id ends up in exactly one partition OR the skip list. Fail-open: any judge
 * failure returns all-singletons and an EMPTY skip list (discards nothing).
 */
export async function partitionPosts(
  newPosts: Post[],
  existingGroups: ExistingGroupSummary[],
): Promise<PartitionResult> {
  if (newPosts.length === 0) return { partitions: [], skipped: [] };

  const MODEL = process.env.OPENAI_MODEL ?? 'gpt-5.5';
  const FLOOR = parseFloat(process.env.GROUP_CONFIDENCE_MIN ?? '0.6');

  const newIds = new Set(newPosts.map((p) => p.id));
  const memberIds = new Set(existingGroups.flatMap((g) => g.member_post_ids));
  const knownIds = new Set([...newIds, ...memberIds]);
  const byId = new Map(newPosts.map((p) => [p.id, p]));

  // A singleton for one new post: theme = its first line, confidence 1.0.
  const singleton = (id: string): GroupPartition => ({
    theme: firstLine(byId.get(id)?.text ?? '', 60) || '(untitled)',
    post_ids: [id],
    confidence: 1,
  });

  let parsed: JudgePartition[];
  let parsedSkips: { post_id?: unknown; reason?: unknown }[];
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const resp = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: 'json_object' },
      messages: buildGroupingMessages(newPosts, existingGroups),
    });
    const content = resp.choices[0].message.content;
    if (!content) throw new Error('judge returned null content');
    const obj = JSON.parse(content) as { partitions?: unknown; skipped?: unknown };
    if (!Array.isArray(obj.partitions)) throw new Error('judge JSON missing partitions array');
    parsed = obj.partitions as JudgePartition[];
    parsedSkips = Array.isArray(obj.skipped)
      ? (obj.skipped as { post_id?: unknown; reason?: unknown }[])
      : [];
  } catch (err) {
    console.warn(
      `[group] judge failed — falling back to singletons: ${err instanceof Error ? err.message : String(err)}`,
    );
    // Fail-open: discard nothing.
    return { partitions: newPosts.map((p) => singleton(p.id)), skipped: [] };
  }

  // Validate the skip list FIRST: a skip only claims a NEW id (never an existing member or
  // unknown). A partition wins over a skip on contradiction (handled below — partitions run
  // after and only the still-uncovered new ids fall through to the singleton sweep).
  const skipped: SkippedPost[] = [];
  const skippedIds = new Set<string>();
  for (const s of parsedSkips) {
    const id = typeof s.post_id === 'string' ? s.post_id : '';
    if (!newIds.has(id) || skippedIds.has(id)) continue;
    skippedIds.add(id);
    skipped.push({ post_id: id, reason: typeof s.reason === 'string' && s.reason.trim() ? s.reason.trim() : 'no extractable argument' });
  }

  const accepted: GroupPartition[] = [];
  const seenIds = new Set<string>(); // global: an id may appear in at most one accepted partition
  const coveredNew = new Set<string>();

  for (const part of parsed) {
    const ids = part.post_ids;
    if (!Array.isArray(ids) || ids.length === 0) continue;

    // Validate: ids must be known, unique within this partition, and not already claimed.
    const local = new Set<string>();
    let valid = true;
    for (const raw of ids) {
      const id = typeof raw === 'string' ? raw : '';
      if (!knownIds.has(id) || local.has(id) || seenIds.has(id)) {
        valid = false;
        break;
      }
      local.add(id);
    }
    const hasNew = [...local].some((id) => newIds.has(id));
    // Drop: unknown/duplicate id, or a partition with ONLY existing-member ids.
    if (!valid || !hasNew) continue;

    const confidence = typeof part.confidence === 'number' ? part.confidence : 1;

    // Confidence floor: a low-confidence GROUP is split into singletons. Re-covering its
    // NEW ids only happens via the final sweep below (existing members simply drop out) —
    // do not mint singleton drafts for posts that existed only inside a prior group.
    if (local.size >= 2 && confidence < FLOOR) continue;

    const theme = typeof part.theme === 'string' && part.theme.trim() ? part.theme.trim() : '(untitled)';
    accepted.push({ theme, post_ids: [...local], confidence });
    for (const id of local) {
      seenIds.add(id);
      if (newIds.has(id)) {
        coveredNew.add(id);
        skippedIds.delete(id); // partition wins over a contradictory skip
      }
    }
  }

  // Resolve contradictions: drop any skip whose id ended up in a partition.
  const finalSkipped = skipped.filter((s) => skippedIds.has(s.post_id));

  // Any new id neither covered by a partition NOR skipped (omitted, dropped, or floor-split)
  // becomes a singleton — every new post ends up in exactly one partition OR the skip list.
  for (const p of newPosts) {
    if (!coveredNew.has(p.id) && !skippedIds.has(p.id)) accepted.push(singleton(p.id));
  }

  for (const part of accepted) {
    console.log(
      `[group] theme="${part.theme}" n=${part.post_ids.length} confidence=${part.confidence}`,
    );
  }
  for (const s of finalSkipped) {
    console.log(`[group] skip post=${s.post_id} reason="${s.reason}"`);
  }

  return { partitions: accepted, skipped: finalSkipped };
}

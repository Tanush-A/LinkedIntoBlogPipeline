// src/pipeline/group.ts
// One grouping-judge call + deterministic validation. The judge is untrusted input:
// every partition is re-checked against the known id sets, and ANY failure fails open
// to singletons. Generation must never be blocked by grouping.

import OpenAI from 'openai';
import type { Post, GroupPartition } from '../types';
import { buildGroupingMessages, type ExistingGroupSummary } from '../../prompts/group';
import { firstLine } from '../lib/text';

export type { ExistingGroupSummary };

interface JudgePartition {
  theme?: unknown;
  post_ids?: unknown;
  confidence?: unknown;
}

/** Partition a batch of new posts into theme groups + singletons. Fail-open to singletons. */
export async function partitionPosts(
  newPosts: Post[],
  existingGroups: ExistingGroupSummary[],
): Promise<GroupPartition[]> {
  if (newPosts.length === 0) return [];

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
  try {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const resp = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: 'json_object' },
      messages: buildGroupingMessages(newPosts, existingGroups),
    });
    const content = resp.choices[0].message.content;
    if (!content) throw new Error('judge returned null content');
    const obj = JSON.parse(content) as { partitions?: unknown };
    if (!Array.isArray(obj.partitions)) throw new Error('judge JSON missing partitions array');
    parsed = obj.partitions as JudgePartition[];
  } catch (err) {
    console.warn(
      `[group] judge failed — falling back to singletons: ${err instanceof Error ? err.message : String(err)}`,
    );
    return newPosts.map((p) => singleton(p.id));
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
      if (newIds.has(id)) coveredNew.add(id);
    }
  }

  // Any new id not covered by an accepted partition (omitted, dropped, or floor-split)
  // becomes a singleton — every new post is guaranteed exactly one partition.
  for (const p of newPosts) {
    if (!coveredNew.has(p.id)) accepted.push(singleton(p.id));
  }

  for (const part of accepted) {
    console.log(
      `[group] theme="${part.theme}" n=${part.post_ids.length} confidence=${part.confidence}`,
    );
  }

  return accepted;
}

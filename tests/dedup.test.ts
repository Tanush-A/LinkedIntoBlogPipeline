// tests/dedup.test.ts
// Ingestion / dedup — verifies ingestPartitions() dedups by group_fingerprint.
// The grouping judge is exercised in tests/synthesis.test.ts. Here the OpenAI mock has
// no chat surface, so the judge fails open to singletons — the n=1 (1:1) path, unchanged.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// openai is imported transitively via group/regenerate; the bare mock means the judge
// call throws and partitionPosts fails open to one singleton per new post.
vi.mock('openai', () => ({ default: vi.fn() }));

import { insertDraft, _resetDbForTesting } from '../src/db';
import { ingestPartitions } from '../src/pipeline/ingest';
import { makeDraft } from './helpers/fixtures';

const TOTAL_SEED_POSTS = 8; // seed/posts.json has 8 posts

beforeEach(() => {
  _resetDbForTesting();
});

describe('ingest dedup (partitions)', () => {
  it('empty DB → ingestPartitions returns one singleton partition per seed post', async () => {
    const partitions = await ingestPartitions();
    expect(partitions).toHaveLength(TOTAL_SEED_POSTS);
    for (const part of partitions) {
      // Judge failed open → every partition is n=1 (the 1:1 case).
      expect(part.posts).toHaveLength(1);
      expect(part.posts[0].id).toBeTruthy();
      expect(part.posts[0].text).toBeTruthy();
      expect(part.fingerprint).toMatch(/^[0-9a-f]{64}$/);
      expect(part.theme).toBeTruthy();
    }
  });

  it('processing a partition (its fingerprint gets a draft) excludes it on the next run', async () => {
    const first = await ingestPartitions();
    const firstPart = first[0]!;

    // Simulate the pipeline having generated + persisted a draft for this partition.
    insertDraft(
      makeDraft({
        source_post_ids: firstPart.posts.map((p) => p.id),
        group_fingerprint: firstPart.fingerprint,
      }),
    );

    const second = await ingestPartitions();
    expect(second).toHaveLength(first.length - 1);
    expect(second.find((p) => p.fingerprint === firstPart.fingerprint)).toBeUndefined();
  });

  it('all partitions processed → ingestPartitions returns empty array', async () => {
    const partitions = await ingestPartitions();
    for (const part of partitions) {
      insertDraft(
        makeDraft({
          source_post_ids: part.posts.map((p) => p.id),
          group_fingerprint: part.fingerprint,
        }),
      );
    }
    expect(await ingestPartitions()).toHaveLength(0);
  });

  it('a singleton partition carries exactly one full Post object (1:1 unchanged)', async () => {
    const partitions = await ingestPartitions();
    const part = partitions[0]!;
    expect(part.posts).toHaveLength(1);
    expect(typeof part.posts[0].id).toBe('string');
    expect(typeof part.posts[0].author).toBe('string');
    expect(typeof part.posts[0].url).toBe('string');
    expect(typeof part.posts[0].text).toBe('string');
  });

  it('draft created for a partition starts pending with its source ids + fingerprint', async () => {
    const partitions = await ingestPartitions();
    const part = partitions[0]!;
    const draft = insertDraft(
      makeDraft({
        source_post_ids: part.posts.map((p) => p.id),
        group_fingerprint: part.fingerprint,
      }),
    );
    expect(draft.status).toBe('pending');
    expect(draft.source_post_ids).toEqual(part.posts.map((p) => p.id));
    expect(draft.group_fingerprint).toBe(part.fingerprint);
  });
});

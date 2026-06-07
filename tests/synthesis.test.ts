// tests/synthesis.test.ts
// Batch many:1 synthesis. The grouping judge is an LLM edge — mocked here. Covers:
//   - fingerprint order-insensitivity
//   - partitionPosts deterministic validation (missing / dup / unknown / low-confidence)
//   - confidence-floor split re-covers NEW ids only (existing members drop out)
//   - judge throw → fail-open to singletons
//   - ingest: related+unrelated batch → ONE pillar partition + singletons
//   - group-fingerprint dedup (same batch re-run = no dup; roll-up = new fingerprint)
//   - N-post extract receives all source texts
//   - verifyDraft grounding corpus = ALL posts in the group
//   - posts-table round-trip + loadPosts-from-DB

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock('openai', () => ({
  default: class OpenAIMock {
    chat = { completions: { create: mockCreate } };
  },
}));

import type { Post } from '../src/types';
import { groupFingerprint } from '../src/lib/fingerprint';
import { partitionPosts, type ExistingGroupSummary } from '../src/pipeline/group';
import { ingestPartitions } from '../src/pipeline/ingest';
import { generate } from '../src/pipeline/generate';
import {
  insertDraft,
  getDraft,
  _resetDbForTesting,
  upsertPost,
  getPostById,
  getAllPosts,
  loadPosts,
} from '../src/db';
import {
  makeDraft,
  MOCK_EXTRACTED_IDEA,
  MOCK_CRITIQUE,
  MOCK_RAW_DRAFT,
} from './helpers/fixtures';

// Real seed ids (present in the posts table via tests/setup.ts).
const A = '1171ff826ae3';
const B = '58a6c8ffef81';
const X = '3e4f5a6b7c8d';

const judgeResponse = (partitions: unknown) => ({
  choices: [{ message: { content: JSON.stringify({ partitions }) } }],
});

const p = (id: string, text = `text of ${id}`): Post => ({
  id,
  author: 'Justin Shriber',
  url: `https://linkedin.com/${id}`,
  text,
});

beforeEach(() => {
  _resetDbForTesting();
});

afterEach(() => {
  vi.resetAllMocks();
});

// ─── fingerprint ────────────────────────────────────────────────────────────

describe('groupFingerprint', () => {
  it('is order-insensitive: [a,b] === [b,a]', () => {
    expect(groupFingerprint(['a', 'b'])).toBe(groupFingerprint(['b', 'a']));
  });

  it('membership change yields a different fingerprint (roll-up identity)', () => {
    expect(groupFingerprint([A, B])).not.toBe(groupFingerprint([A, B, X]));
  });
});

// ─── partitionPosts validation (judge mocked) ─────────────────────────────────

describe('partitionPosts — deterministic validation', () => {
  it('a coherent group of 2 + a singleton → one n=2 partition + one n=1', async () => {
    mockCreate.mockResolvedValueOnce(
      judgeResponse([
        { theme: 'Fragmented data', post_ids: [A, B], confidence: 0.9 },
        { theme: 'Solo', post_ids: [X], confidence: 1 },
      ]),
    );
    const parts = await partitionPosts([p(A), p(B), p(X)], []);
    expect(parts).toHaveLength(2);
    const group = parts.find((g) => g.post_ids.length === 2)!;
    expect(new Set(group.post_ids)).toEqual(new Set([A, B]));
    expect(parts.find((g) => g.post_ids.length === 1)!.post_ids).toEqual([X]);
  });

  it('a new id the judge omitted is re-covered as a singleton', async () => {
    mockCreate.mockResolvedValueOnce(
      judgeResponse([{ theme: 'Pair', post_ids: [A, B], confidence: 0.9 }]),
    );
    const parts = await partitionPosts([p(A), p(B), p(X)], []);
    // X omitted by the judge → minted as a singleton.
    expect(parts.find((g) => g.post_ids.length === 1)!.post_ids).toEqual([X]);
    expect(parts.flatMap((g) => g.post_ids).sort()).toEqual([A, B, X].sort());
  });

  it('a partition with an unknown id is dropped; its real new ids re-covered as singletons', async () => {
    mockCreate.mockResolvedValueOnce(
      judgeResponse([{ theme: 'Bad', post_ids: [A, 'ghost-id'], confidence: 0.9 }]),
    );
    const parts = await partitionPosts([p(A), p(B)], []);
    // Whole partition dropped → A and B each become singletons.
    expect(parts).toHaveLength(2);
    expect(parts.every((g) => g.post_ids.length === 1)).toBe(true);
    expect(parts.flatMap((g) => g.post_ids).sort()).toEqual([A, B].sort());
  });

  it('a duplicated id across partitions: the second claim is dropped', async () => {
    mockCreate.mockResolvedValueOnce(
      judgeResponse([
        { theme: 'First', post_ids: [A, B], confidence: 0.9 },
        { theme: 'Dup', post_ids: [B, X], confidence: 0.9 }, // B already claimed
      ]),
    );
    const parts = await partitionPosts([p(A), p(B), p(X)], []);
    // [A,B] accepted; [B,X] dropped (B taken) → X re-covered as singleton.
    expect(parts.find((g) => g.post_ids.length === 2)!.post_ids.sort()).toEqual([A, B].sort());
    expect(parts.find((g) => g.post_ids.includes(X))!.post_ids).toEqual([X]);
    expect(parts.flatMap((g) => g.post_ids).sort()).toEqual([A, B, X].sort());
  });

  it('a low-confidence pair is split into singletons', async () => {
    mockCreate.mockResolvedValueOnce(
      judgeResponse([{ theme: 'Weak', post_ids: [A, B], confidence: 0.3 }]),
    );
    const parts = await partitionPosts([p(A), p(B)], []);
    expect(parts).toHaveLength(2);
    expect(parts.every((g) => g.post_ids.length === 1)).toBe(true);
  });

  it('confidence-floor split re-covers NEW ids only — existing members drop out', async () => {
    const existing: ExistingGroupSummary[] = [
      { theme: 'Prior theme', member_post_ids: [A, B], member_summaries: ['a', 'b'] },
    ];
    // Judge attaches new X to the prior [A,B] theme but with low confidence.
    mockCreate.mockResolvedValueOnce(
      judgeResponse([{ theme: 'Shaky roll-up', post_ids: [A, B, X], confidence: 0.2 }]),
    );
    const parts = await partitionPosts([p(X)], existing);
    // Below floor → dropped → only the NEW id X is re-covered as a singleton.
    // A and B (existing members) must NOT become drafts.
    expect(parts).toHaveLength(1);
    expect(parts[0].post_ids).toEqual([X]);
    expect(parts.flatMap((g) => g.post_ids)).not.toContain(A);
    expect(parts.flatMap((g) => g.post_ids)).not.toContain(B);
  });

  it('a partition with ONLY existing-member ids (no new id) is dropped', async () => {
    const existing: ExistingGroupSummary[] = [
      { theme: 'Prior', member_post_ids: [A, B], member_summaries: ['a', 'b'] },
    ];
    mockCreate.mockResolvedValueOnce(
      judgeResponse([
        { theme: 'Stale', post_ids: [A, B], confidence: 0.9 }, // no new id
        { theme: 'New', post_ids: [X], confidence: 1 },
      ]),
    );
    const parts = await partitionPosts([p(X)], existing);
    expect(parts).toHaveLength(1);
    expect(parts[0].post_ids).toEqual([X]);
  });

  it('judge throw → fail-open to one singleton per new post', async () => {
    mockCreate.mockRejectedValueOnce(new Error('judge API down'));
    const parts = await partitionPosts([p(A), p(B), p(X)], []);
    expect(parts).toHaveLength(3);
    expect(parts.every((g) => g.post_ids.length === 1 && g.confidence === 1)).toBe(true);
  });
});

// ─── ingest: related + unrelated batch ────────────────────────────────────────

describe('ingestPartitions — grouping + fingerprint dedup', () => {
  it('related posts group into ONE pillar partition; the rest are singletons', async () => {
    mockCreate.mockResolvedValueOnce(
      judgeResponse([{ theme: 'Unify your revenue data', post_ids: [A, B], confidence: 0.9 }]),
    );
    const parts = await ingestPartitions();
    // 8 seed posts: A+B grouped → 1 pillar + 6 singletons = 7 partitions.
    expect(parts).toHaveLength(7);
    const pillar = parts.find((pt) => pt.posts.length === 2)!;
    expect(pillar).toBeDefined();
    expect(new Set(pillar.posts.map((x) => x.id))).toEqual(new Set([A, B]));
    expect(pillar.fingerprint).toBe(groupFingerprint([A, B]));
    expect(pillar.theme).toBe('Unify your revenue data');
    // The unrelated seeds come out as 1:1.
    expect(parts.filter((pt) => pt.posts.length === 1)).toHaveLength(6);
  });

  it('same batch re-run = no dup (every fingerprint already has a draft)', async () => {
    mockCreate.mockResolvedValueOnce(
      judgeResponse([{ theme: 'Unify', post_ids: [A, B], confidence: 0.9 }]),
    );
    const first = await ingestPartitions();
    for (const part of first) {
      insertDraft(
        makeDraft({
          source_post_ids: part.posts.map((x) => x.id),
          group_fingerprint: part.fingerprint,
          theme: part.theme,
        }),
      );
    }
    // All 8 posts are now known → ingest short-circuits before the judge runs.
    const second = await ingestPartitions();
    expect(second).toHaveLength(0);
  });

  it('a later batch attaching a post to a prior theme = new fingerprint = roll-up partition', async () => {
    // Prior published group [A,B] exists.
    insertDraft(
      makeDraft({
        source_post_ids: [A, B],
        group_fingerprint: groupFingerprint([A, B]),
        theme: 'Unify your revenue data',
      }),
    );
    // A,B are now known; X (+5 others) are new. Judge attaches X to the prior theme.
    mockCreate.mockResolvedValueOnce(
      judgeResponse([{ theme: 'Unify your revenue data (expanded)', post_ids: [A, B, X], confidence: 0.9 }]),
    );
    const parts = await ingestPartitions();

    const rollup = parts.find((pt) => pt.posts.length === 3)!;
    expect(rollup).toBeDefined();
    expect(new Set(rollup.posts.map((x) => x.id))).toEqual(new Set([A, B, X]));
    expect(rollup.fingerprint).toBe(groupFingerprint([A, B, X]));
    // New fingerprint, distinct from the prior [A,B] draft — the old draft is untouched.
    expect(rollup.fingerprint).not.toBe(groupFingerprint([A, B]));
  });
});

// ─── N-post extract + verify corpus (generate, LLM mocked) ────────────────────

function setupGenerateMocks(reviseText: string): void {
  mockCreate
    .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(MOCK_EXTRACTED_IDEA) } }] })
    .mockResolvedValueOnce({ choices: [{ message: { content: MOCK_RAW_DRAFT } }] })
    .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(MOCK_CRITIQUE) } }] })
    .mockResolvedValueOnce({ choices: [{ message: { content: reviseText } }] })
    .mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify(MOCK_CRITIQUE) } }] });
}

describe('generate — N-post synthesis', () => {
  it('the extract pass receives ALL source post texts', async () => {
    setupGenerateMocks('TITLE: T\n\nClean body with no figures.');
    const p1 = p('post-1', 'Dashboards are post-mortems for revenue teams.');
    const p2 = p('post-2', 'A loss analysis surfaced a single missing feature.');
    await generate([p1, p2]);

    // calls[0] is the extract call; its user message must contain both texts.
    const extractMessages = (mockCreate.mock.calls[0][0] as { messages: { content: string }[] }).messages;
    const userContent = extractMessages[extractMessages.length - 1].content;
    expect(userContent).toContain(p1.text);
    expect(userContent).toContain(p2.text);
    expect(userContent).toContain('these 2 LinkedIn posts');
  });

  it('verifyDraft grounding corpus is ALL group posts: a figure from the 2nd post is grounded', async () => {
    // $4M is a source-only figure (not a brand demo figure). It appears ONLY in p2.
    setupGenerateMocks('TITLE: The Leak\n\nThe loss traced back to one $4M gap.');
    const p1 = p('post-1', 'Dashboards never tell you what actually killed the deal.');
    const p2 = p('post-2', 'A customer loss analysis found the exact $4M leak in minutes.');
    const result = await generate([p1, p2]);

    // Corpus includes p2 → $4M is grounded → not flagged → draft passes.
    expect(result.verification.ungroundedNumbers).not.toContain('$4m');
    expect(result.verification.ungroundedNumbers).toHaveLength(0);
    expect(result.verification.passed).toBe(true);
  });
});

// ─── posts table (amendment: canonical post store) ────────────────────────────

describe('posts table', () => {
  it('upsert → getPostById round-trip; upsert updates fields', () => {
    upsertPost(p('round-trip-1', 'first text'));
    expect(getPostById('round-trip-1')!.text).toBe('first text');
    upsertPost(p('round-trip-1', 'updated text'));
    expect(getPostById('round-trip-1')!.text).toBe('updated text');
    expect(getAllPosts().filter((x) => x.id === 'round-trip-1')).toHaveLength(1);
  });

  it('loadPosts resolves ids from the DB and throws on a missing id', () => {
    // Seed posts are present (tests/setup.ts synced them).
    const posts = loadPosts([A, B]);
    expect(posts.map((x) => x.id)).toEqual([A, B]);
    expect(() => loadPosts(['not-a-real-post'])).toThrow('not found in posts table');
  });

  it('a draft round-trips its source_post_ids array and theme', () => {
    const d = insertDraft(
      makeDraft({ source_post_ids: [A, B], group_fingerprint: groupFingerprint([A, B]), theme: 'Pillar theme' }),
    );
    const stored = getDraft(d.id)!;
    expect(stored.source_post_ids).toEqual([A, B]);
    expect(stored.theme).toBe('Pillar theme');
    expect(stored.group_fingerprint).toBe(groupFingerprint([A, B]));
  });
});

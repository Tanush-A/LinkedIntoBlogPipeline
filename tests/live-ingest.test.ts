// tests/live-ingest.test.ts
// Live LinkdAPI ingestion. The HTTP edge (fetch) and the judge (openai) are mocked.
// Covers: mapping, deterministic prefilter, live new→pipeline, seen→skipped (dedup),
// failure→skip cycle, SOURCE_MODE=seed untouched, prefilter persists+dedups,
// judge skip persists+dedups, groups.json force-includes a discarded post, text backfill.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock('openai', () => ({
  default: class OpenAIMock {
    chat = { completions: { create: mockCreate } };
  },
}));

import type { RawLinkdPost } from '../src/ingest/linkdapi';
import { mapRawPost, prefilterReason, activityIdOf } from '../src/ingest/linkdapi';
import { ingestPartitions } from '../src/pipeline/ingest';
import { runCycle } from '../src/pipeline/cycle';
import { postIdFromUrl } from '../src/lib/postId';
import { groupFingerprint } from '../src/lib/fingerprint';
import {
  insertDraft,
  getPostById,
  getDiscardedPostIds,
  getMeta,
  _resetDbForTesting,
  _resetPostsForTesting,
} from '../src/db';
import { makeDraft } from './helpers/fixtures';

const GROUPS_PATH = resolve(__dirname, '..', 'seed', 'groups.json');
const LONG = 'x'.repeat(500); // ≥ MIN_POST_CHARS (400)

function raw(activity: string, text: string, extra: Partial<RawLinkdPost> = {}): RawLinkdPost {
  return {
    text,
    url: `https://www.linkedin.com/feed/update/urn:li:activity:${activity}`,
    urn: `urn:li:activity:${activity}`,
    author: { name: 'Justin Shriber' },
    postedAt: { timestamp: 1780671364602 },
    ...extra,
  };
}
const idOf = (activity: string) => postIdFromUrl(`https://www.linkedin.com/feed/update/urn:li:activity:${activity}`);

const env = (data: unknown) => ({ ok: true, json: async () => ({ success: true, statusCode: 200, errors: null, data }) });

let mockFetch: ReturnType<typeof vi.fn>;
let listing: RawLinkdPost[] = [];
let infoText = '';

const judge = (partitions: unknown, skipped: unknown = []) =>
  mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: JSON.stringify({ partitions, skipped }) } }] });

beforeEach(() => {
  _resetDbForTesting();
  _resetPostsForTesting();
  process.env.SOURCE_MODE = 'live';
  process.env.BACKFILL_POST_TEXT = 'false';
  delete process.env.MAX_POSTS_PER_CYCLE;
  listing = [];
  infoText = '';
  mockFetch = vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('username-to-urn')) return env({ urn: 'ACoA-test-urn', username: 'justinshriber' });
    if (u.includes('/posts/all')) return env({ cursor: 'c', posts: listing });
    if (u.includes('/posts/info')) return env({ post: { text: infoText } });
    if (u.includes('hooks.slack')) return { ok: true };
    return env({});
  });
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetAllMocks();
  delete process.env.SOURCE_MODE;
  delete process.env.BACKFILL_POST_TEXT;
  if (existsSync(GROUPS_PATH)) rmSync(GROUPS_PATH);
});

// ─── mapping + prefilter (pure) ───────────────────────────────────────────────

describe('linkdapi mapping', () => {
  it('maps raw → Post with sha256-of-url id, ms-timestamp posted_at, and author name', () => {
    const r = raw('7468677027236184066', 'hello world');
    const post = mapRawPost(r, r.text!);
    expect(post.id).toBe(postIdFromUrl(r.url));
    expect(post.author).toBe('Justin Shriber');
    expect(post.url).toBe(r.url);
    // 1780671364602 ms → 2026-06-05T... (NOT multiplied by 1000)
    expect(post.posted_at).toBe(new Date(1780671364602).toISOString());
    expect(post.posted_at!.startsWith('2026-')).toBe(true);
  });

  it('activityIdOf extracts the numeric id from the urn', () => {
    expect(activityIdOf(raw('7464687409096511488', 'x'))).toBe('7464687409096511488');
  });
});

describe('deterministic prefilter', () => {
  it('reshare → "reshare"', () => {
    expect(prefilterReason(raw('1', LONG, { resharedPostContent: { text: 'orig' } }), LONG, 400)).toBe('reshare');
  });
  it('header "reposted this" → "reshare"', () => {
    expect(prefilterReason(raw('1', LONG, { header: 'Justin Shriber reposted this' }), LONG, 400)).toBe('reshare');
  });
  it('media + no text → "media-only"', () => {
    expect(prefilterReason(raw('1', '', { mediaContent: [{ type: 'image' }] }), '', 400)).toBe('media-only');
  });
  it('short text, no media → "too-short"', () => {
    expect(prefilterReason(raw('1', 'tiny'), 'tiny', 400)).toBe('too-short');
  });
  it('long original text → null (keep)', () => {
    expect(prefilterReason(raw('1', LONG), LONG, 400)).toBeNull();
  });
});

// ─── live ingest flow ─────────────────────────────────────────────────────────

describe('ingestPartitions (SOURCE_MODE=live)', () => {
  it('a new long post flows to the pipeline; a short post is prefilter-discarded', async () => {
    listing = [raw('100', LONG), raw('200', 'too short to inspire anything')];
    judge([{ theme: 'Keeper', post_ids: [idOf('100')], confidence: 1 }]);

    const { partitions, skipped, found, newCount } = await ingestPartitions();

    expect(found).toBe(2);
    expect(newCount).toBe(2);
    expect(partitions).toHaveLength(1);
    expect(partitions[0].posts[0].id).toBe(idOf('100'));
    // short post discarded by prefilter
    expect(skipped.map((s) => s.post_id)).toContain(idOf('200'));
    expect(skipped.find((s) => s.post_id === idOf('200'))!.reason).toBe('too-short');
    expect(getPostById(idOf('200'))).toBeDefined(); // persisted, just discarded
    expect(getDiscardedPostIds().has(idOf('200'))).toBe(true);
  });

  it('an already-seen post (has a draft) is not re-ingested', async () => {
    const seen = idOf('100');
    insertDraft(makeDraft({ source_post_ids: [seen], group_fingerprint: groupFingerprint([seen]) }));
    listing = [raw('100', LONG)];
    // judge would only ever see new posts; none here → not called, but stub one defensively
    judge([]);

    const { partitions, newCount } = await ingestPartitions();
    expect(newCount).toBe(0);
    expect(partitions).toHaveLength(0);
  });

  it('prefilter-discarded posts are not re-judged on the next cycle (dedup includes discarded)', async () => {
    listing = [raw('200', 'short')];
    judge([]);
    await ingestPartitions(); // discards 200
    expect(getDiscardedPostIds().has(idOf('200'))).toBe(true);

    // Re-run: 200 is known/discarded → excluded; newCount 0, judge gets nothing new.
    const { newCount, partitions } = await ingestPartitions();
    expect(newCount).toBe(0);
    expect(partitions).toHaveLength(0);
  });

  it('a judge skip is persisted as discarded and not re-judged', async () => {
    listing = [raw('100', LONG), raw('300', LONG)];
    // judge keeps 100, skips 300 as promotional
    judge(
      [{ theme: 'Keeper', post_ids: [idOf('100')], confidence: 1 }],
      [{ post_id: idOf('300'), reason: 'event announcement' }],
    );

    const { partitions, skipped } = await ingestPartitions();
    expect(partitions.map((p) => p.posts[0].id)).toEqual([idOf('100')]);
    expect(skipped.find((s) => s.post_id === idOf('300'))!.reason).toBe('event announcement');
    expect(getDiscardedPostIds().has(idOf('300'))).toBe(true);
  });

  it('groups.json force-includes a post that prefilter would discard', async () => {
    const forcedId = idOf('200');
    writeFileSync(GROUPS_PATH, JSON.stringify([{ theme: 'Manual rescue', post_ids: [forcedId] }]));
    listing = [raw('200', 'short — would be too-short')];
    // forced post bypasses the judge; no judge call needed, but stub defensively
    judge([]);

    const { partitions, skipped } = await ingestPartitions();
    expect(partitions.map((p) => p.theme)).toContain('Manual rescue');
    expect(partitions.find((p) => p.theme === 'Manual rescue')!.posts[0].id).toBe(forcedId);
    expect(skipped.map((s) => s.post_id)).not.toContain(forcedId); // not discarded
    expect(getDiscardedPostIds().has(forcedId)).toBe(false);
  });

  it('a rate-limited (429) backfill defers the post — NOT misclassified as too-short', async () => {
    process.env.BACKFILL_POST_TEXT = 'true';
    listing = [raw('500', '')]; // empty listing text → needs backfill
    // /posts/info always 429s (original attempt + the one retry) → text never recovered.
    mockFetch.mockImplementation(async (url: string) => {
      const u = String(url);
      if (u.includes('username-to-urn')) return env({ urn: 'ACoA-test-urn', username: 'justinshriber' });
      if (u.includes('/posts/all')) return env({ cursor: 'c', posts: listing });
      if (u.includes('/posts/info')) {
        return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({ success: false, errors: 'rate limited' }) };
      }
      if (u.includes('hooks.slack')) return { ok: true };
      return env({});
    });
    judge([]); // no new active posts to group

    const { skipped, partitions } = await ingestPartitions();
    const id = idOf('500');
    // The post is deferred, not discarded: NOT in the skip list, NOT in the discarded set,
    // and NOT persisted — so it stays unknown and will be retried next cycle.
    expect(skipped.find((s) => s.post_id === id)).toBeUndefined();
    expect(getDiscardedPostIds().has(id)).toBe(false);
    expect(getPostById(id)).toBeUndefined();
    expect(partitions.find((p) => p.posts.some((x) => x.id === id))).toBeUndefined();
    // posts/info was retried once (2 calls total) before deferring.
    const infoCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes('/posts/info'));
    expect(infoCalls.length).toBe(2);
  });

  it('caps backfills per cycle at BACKFILL_MAX (excess thin posts are deferred, not discarded)', async () => {
    process.env.BACKFILL_POST_TEXT = 'true';
    process.env.BACKFILL_MAX = '2';
    infoText = LONG; // every backfill that runs succeeds
    listing = [raw('601', ''), raw('602', ''), raw('603', '')]; // 3 thin posts, cap is 2
    judge([
      { theme: 'A', post_ids: [idOf('601')], confidence: 1 },
      { theme: 'B', post_ids: [idOf('602')], confidence: 1 },
    ]);

    const { partitions, skipped } = await ingestPartitions();
    // Only 2 backfills run → 2 posts recovered+active; the 3rd is deferred (not discarded).
    const infoCalls = mockFetch.mock.calls.filter((c) => String(c[0]).includes('/posts/info'));
    expect(infoCalls.length).toBe(2);
    expect(partitions.length).toBe(2);
    expect(skipped.find((s) => s.post_id === idOf('603'))).toBeUndefined();
    expect(getDiscardedPostIds().has(idOf('603'))).toBe(false);
    expect(getPostById(idOf('603'))).toBeUndefined(); // deferred — retry next cycle
    delete process.env.BACKFILL_MAX;
  });

  it('backfills thin listing text from /posts/info before triage', async () => {
    process.env.BACKFILL_POST_TEXT = 'true';
    infoText = LONG; // /posts/info returns the full text
    listing = [raw('400', '')]; // listing text empty → would be discarded without backfill
    judge([{ theme: 'Backfilled', post_ids: [idOf('400')], confidence: 1 }]);

    const { partitions, skipped } = await ingestPartitions();
    expect(skipped).toHaveLength(0);
    expect(partitions[0].posts[0].id).toBe(idOf('400'));
    expect(partitions[0].posts[0].text).toBe(LONG);
    // /posts/info was actually consulted
    expect(mockFetch.mock.calls.some((c) => String(c[0]).includes('/posts/info'))).toBe(true);
  });
});

// ─── resilience + mode parity ─────────────────────────────────────────────────

describe('runCycle resilience', () => {
  it('API failure → cycle is skipped, recorded, never crashes', async () => {
    mockFetch.mockImplementation(async (url: string) => {
      if (String(url).includes('username-to-urn')) return { ok: false, status: 429, json: async () => ({ success: false, errors: 'quota exhausted' }) };
      return env({});
    });

    const result = await runCycle();
    expect(result.error).toBeTruthy();
    expect(result.generated).toBe(0);
    expect(result.partitions).toBe(0);
    // /status reads this back
    const status = JSON.parse(getMeta('last_poll')!) as { error: string | null };
    expect(status.error).toBeTruthy();
  });

  it('SOURCE_MODE=seed never calls LinkdAPI', async () => {
    process.env.SOURCE_MODE = 'seed';
    judge([]); // seed posts → fail-open singletons or this; doesn't matter
    const { found } = await ingestPartitions();
    expect(found).toBe(8); // seed has 8 posts
    expect(mockFetch.mock.calls.every((c) => !String(c[0]).includes('linkdapi'))).toBe(true);
  });
});

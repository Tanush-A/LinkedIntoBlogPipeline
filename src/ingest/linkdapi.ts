// src/ingest/linkdapi.ts
// LinkdAPI client + Post mapping + deterministic triage prefilters.
// This is the live SOURCE_MODE adapter; it maps the unofficial scraper's response onto
// the existing Post contract so nothing downstream changes (same 1:1 + judge flow).
//
// Endpoints (base https://linkdapi.com, auth header `X-linkdapi-apikey`):
//   GET /api/v1/profile/username-to-urn?username=<vanity>  → { urn }
//   GET /api/v1/posts/all?urn=<member-urn>                  → { cursor, posts[] } (100 first page)
//   GET /api/v1/posts/info?urn=<activity-id>                → { post: { text, ... } }
//
// IMPORTANT (discovered live): /posts/all returns EMPTY text for ~1/3 of real text posts.
// The full text lives in /posts/info. We backfill text for thin-listing posts before triage
// so genuine content is not silently discarded as "too short" (BACKFILL_POST_TEXT).

import type { Post } from '../types';
import { postIdFromUrl } from '../lib/postId';

const BASE = 'https://linkdapi.com';

export interface RawLinkdPost {
  text?: string;
  url: string;
  urn?: string;
  author?: { name?: string };
  postedAt?: { timestamp?: number; fullDate?: string };
  mediaContent?: { type?: string }[] | null;
  resharedPostContent?: unknown | null;
  header?: string | null;
}

interface Envelope<T> {
  success?: boolean;
  statusCode?: number;
  errors?: unknown;
  data?: T;
}

function apiKey(): string {
  const k = process.env.LINKDAPI_KEY;
  if (!k) throw new Error('LINKDAPI_KEY not set (required for SOURCE_MODE=live)');
  return k;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** API error carrying the HTTP status so callers can special-case 429 (rate limit). */
export class LinkdApiError extends Error {
  status: number;
  /** Suggested backoff from the 429 Retry-After header / body, in ms (if present). */
  retryAfterMs?: number;
  constructor(message: string, status: number, retryAfterMs?: number) {
    super(message);
    this.name = 'LinkdApiError';
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

/** Read the rate-limit backoff from a 429's Retry-After header or envelope body, in ms. */
function parseRetryAfterMs(res: Response, json: Envelope<unknown>): number | undefined {
  const header = res.headers?.get?.('retry-after');
  if (header) {
    const secs = Number(header);
    if (!Number.isNaN(secs)) return secs * 1000;
  }
  const body = json as { retryAfter?: unknown; errors?: { retryAfter?: unknown } };
  const ra = typeof body.retryAfter === 'number' ? body.retryAfter : body.errors?.retryAfter;
  if (typeof ra === 'number') return ra * 1000;
  return undefined;
}

/**
 * Low-level GET. Throws LinkdApiError on transport failure, non-2xx, OR a `success !== true`
 * envelope (quota exhaustion can return HTTP 200 with success:false — that must fail the cycle).
 */
async function linkdGet<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${BASE}${path}?${qs}`, {
    headers: { 'X-linkdapi-apikey': apiKey() },
  });
  let json: Envelope<T>;
  try {
    json = (await res.json()) as Envelope<T>;
  } catch {
    throw new LinkdApiError(`LinkdAPI ${path}: non-JSON response (HTTP ${res.status})`, res.status);
  }
  if (!res.ok || json.success !== true || json.data == null) {
    throw new LinkdApiError(
      `LinkdAPI ${path} failed: http=${res.status} success=${String(json.success)} errors=${JSON.stringify(json.errors)}`,
      res.status,
      parseRetryAfterMs(res, json),
    );
  }
  return json.data;
}

/** Resolve a profile identifier to a member URN. A value already shaped like a member URN passes through. */
export async function resolveProfileUrn(profileId: string): Promise<string> {
  if (/^ACoA/i.test(profileId)) return profileId; // already an internal member URN
  const data = await linkdGet<{ urn: string }>('/api/v1/profile/username-to-urn', {
    username: profileId,
  });
  return data.urn;
}

export async function fetchPostListing(urn: string): Promise<RawLinkdPost[]> {
  const data = await linkdGet<{ posts?: RawLinkdPost[] }>('/api/v1/posts/all', { urn });
  return data.posts ?? [];
}

/** Full text for a single post (the listing often omits it). */
export async function fetchPostText(activityId: string): Promise<string> {
  const data = await linkdGet<{ post?: { text?: string } }>('/api/v1/posts/info', {
    urn: activityId,
  });
  return data.post?.text ?? '';
}

/** Extract the numeric activity id from `urn:li:activity:<id>` (posts/info wants the integer). */
export function activityIdOf(raw: RawLinkdPost): string {
  const m = (raw.urn ?? raw.url ?? '').match(/activity:?(\d{6,})/);
  return m ? m[1] : '';
}

export function mapRawPost(raw: RawLinkdPost, text: string): Post {
  return {
    id: postIdFromUrl(raw.url),
    author: raw.author?.name ?? 'Unknown',
    url: raw.url,
    text: text.trim(),
    // postedAt.timestamp is epoch MILLISECONDS (13 digits) — do NOT multiply.
    ...(raw.postedAt?.timestamp
      ? { posted_at: new Date(raw.postedAt.timestamp).toISOString() }
      : {}),
  };
}

/**
 * Deterministic triage. Returns a skip reason or null (keep).
 *   reshare    — a repost/share of someone else's content (not original)
 *   media-only — has media but no substantive text
 *   too-short  — text below MIN_POST_CHARS (covers polls, one-liners, engagement bait)
 */
export function prefilterReason(
  raw: RawLinkdPost,
  text: string,
  minChars: number,
): string | null {
  if (raw.resharedPostContent != null || /\brepost(ed)?\b/i.test(raw.header ?? '')) {
    return 'reshare';
  }
  if (text.trim().length < minChars) {
    return raw.mediaContent && raw.mediaContent.length > 0 ? 'media-only' : 'too-short';
  }
  return null;
}

export interface LivePostResult {
  post: Post;
  /** prefilter skip reason, or null if the post passes deterministic triage */
  reason: string | null;
  /**
   * true when the post is thin AND its full text could NOT be recovered this cycle
   * (rate-limited / error / backfill cap). It must NOT be classified as "too-short" —
   * the caller leaves it unpersisted to retry next cycle.
   */
  deferred: boolean;
}

export interface FetchLiveOptions {
  /** Already-seen ids (drafted ∪ discarded) — skips backfill + is excluded downstream. */
  knownIds: Set<string>;
  /** Ids force-included via groups.json — bypass prefilter discard (recovery path). */
  forcedIds: Set<string>;
  minChars: number;
  /** 0 = unlimited; else process only the newest N listing posts (credit guard). */
  maxPosts: number;
  /** Backfill empty/thin listing text from /posts/info before triage. */
  backfill: boolean;
}

/**
 * Fetch the profile's posts, map to the Post contract, backfill thin text, and run the
 * deterministic prefilter. No DB writes — the caller (ingest) persists active/discarded.
 */
export async function fetchLivePosts(opts: FetchLiveOptions): Promise<LivePostResult[]> {
  const profileId = process.env.PROFILE_ID ?? 'justinshriber';
  const urn = await resolveProfileUrn(profileId);
  let listing = await fetchPostListing(urn);
  if (opts.maxPosts > 0) listing = listing.slice(0, opts.maxPosts);

  // Rate-limit guards for /posts/info (Testing tier ≈ 7 req/min):
  //   - THROTTLE_MS spaces calls (~9s = under 7/min);
  //   - BACKFILL_MAX caps calls per cycle;
  //   - a single 429 retry (honoring Retry-After) before giving up.
  const THROTTLE_MS = parseInt(process.env.BACKFILL_THROTTLE_MS ?? '9000', 10);
  const BACKFILL_MAX = parseInt(process.env.BACKFILL_MAX ?? '5', 10);
  let backfillsUsed = 0;
  let lastBackfillAt = 0;

  async function throttle(): Promise<void> {
    if (THROTTLE_MS <= 0) return;
    const wait = lastBackfillAt + THROTTLE_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastBackfillAt = Date.now();
  }

  // Returns the recovered text, or null if it could not be fetched this cycle.
  async function recoverText(raw: RawLinkdPost): Promise<string | null> {
    await throttle();
    try {
      return await fetchPostText(activityIdOf(raw));
    } catch (err) {
      if (err instanceof LinkdApiError && err.status === 429) {
        const backoff = err.retryAfterMs ?? THROTTLE_MS;
        console.warn(`[linkdapi] 429 on backfill — retrying once in ${backoff}ms`);
        if (backoff > 0) await sleep(backoff);
        try {
          return await fetchPostText(activityIdOf(raw));
        } catch (err2) {
          console.warn(`[linkdapi] backfill retry failed: ${err2 instanceof Error ? err2.message : err2}`);
          return null;
        }
      }
      console.warn(`[linkdapi] backfill failed: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  const out: LivePostResult[] = [];
  for (const raw of listing) {
    const id = postIdFromUrl(raw.url);
    let text = raw.text ?? '';
    const isNew = !opts.knownIds.has(id);
    let deferred = false;

    const needsBackfill =
      opts.backfill && isNew && raw.resharedPostContent == null && text.trim().length < opts.minChars;

    if (needsBackfill) {
      if (backfillsUsed >= BACKFILL_MAX) {
        // Per-cycle cap hit — not even attempted. Defer (NOT "too-short"); retry next cycle.
        deferred = true;
        console.log(`[linkdapi] defer ${id}: backfill cap (${BACKFILL_MAX}) reached this cycle`);
      } else {
        backfillsUsed++;
        const recovered = await recoverText(raw);
        if (recovered === null) {
          // Could NOT recover the text (rate-limited/error) — defer, do not misclassify.
          deferred = true;
          console.log(`[linkdapi] defer ${id}: text not recovered (rate-limited/error), retry next cycle`);
        } else if (recovered.trim().length > text.trim().length) {
          text = recovered;
        }
      }
    }

    const post = mapRawPost(raw, text);
    if (deferred) {
      out.push({ post, reason: null, deferred: true });
      continue;
    }
    const reason = opts.forcedIds.has(id) ? null : prefilterReason(raw, post.text, opts.minChars);
    out.push({ post, reason, deferred: false });
  }
  return out;
}

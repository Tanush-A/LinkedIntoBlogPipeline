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

/**
 * Low-level GET. Throws on transport failure, non-2xx, OR a `success !== true` envelope
 * (quota exhaustion can return HTTP 200 with success:false — that must fail the cycle).
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
    throw new Error(`LinkdAPI ${path}: non-JSON response (HTTP ${res.status})`);
  }
  if (!res.ok || json.success !== true || json.data == null) {
    throw new Error(
      `LinkdAPI ${path} failed: http=${res.status} success=${String(json.success)} errors=${JSON.stringify(json.errors)}`,
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

  const out: LivePostResult[] = [];
  for (const raw of listing) {
    const id = postIdFromUrl(raw.url);
    let text = raw.text ?? '';
    const isNew = !opts.knownIds.has(id);

    // Backfill only NEW, non-reshare posts whose listing text is thin — bounds credit use.
    if (
      opts.backfill &&
      isNew &&
      raw.resharedPostContent == null &&
      text.trim().length < opts.minChars
    ) {
      try {
        const full = await fetchPostText(activityIdOf(raw));
        if (full.trim().length > text.trim().length) text = full;
      } catch (err) {
        console.warn(`[linkdapi] text backfill failed for ${id}: ${err instanceof Error ? err.message : err}`);
      }
    }

    const post = mapRawPost(raw, text);
    const reason = opts.forcedIds.has(id) ? null : prefilterReason(raw, post.text, opts.minChars);
    out.push({ post, reason });
  }
  return out;
}

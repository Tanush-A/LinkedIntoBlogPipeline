// src/lib/postId.ts
// The single source of truth for deriving a Post.id from its URL.
// Stable dedup key: SHA-256 of the NORMALIZED url (strip query string + trailing slash,
// so the same post shared with different utm/tracking params collapses to one id),
// first 12 hex chars. Used by both the seed builder and live LinkdAPI ingestion.

import { createHash } from 'node:crypto';

export function postIdFromUrl(url: string): string {
  const normalized = url.trim().split('?')[0].replace(/\/+$/, '');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 12);
}

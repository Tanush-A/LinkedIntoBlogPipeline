// src/lib/fingerprint.ts
// Deterministic group identity for synthesis drafts.

import { createHash } from 'node:crypto';

/** Deterministic group identity: same membership = same fingerprint, any order. */
export function groupFingerprint(postIds: string[]): string {
  return createHash('sha256').update([...postIds].sort().join('\n')).digest('hex');
}

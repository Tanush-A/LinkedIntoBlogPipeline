// src/lib/seed.ts
// The seed file is a SOURCE that feeds the posts table — it is not read at request time.
// readSeedPosts() reads the file; syncSeedToDb() upserts every seed post into the DB.
// loadPosts (db.ts) and the judge's member summaries read from the table, not from here.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Post } from '../types';
import { upsertPost } from '../db';

export function readSeedPosts(): Post[] {
  const seedPath = resolve(__dirname, '../..', 'seed', 'posts.json');
  return JSON.parse(readFileSync(seedPath, 'utf-8')) as Post[];
}

/** Upsert the current seed file into the posts table. Idempotent. */
export function syncSeedToDb(): void {
  for (const post of readSeedPosts()) upsertPost(post);
}

// src/pipeline/ingest.ts
// Reads seed/posts.json and returns posts that have no existing draft in the DB.
// Post.id is read straight from the seed — no re-hashing (see docs/DECISIONS.md).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Post } from '../types';
import { getDraftBySourcePostId } from '../db';

export function ingestPosts(): Post[] {
  const seedPath = resolve(__dirname, '../..', 'seed', 'posts.json');
  const posts = JSON.parse(readFileSync(seedPath, 'utf-8')) as Post[];
  return posts.filter((post) => !getDraftBySourcePostId(post.id));
}

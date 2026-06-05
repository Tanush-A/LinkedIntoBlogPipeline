// tests/dedup.test.ts
// Ingestion / dedup — verifies ingestPosts() filters by source_post_id.

import { describe, it, expect, beforeEach, vi } from 'vitest';

// openai is imported transitively via regenerate; mock it to prevent instantiation
vi.mock('openai', () => ({ default: vi.fn() }));

import { insertDraft, _resetDbForTesting } from '../src/db';
import { ingestPosts } from '../src/pipeline/ingest';
import { makeDraft } from './helpers/fixtures';

const TOTAL_SEED_POSTS = 8; // seed/posts.json has 8 posts

beforeEach(() => {
  _resetDbForTesting();
});

describe('ingest dedup', () => {
  it('empty DB → ingestPosts returns all seed posts', () => {
    const posts = ingestPosts();
    expect(posts).toHaveLength(TOTAL_SEED_POSTS);
    for (const post of posts) {
      expect(post.id).toBeTruthy();
      expect(post.text).toBeTruthy();
    }
  });

  it('re-ingesting the same post creates no duplicate (post is excluded on second call)', () => {
    const first = ingestPosts();
    const firstPost = first[0]!;

    // Simulate the pipeline having processed this post
    insertDraft(makeDraft({ source_post_id: firstPost.id }));

    const second = ingestPosts();
    expect(second).toHaveLength(first.length - 1);
    expect(second.find((p) => p.id === firstPost.id)).toBeUndefined();
  });

  it('all posts processed → ingestPosts returns empty array', () => {
    const posts = ingestPosts();
    for (const post of posts) {
      insertDraft(makeDraft({ source_post_id: post.id }));
    }
    expect(ingestPosts()).toHaveLength(0);
  });

  it('ingestPosts returns Post objects with required fields', () => {
    const posts = ingestPosts();
    for (const post of posts) {
      expect(typeof post.id).toBe('string');
      expect(typeof post.author).toBe('string');
      expect(typeof post.url).toBe('string');
      expect(typeof post.text).toBe('string');
    }
  });

  it('draft created by ingest starts with status pending', () => {
    const posts = ingestPosts();
    const post = posts[0]!;
    const draft = insertDraft(makeDraft({ source_post_id: post.id }));
    expect(draft.status).toBe('pending');
    expect(draft.source_post_id).toBe(post.id);
  });
});

// ─── todo stubs ───────────────────────────────────────────────────────────────

describe('upcoming: synthesis', () => {
  it.todo('group-fingerprint dedup: two posts with same fingerprint → one synthesis output');
  it.todo('single-post group → behaves as 1:1 (no grouping applied)');
});

// tests/publish.test.ts
// dev.to publish — field mapping, auth header, idempotency guard, DEVTO_DRAFT_MODE.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('openai', () => ({ default: vi.fn() }));

import { publish } from '../src/pipeline/publish';
import { insertDraft, getDraft, _resetDbForTesting } from '../src/db';
import { makeDraft, DEVTO_MOCK_RESPONSE } from './helpers/fixtures';

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetDbForTesting();
  delete process.env.DEVTO_DRAFT_MODE;
  // Default: POST → devto response with id+url; PUT (canonical) → ok
  mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => DEVTO_MOCK_RESPONSE,
  });
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.DEVTO_DRAFT_MODE;
});

describe('publish', () => {
  it('maps title from TITLE: prefix in revised_draft', async () => {
    const d = insertDraft(makeDraft({ status: 'approved' }));
    await publish(d);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit & { body: string }];
    const body = JSON.parse(options.body) as { article: Record<string, unknown> };
    // MOCK_REVISED_DRAFT starts with "TITLE: Why Forecasting Is a Management Problem..."
    expect(body.article.title).toBe('Why Forecasting Is a Management Problem, Not a Finance One');
  });

  it('body_markdown excludes the TITLE: line', async () => {
    const d = insertDraft(makeDraft({ status: 'approved' }));
    await publish(d);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit & { body: string }];
    const body = JSON.parse(options.body) as { article: Record<string, unknown> };
    expect((body.article.body_markdown as string)).not.toContain('TITLE:');
    expect((body.article.body_markdown as string)).toContain('Most revenue teams treat forecasting');
  });

  it('description is ≤155 chars and is a non-empty string', async () => {
    const d = insertDraft(makeDraft({ status: 'approved' }));
    await publish(d);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit & { body: string }];
    const body = JSON.parse(options.body) as { article: { description: string } };
    expect(typeof body.article.description).toBe('string');
    expect(body.article.description.length).toBeGreaterThan(0);
    expect(body.article.description.length).toBeLessThanOrEqual(155);
  });

  it('tags is a comma-separated string of max 4 plain lowercase terms', async () => {
    const d = insertDraft(makeDraft({ status: 'approved' }));
    await publish(d);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit & { body: string }];
    const body = JSON.parse(options.body) as { article: { tags: string } };
    expect(body.article.tags).toBe('sales,revenue,ai,saas');
    expect(body.article.tags.split(',').length).toBeLessThanOrEqual(4);
  });

  it('sends api-key header — NOT Authorization: Bearer', async () => {
    const d = insertDraft(makeDraft({ status: 'approved' }));
    await publish(d);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers['api-key']).toBe('test-devto-key');
    expect(headers['Authorization']).toBeUndefined();
  });

  it('DEVTO_DRAFT_MODE=true → published: false in request body', async () => {
    process.env.DEVTO_DRAFT_MODE = 'true';
    const d = insertDraft(makeDraft({ status: 'approved' }));
    await publish(d);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit & { body: string }];
    const body = JSON.parse(options.body) as { article: { published: boolean } };
    expect(body.article.published).toBe(false);
  });

  it('DEVTO_DRAFT_MODE not set → published: true', async () => {
    const d = insertDraft(makeDraft({ status: 'approved' }));
    await publish(d);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit & { body: string }];
    const body = JSON.parse(options.body) as { article: { published: boolean } };
    expect(body.article.published).toBe(true);
  });

  it('sets status to published and cms_url on success', async () => {
    const d = insertDraft(makeDraft({ status: 'approved' }));
    await publish(d);

    const fresh = getDraft(d.id)!;
    expect(fresh.status).toBe('published');
    expect(fresh.cms_url).toBe(DEVTO_MOCK_RESPONSE.url);
  });

  it('makes a best-effort PUT for canonical_url after the POST', async () => {
    const d = insertDraft(makeDraft({ status: 'approved' }));
    await publish(d);

    // Two calls: POST create + PUT canonical
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [putUrl] = mockFetch.mock.calls[1] as [string];
    expect(putUrl).toContain(`/api/articles/${DEVTO_MOCK_RESPONSE.id}`);
  });

  // ── Idempotency guard ─────────────────────────────────────────────────────────

  it('idempotent: returns early if cms_url already set — no fetch calls', async () => {
    const d = insertDraft(
      makeDraft({ status: 'approved', cms_url: 'https://dev.to/existing' }),
    );
    await publish(d);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('idempotent: returns early if status !== approved — no fetch calls', async () => {
    const d = insertDraft(makeDraft({ status: 'pending' }));
    await publish(d);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('publish guard: approved && cms_url==null are two separate checks (never double-publishes)', async () => {
    // Draft has cms_url set — even if status is somehow approved, publish must skip
    const d = insertDraft(
      makeDraft({ status: 'approved', cms_url: 'https://dev.to/already-published' }),
    );
    await publish(d);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(getDraft(d.id)!.cms_url).toBe('https://dev.to/already-published');
  });

  // ── Error handling ────────────────────────────────────────────────────────────

  it('throws if dev.to returns non-ok and does not update DB', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 422,
      json: async () => ({ error: 'Unprocessable Entity' }),
    });
    const d = insertDraft(makeDraft({ status: 'approved' }));

    await expect(publish(d)).rejects.toThrow('dev.to API 422');
    const fresh = getDraft(d.id)!;
    expect(fresh.status).toBe('approved'); // not changed to published
    expect(fresh.cms_url).toBeUndefined();
  });

  it('throws when DEVTO_API_KEY is not set', async () => {
    const original = process.env.DEVTO_API_KEY;
    delete process.env.DEVTO_API_KEY;
    const d = insertDraft(makeDraft({ status: 'approved' }));
    try {
      await expect(publish(d)).rejects.toThrow('DEVTO_API_KEY not set');
    } finally {
      process.env.DEVTO_API_KEY = original;
    }
  });
});

// ─── todo stubs ───────────────────────────────────────────────────────────────
// Repurposing (blog → LinkedIn/X/newsletter) is scoped + cut for time — a generation-layer
// add (one post-publish step, same model + verifyDraft, no architectural change).
// See docs/DECISIONS.md [2026-06-07] "Repurposing — scoped and cut for time".

describe('upcoming: repurposing', () => {
  it.todo('triggers on publish event: 3 repurposed variants generated');
  it.todo('each variant body contains the published cms_url');
  it.todo('repurposed variants are stored with reference to original draft id');
});

// tests/publish.test.ts
// dev.to publish — field mapping, auth header, idempotency guard, DEVTO_DRAFT_MODE.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Class-based mock so repurpose() (which constructs `new OpenAI()`) gets a working chat client.
// publish.ts never constructs OpenAI, so this is inert for the publish tests.
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock('openai', () => ({
  default: class OpenAIMock {
    chat = { completions: { create: mockCreate } };
  },
}));

import { publish } from '../src/pipeline/publish';
import { repurpose } from '../src/pipeline/repurpose';
import { insertDraft, getDraft, _resetDbForTesting } from '../src/db';
import { makeDraft, DEVTO_MOCK_RESPONSE, MOCK_REPURPOSE_VARIANTS, MOCK_CMS_URL } from './helpers/fixtures';

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

// ─── Repurposing (post-publish promo kit) ───────────────────────────────────────
// Built [2026-06-08]: a post-publish generation step — same model + verifyDraft, no
// architectural change. repurpose() runs AFTER a successful publish and never writes status.
// See docs/DECISIONS.md [2026-06-08] "Repurposing — built (post-publish, fail-safe)".

function mockRepurposeOnce(variants: unknown = MOCK_REPURPOSE_VARIANTS): void {
  mockCreate.mockResolvedValueOnce({
    choices: [{ message: { content: JSON.stringify(variants) } }],
  });
}

/** A freshly-published draft, ready to repurpose. */
function publishedDraft() {
  return getDraft(insertDraft(makeDraft({ status: 'published', cms_url: MOCK_CMS_URL })).id)!;
}

describe('repurposing', () => {
  it('produces exactly 3 channel variants (linkedin, twitter, newsletter)', async () => {
    mockRepurposeOnce();
    const result = await repurpose(publishedDraft());

    expect(result.variants).toHaveLength(3);
    expect(result.variants.map((v) => v.channel)).toEqual(['linkedin', 'twitter', 'newsletter']);
  });

  it('each variant body contains the published cms_url (enforced deterministically)', async () => {
    mockRepurposeOnce(); // fixture omits the URL — repurpose must inject it into all three
    const result = await repurpose(publishedDraft());

    for (const v of result.variants) {
      expect(v.text).toContain(MOCK_CMS_URL);
    }
  });

  it('persists repurposed_content on the row with a reference to the original draft id', async () => {
    mockRepurposeOnce();
    const d = publishedDraft();
    await repurpose(d);

    const stored = getDraft(d.id)!;
    expect(stored.repurposed_content).toBeDefined();
    expect(stored.repurposed_content!.draft_id).toBe(d.id);
    expect(stored.repurposed_content!.variants).toHaveLength(3);
    expect(stored.repurposed_content!.cms_url).toBe(MOCK_CMS_URL);
  });

  it('runs verifyDraft on each variant — a slop term in one variant is flagged, others pass', async () => {
    mockRepurposeOnce({
      ...MOCK_REPURPOSE_VARIANTS,
      linkedin: 'This post delves into why forecasting is a management discipline.',
    });
    const result = await repurpose(publishedDraft());

    const linkedin = result.variants.find((v) => v.channel === 'linkedin')!;
    expect(linkedin.verification.bannedTerms).toContain('delve');
    expect(linkedin.verification.passed).toBe(false);

    const newsletter = result.variants.find((v) => v.channel === 'newsletter')!;
    expect(newsletter.verification.passed).toBe(true);
  });

  it('a repurpose failure does NOT affect published status (status never written)', async () => {
    mockCreate.mockRejectedValueOnce(new Error('LLM unavailable'));
    const d = publishedDraft();

    await expect(repurpose(d)).rejects.toThrow('LLM unavailable');

    const fresh = getDraft(d.id)!;
    expect(fresh.status).toBe('published');
    expect(fresh.cms_url).toBe(MOCK_CMS_URL);
    expect(fresh.repurposed_content).toBeUndefined();
  });
});

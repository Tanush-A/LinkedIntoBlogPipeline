// tests/gate.test.ts
// State machine / gate — the most important suite.
// Tests run against real handler code; only the three external edges are mocked.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'node:crypto';

// vi.hoisted: the spy must exist before the vi.mock factory runs (factories are hoisted above imports).
const { mockCreate } = vi.hoisted(() => ({ mockCreate: vi.fn() }));
vi.mock('openai', () => ({
  default: class OpenAIMock {
    chat = { completions: { create: mockCreate } };
  },
}));

import { app } from '../src/server/approval';
import { insertDraft, getDraft, getPostById, setMeta, _resetDbForTesting } from '../src/db';
import { groupFingerprint } from '../src/lib/fingerprint';
import {
  makeDraft,
  MOCK_CRITIQUE,
  MOCK_REVISED_DRAFT,
  DEVTO_MOCK_RESPONSE,
  MOCK_REPURPOSE_VARIANTS,
  SEED_POST_ID,
  SEED_POST_ID_2,
} from './helpers/fixtures';

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetDbForTesting();
  // Default: any fetch call succeeds. json() returns the devto shape (Slack never calls json).
  mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => DEVTO_MOCK_RESPONSE,
  });
  vi.stubGlobal('fetch', mockFetch);
  // Default LLM response = a valid promo kit, so each successful approve runs repurpose
  // (now awaited in the publish path) quietly and in-window. Per-test `mockResolvedValueOnce`
  // for the regen revise pass still takes precedence.
  mockCreate.mockResolvedValue({
    choices: [{ message: { content: JSON.stringify(MOCK_REPURPOSE_VARIANTS) } }],
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── Status-machine basics ────────────────────────────────────────────────────

describe('state machine', () => {
  it('new draft starts pending', () => {
    const d = insertDraft(makeDraft());
    expect(d.status).toBe('pending');
    expect(d.revision_count).toBe(0);
    expect(d.cms_url).toBeUndefined();
  });

  it('approve from pending → 302 redirect, status published, cms_url set', async () => {
    const d = insertDraft(makeDraft({ status: 'pending' }));

    const res = await request(app)
      .post(`/action/${d.id}`)
      .type('form')
      .send('action=approve');

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe(DEVTO_MOCK_RESPONSE.url);

    const fresh = getDraft(d.id)!;
    expect(fresh.status).toBe('published');
    expect(fresh.cms_url).toBe(DEVTO_MOCK_RESPONSE.url);
  });

  it('approve again on published draft → 400, no second dev.to call', async () => {
    const d = insertDraft(
      makeDraft({ status: 'published', cms_url: DEVTO_MOCK_RESPONSE.url }),
    );

    const res = await request(app)
      .post(`/action/${d.id}`)
      .type('form')
      .send('action=approve');

    expect(res.status).toBe(400);
    // Idempotency: handler never reached publish() — no fetch calls at all
    expect(mockFetch).not.toHaveBeenCalled();
    // Row is unchanged
    const fresh = getDraft(d.id)!;
    expect(fresh.status).toBe('published');
    expect(fresh.cms_url).toBe(DEVTO_MOCK_RESPONSE.url);
  });

  it('approve from needs_edits → 302, published', async () => {
    const d = insertDraft(makeDraft({ status: 'needs_edits' }));

    const res = await request(app)
      .post(`/action/${d.id}`)
      .type('form')
      .send('action=approve');

    expect(res.status).toBe(302);
    expect(getDraft(d.id)!.status).toBe('published');
  });

  it('approve from rejected → 400 (terminal)', async () => {
    const d = insertDraft(makeDraft({ status: 'rejected' }));

    const res = await request(app)
      .post(`/action/${d.id}`)
      .type('form')
      .send('action=approve');

    expect(res.status).toBe(400);
    expect(getDraft(d.id)!.status).toBe('rejected');
  });

  it('approve from failed → retries publish (302, published)', async () => {
    const d = insertDraft(makeDraft({ status: 'failed' }));

    const res = await request(app)
      .post(`/action/${d.id}`)
      .type('form')
      .send('action=approve');

    expect(res.status).toBe(302);
    expect(getDraft(d.id)!.status).toBe('published');
  });

  it('reject from pending → 200, status rejected', async () => {
    const d = insertDraft(makeDraft({ status: 'pending' }));

    const res = await request(app)
      .post(`/action/${d.id}`)
      .type('form')
      .send('action=reject');

    expect(res.status).toBe(200);
    expect(getDraft(d.id)!.status).toBe('rejected');
  });

  // ── Request-edits ────────────────────────────────────────────────────────────

  it('request-edits with empty note → 400, status unchanged', async () => {
    const d = insertDraft(makeDraft({ status: 'pending' }));

    const res = await request(app)
      .post(`/action/${d.id}`)
      .type('form')
      .send('action=needs_edits&note=');

    expect(res.status).toBe(400);
    expect(getDraft(d.id)!.status).toBe('pending');
  });

  it('request-edits at revision cap → 400', async () => {
    const d = insertDraft(makeDraft({ status: 'pending', revision_count: 3 }));

    const res = await request(app)
      .post(`/action/${d.id}`)
      .type('form')
      .send('action=needs_edits&note=Please+fix+the+intro');

    expect(res.status).toBe(400);
    // revision_count must not change
    expect(getDraft(d.id)!.revision_count).toBe(3);
  });

  it(
    'request-edits with a note → 202, needs_edits stored, regen fires, revision_count increments on success',
    async () => {
      const d = insertDraft(
        makeDraft({
          status: 'pending',
          revision_count: 0,
          revised_draft: MOCK_REVISED_DRAFT,
          critique: JSON.stringify(MOCK_CRITIQUE),
        }),
      );

      // regenerate will call the revise pass (Pass 4) once
      mockCreate.mockResolvedValueOnce({
        choices: [{ message: { content: 'TITLE: Revised\n\nRevised content after edits.' } }],
      });

      const res = await request(app)
        .post(`/action/${d.id}`)
        .type('form')
        .send('action=needs_edits&note=Please+shorten+the+intro');

      expect(res.status).toBe(202);

      // Drain the fire-and-forget regen (mocked LLM resolves near-instantly).
      // reviewer_note is written before regen fires and persists through the regen
      // update, so checking it after completion is safe.
      const updated = await vi.waitFor(
        () => {
          const d2 = getDraft(d.id)!;
          if (d2.revision_count === 0) throw new Error('regen not done yet');
          return d2;
        },
        { timeout: 5000 },
      );

      expect(updated.revision_count).toBe(1);
      expect(updated.status).toBe('pending');
      expect(updated.reviewer_note).toBe('Please shorten the intro');
      expect(updated.revised_draft).toBe('TITLE: Revised\n\nRevised content after edits.');
    },
  );

  // ── Publish failure / retry ──────────────────────────────────────────────────

  it('publish failure → status failed; re-approve retries publish', async () => {
    const d = insertDraft(makeDraft({ status: 'pending' }));

    // First approve: dev.to returns 500
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({ error: 'Server error' }),
    });

    const failRes = await request(app)
      .post(`/action/${d.id}`)
      .type('form')
      .send('action=approve');

    expect(failRes.status).toBe(500);
    expect(getDraft(d.id)!.status).toBe('failed');
    // Repurpose triggers ONLY after a successful publish — a failed publish must not reach it.
    expect(mockCreate).not.toHaveBeenCalled();

    // Second approve: mockFetch falls back to the default (ok: true, DEVTO_MOCK_RESPONSE)
    const retryRes = await request(app)
      .post(`/action/${d.id}`)
      .type('form')
      .send('action=approve');

    expect(retryRes.status).toBe(302);
    expect(getDraft(d.id)!.status).toBe('published');
    expect(getDraft(d.id)!.cms_url).toBe(DEVTO_MOCK_RESPONSE.url);
  });

  // ── Repurposing (post-publish promo kit) ──────────────────────────────────────

  it('approve fires repurpose AFTER publish: published draft gets a 3-variant promo kit', async () => {
    const d = insertDraft(makeDraft({ status: 'pending' }));

    const res = await request(app)
      .post(`/action/${d.id}`)
      .type('form')
      .send('action=approve');

    expect(res.status).toBe(302);
    const fresh = getDraft(d.id)!;
    expect(fresh.status).toBe('published');
    // repurpose is awaited in the publish path, so the kit is persisted by the time we redirect.
    expect(fresh.repurposed_content).toBeDefined();
    expect(fresh.repurposed_content!.draft_id).toBe(d.id);
    expect(fresh.repurposed_content!.variants).toHaveLength(3);
  });

  it('a repurpose failure does not break approve: still 302 + published, no promo kit', async () => {
    const d = insertDraft(makeDraft({ status: 'pending' }));
    // One-time rejection ahead of the default success → repurpose throws; handler swallows it.
    mockCreate.mockRejectedValueOnce(new Error('LLM unavailable'));

    const res = await request(app)
      .post(`/action/${d.id}`)
      .type('form')
      .send('action=approve');

    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe(DEVTO_MOCK_RESPONSE.url);
    const fresh = getDraft(d.id)!;
    expect(fresh.status).toBe('published');
    expect(fresh.cms_url).toBe(DEVTO_MOCK_RESPONSE.url);
    expect(fresh.repurposed_content).toBeUndefined();
  });

  // ── Edge cases ────────────────────────────────────────────────────────────────

  it('unknown action → 400', async () => {
    const d = insertDraft(makeDraft());
    const res = await request(app)
      .post(`/action/${d.id}`)
      .type('form')
      .send('action=unknown');
    expect(res.status).toBe(400);
  });

  it('missing draft → 404', async () => {
    const res = await request(app)
      .post(`/action/${randomUUID()}`)
      .type('form')
      .send('action=approve');
    expect(res.status).toBe(404);
  });

  it('GET /review/:draftId returns 200 with draft content', async () => {
    const d = insertDraft(makeDraft());
    const res = await request(app).get(`/review/${d.id}`);
    expect(res.status).toBe(200);
    expect(res.text).toContain(d.id);
    expect(res.text).toContain('PENDING');
  });

  it('GET /review/:draftId for missing draft returns 404', async () => {
    const res = await request(app).get(`/review/${randomUUID()}`);
    expect(res.status).toBe(404);
  });

  it('GET /status returns the last poll record (and a null when none has run)', async () => {
    const none = await request(app).get('/status');
    expect(none.status).toBe(200);
    expect((none.body as { lastPoll: unknown }).lastPoll).toBeNull();

    setMeta('last_poll', JSON.stringify({ at: '2026-06-07T00:00:00.000Z', found: 6, newCount: 6, partitions: 3, generated: 1, skipped: 1, error: null }));
    const res = await request(app).get('/status');
    expect(res.status).toBe(200);
    const body = res.body as { lastPoll: { found: number; generated: number; error: string | null } };
    expect(body.lastPoll.found).toBe(6);
    expect(body.lastPoll.generated).toBe(1);
    expect(body.lastPoll.error).toBeNull();
  });

  it('GET /review for a pillar draft lists ALL source posts and the theme', async () => {
    const ids = [SEED_POST_ID, SEED_POST_ID_2];
    const d = insertDraft(
      makeDraft({
        source_post_ids: ids,
        group_fingerprint: groupFingerprint(ids),
        theme: 'Fragmented data breaks revenue AI',
      }),
    );
    const res = await request(app).get(`/review/${d.id}`);
    expect(res.status).toBe(200);
    // Theme is shown…
    expect(res.text).toContain('Fragmented data breaks revenue AI');
    // …and every source post is linked by its real URL (path portion; query has
    // HTML-escaped & in the rendered href).
    for (const id of ids) {
      expect(res.text).toContain(getPostById(id)!.url.split('?')[0]);
    }
    // Pillar header reflects the synthesis count.
    expect(res.text).toContain('2 synthesized');
  });
});

// ─── Verification layer ───────────────────────────────────────────────────────
// Pure verifyDraft unit checks (no DB needed). Comprehensive coverage lives in
// tests/verify.test.ts; these stubs are the original gate checklist entries.

import { verifyDraft } from '../src/lib/verify';

describe('verification layer', () => {
  it('"delves" → bannedTerms non-empty', () => {
    const r = verifyDraft('This post delves into revenue forecasting.');
    expect(r.bannedTerms.some(t => t === 'delve')).toBe(true);
    expect(r.passed).toBe(false);
  });

  it('"3.1x" → ungroundedNumbers non-empty (demo figure)', () => {
    const r = verifyDraft('Closed at 3.1x the rate of feature-led pitches.');
    expect(r.ungroundedNumbers).toContain('3.1x');
    expect(r.passed).toBe(false);
  });

  it('clean draft → passed=true', () => {
    const r = verifyDraft(
      'TITLE: The Real Cost of Forecast Drift\n\n' +
      'Forecasting is a management discipline, not a finance deliverable.',
    );
    expect(r.passed).toBe(true);
  });
});

// Re-score loop tests live in tests/generation.test.ts (they test generate(), not the
// HTTP surface). The stubs above are covered by the 're-score loop' describe block there.

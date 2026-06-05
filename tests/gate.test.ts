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
import { insertDraft, getDraft, _resetDbForTesting } from '../src/db';
import { makeDraft, MOCK_CRITIQUE, MOCK_REVISED_DRAFT, DEVTO_MOCK_RESPONSE } from './helpers/fixtures';

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetDbForTesting();
  // Default: any fetch call succeeds. json() returns the devto shape (Slack never calls json).
  mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => DEVTO_MOCK_RESPONSE,
  });
  vi.stubGlobal('fetch', mockFetch);
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

    // Second approve: mockFetch falls back to the default (ok: true, DEVTO_MOCK_RESPONSE)
    const retryRes = await request(app)
      .post(`/action/${d.id}`)
      .type('form')
      .send('action=approve');

    expect(retryRes.status).toBe(302);
    expect(getDraft(d.id)!.status).toBe('published');
    expect(getDraft(d.id)!.cms_url).toBe(DEVTO_MOCK_RESPONSE.url);
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
});

// ─── todo stubs — upcoming extensions ────────────────────────────────────────

describe('upcoming: verification layer', () => {
  it.todo('"delves" → flagged by bannedTerms check');
  it.todo('"3.1x" → flagged by ungroundedNumbers check');
  it.todo('clean draft → verification passes');
});

describe('upcoming: re-score loop', () => {
  it.todo('mocked scores [3,3,4] → loops until ≥4; retains best-of result');
  it.todo('mocked scores [4] → single pass, no loop');
});

// tests/notify.test.ts
// Slack notify — asserts message shape and review URL construction.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('openai', () => ({ default: vi.fn() }));

import { notify } from '../src/pipeline/notify';
import { insertDraft, _resetDbForTesting } from '../src/db';
import { makeDraft, MOCK_POST } from './helpers/fixtures';

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  _resetDbForTesting();
  mockFetch = vi.fn().mockResolvedValue({ ok: true });
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('notify', () => {
  it('POSTs to SLACK_WEBHOOK_URL', async () => {
    const d = insertDraft(makeDraft());
    await notify(d, [MOCK_POST]);

    const [url] = mockFetch.mock.calls[0] as [string];
    expect(url).toBe('https://hooks.slack.com/test');
  });

  it('message contains the review link built from BASE_URL', async () => {
    const d = insertDraft(makeDraft());
    await notify(d, [MOCK_POST]);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as { text: string };
    expect(body.text).toContain(`http://localhost:3000/review/${d.id}`);
  });

  it('message contains the source post URL', async () => {
    const d = insertDraft(makeDraft());
    await notify(d, [MOCK_POST]);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as { text: string };
    expect(body.text).toContain(MOCK_POST.url);
  });

  it('request uses Content-Type: application/json', async () => {
    const d = insertDraft(makeDraft());
    await notify(d, [MOCK_POST]);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
  });

  it('throws on non-ok webhook response', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 403, statusText: 'Forbidden' });
    const d = insertDraft(makeDraft());
    await expect(notify(d, [MOCK_POST])).rejects.toThrow('Slack webhook failed');
  });

  it('throws when SLACK_WEBHOOK_URL is not set', async () => {
    const original = process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;
    const d = insertDraft(makeDraft());
    try {
      await expect(notify(d, [MOCK_POST])).rejects.toThrow('SLACK_WEBHOOK_URL not set');
    } finally {
      process.env.SLACK_WEBHOOK_URL = original;
    }
  });
});

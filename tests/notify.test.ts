// tests/notify.test.ts
// Slack notify — asserts message shape and review URL construction.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('openai', () => ({ default: vi.fn() }));

import { notify, notifyRepurposed } from '../src/pipeline/notify';
import { insertDraft, _resetDbForTesting } from '../src/db';
import { makeDraft, MOCK_POST } from './helpers/fixtures';
import type { RepurposedContent, VerificationResult } from '../src/types';

const CLEAN: VerificationResult = { bannedTerms: [], ungroundedNumbers: [], passed: true };

function makeRepurposed(overrides: Partial<RepurposedContent> = {}): RepurposedContent {
  const cms_url = 'https://dev.to/x/why-forecasting-is-a-management-problem';
  return {
    draft_id: 'draft-1',
    cms_url,
    blog_title: 'Why Forecasting Is a Management Problem',
    generated_at: new Date().toISOString(),
    variants: [
      { channel: 'linkedin', label: 'LinkedIn post', text: `LinkedIn body\n\n${cms_url}`, verification: CLEAN },
      { channel: 'twitter', label: 'X / Twitter thread', text: `1/ hook\n\n2/ ${cms_url}`, verification: CLEAN },
      { channel: 'newsletter', label: 'Newsletter blurb', text: `Blurb ${cms_url}`, verification: CLEAN },
    ],
    ...overrides,
  };
}

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

describe('notifyRepurposed', () => {
  it('sends ONE message with blog title + cms_url on top and a section per channel', async () => {
    const content = makeRepurposed();
    await notifyRepurposed(content);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as { text: string };

    expect(body.text).toContain(content.blog_title);
    expect(body.text).toContain(content.cms_url);
    expect(body.text).toContain('LinkedIn post');
    expect(body.text).toContain('X / Twitter thread');
    expect(body.text).toContain('Newsletter blurb');
  });

  it('surfaces verification flags for a variant that did not pass', async () => {
    const content = makeRepurposed();
    content.variants[0].verification = {
      bannedTerms: ['delve'],
      ungroundedNumbers: ['3.1x'],
      passed: false,
    };
    await notifyRepurposed(content);

    const [, options] = mockFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string) as { text: string };
    expect(body.text).toContain('delve');
    expect(body.text).toContain('3.1x');
  });

  it('is best-effort: does not throw when SLACK_WEBHOOK_URL is unset', async () => {
    const original = process.env.SLACK_WEBHOOK_URL;
    delete process.env.SLACK_WEBHOOK_URL;
    try {
      await expect(notifyRepurposed(makeRepurposed())).resolves.toBeUndefined();
      expect(mockFetch).not.toHaveBeenCalled();
    } finally {
      process.env.SLACK_WEBHOOK_URL = original;
    }
  });

  it('is best-effort: does not throw when the webhook returns non-ok', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 500, statusText: 'Server Error' });
    await expect(notifyRepurposed(makeRepurposed())).resolves.toBeUndefined();
  });
});

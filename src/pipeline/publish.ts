// src/pipeline/publish.ts
// Publishes an approved draft to dev.to via REST API.
// Idempotency guard: returns early if status != 'approved' or cms_url already set.

import type { Draft } from '../types';
import { updateDraft } from '../db';

const DEVTO_API = 'https://dev.to/api/articles';

interface DevtoArticleResponse {
  id?: number;
  url?: string;
  canonical_url?: string;
  slug?: string;
  error?: string;
  status?: string;
}

export async function publish(draft: Draft): Promise<void> {
  // Idempotency guard — safe to call multiple times
  if (draft.status !== 'approved' || draft.cms_url != null) return;

  const apiKey = process.env.DEVTO_API_KEY;
  if (!apiKey) throw new Error('DEVTO_API_KEY not set');

  const title = deriveTitle(draft);
  const body_markdown = draft.revised_draft ?? '[No content generated]';
  const description = deriveDescription(body_markdown, title);

  const response = await fetch(DEVTO_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // dev.to / Forem auth: plain key in api-key header, NOT Bearer
      'api-key': apiKey,
    },
    body: JSON.stringify({
      article: {
        title,
        body_markdown,
        // DEVTO_DRAFT_MODE=true → published:false (dev.to draft, not public) for test runs.
        // Unset or any other value → published:true for real live publish.
        published: process.env.DEVTO_DRAFT_MODE !== 'true',
        // Tags: plain lowercase alphanumeric strings, MAX 4 — dev.to rejects/drops otherwise
        tags: ['sales', 'revenue', 'ai', 'saas'],
        description,
        // canonical_url left null for Stage 1; full AEO field mapping is Stage 4
        canonical_url: null,
      },
    }),
  });

  const json = (await response.json()) as DevtoArticleResponse;

  if (!response.ok) {
    const errMsg = typeof json.error === 'string' ? json.error : JSON.stringify(json);
    throw new Error(`dev.to API ${response.status}: ${errMsg}`);
  }

  const postUrl = json.url;
  if (!postUrl) {
    throw new Error(`dev.to API returned no url field. Response: ${JSON.stringify(json)}`);
  }

  updateDraft(draft.id, { status: 'published', cms_url: postUrl });
}

function deriveTitle(draft: Draft): string {
  if (draft.revised_draft) {
    const firstLine = draft.revised_draft
      .split('\n')
      .map((l) => l.replace(/^#+\s*/, '').trim())
      .find((l) => l.length > 0);
    if (firstLine) return firstLine.slice(0, 100);
  }
  return `Draft ${draft.id.slice(0, 8)}`;
}

// Extract the first substantive paragraph for the meta description (≤155 chars).
function deriveDescription(markdown: string, title: string): string {
  const first = markdown
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 20 && !l.startsWith('#'));
  return (first ?? title).slice(0, 155);
}

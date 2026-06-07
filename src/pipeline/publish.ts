// src/pipeline/publish.ts
// Publishes an approved draft to dev.to via REST API.
// Idempotency guard: returns early if status != 'approved' or cms_url already set.
//
// Stage 4 field mapping:
//   title        — stripped from TITLE: first line of revised_draft (revise.ts contract)
//   body_markdown — post body without TITLE: line; AEO structure baked in by revise prompt
//   description  — first substantive paragraph, stripped of markdown, ≤155 chars (meta)
//   tags         — comma-separated string per Forem API spec, max 4 plain lowercase strings
//   canonical_url — two-step: POST to create → persist cms_url → PUT canonical_url best-effort
//                   dev.to self-canonicalizes by default; the PUT makes it explicit.

import type { Draft } from '../types';
import { updateDraft } from '../db';
import { splitTitleAndBody, deriveMetaDescription, META_MAX } from '../lib/text';

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

  const { title, body } = splitTitleAndBody(draft.revised_draft ?? '[No content generated]');
  const description = deriveDescription(body);

  // Step 1: Create the article (no canonical_url yet — we don't have the URL)
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
        body_markdown: body,
        // DEVTO_DRAFT_MODE=true → published:false (dev.to draft) for test runs.
        published: process.env.DEVTO_DRAFT_MODE !== 'true',
        // Tags: comma-separated string per Forem API spec (v1 schema type: string).
        // Max 4, plain lowercase alphanumeric. Fifth is silently dropped.
        tags: 'sales,revenue,ai,saas',
        description,
      },
    }),
  });

  const json = (await response.json()) as DevtoArticleResponse;

  if (!response.ok) {
    const errMsg = typeof json.error === 'string' ? json.error : JSON.stringify(json);
    throw new Error(`dev.to API ${response.status}: ${errMsg}`);
  }

  const postUrl = json.url;
  const articleId = json.id;
  if (!postUrl) {
    throw new Error(`dev.to API returned no url field. Response: ${JSON.stringify(json)}`);
  }

  // Step 2: Persist immediately — must happen before any further network calls.
  // If the canonical PUT below throws, we've already secured the published state.
  updateDraft(draft.id, { status: 'published', cms_url: postUrl });

  // Step 3: Best-effort PUT to set canonical_url explicitly.
  // dev.to defaults canonical to the article's own URL, so a PUT failure is cosmetic.
  // We do not throw or revert status on failure — the post is already live and persisted.
  if (articleId) {
    try {
      await fetch(`${DEVTO_API}/${articleId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'api-key': apiKey },
        body: JSON.stringify({ article: { canonical_url: postUrl } }),
      });
      console.log(`[publish] canonical_url set to ${postUrl} for draft=${draft.id}`);
    } catch (err) {
      console.warn(`[publish] canonical_url PUT failed for draft=${draft.id}: ${String(err)}`);
    }
  }
}

/**
 * Meta description for the published article: the first substantive paragraph, truncated to
 * META_MAX. Delegates to the shared `deriveMetaDescription` (lib/text.ts) so the review-page
 * scorecard and the actual publish use the exact same source text.
 */
function deriveDescription(body: string): string {
  return deriveMetaDescription(body).slice(0, META_MAX);
}

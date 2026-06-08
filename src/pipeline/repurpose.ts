// src/pipeline/repurpose.ts
// Post-publish repurposing: turn a PUBLISHED blog post into three channel-native promo
// variants (LinkedIn / X / newsletter) and deliver them to Slack for a human to copy out.
//
// Architectural guarantees:
//   - Runs AFTER publish() has set status='published' and cms_url. It NEVER writes status,
//     so a repurpose failure cannot revert the publish — the post is live regardless.
//   - The cms_url is enforced into every variant deterministically (we do not trust the LLM
//     to include the link), mirroring the verifyDraft philosophy.
//   - Each variant runs the same deterministic verifyDraft guardrail as the blog (slop terms +
//     ungrounded figures), surfaced — not hard-blocking. Nothing auto-posts to any platform;
//     the human copies from Slack, so the approval gate is preserved.
//   - repurposed_content is persisted BEFORE the Slack call, so a Slack outage never loses
//     generated variants.

import OpenAI from 'openai';
import type { Draft, RepurposeChannel, RepurposedVariant, RepurposedContent } from '../types';
import { updateDraft, loadPosts } from '../db';
import { verifyDraft } from '../lib/verify';
import { splitTitleAndBody } from '../lib/text';
import { buildRepurposeMessages } from '../../prompts/repurpose';
import { notifyRepurposed } from './notify';

interface RawVariants {
  linkedin?: unknown;
  twitter?: unknown;
  newsletter?: unknown;
}

/** Append the URL only if the text does not already contain it. */
function ensureUrl(text: string, url: string): string {
  const trimmed = text.trim();
  return trimmed.includes(url) ? trimmed : `${trimmed}\n\n${url}`;
}

/** Render an X/Twitter thread: guarantee the URL is present, then number each tweet. */
function renderThread(tweets: string[], url: string): string {
  const cleaned = tweets.map((t) => t.trim()).filter(Boolean);
  if (!cleaned.some((t) => t.includes(url))) cleaned.push(url);
  return cleaned.map((t, i) => `${i + 1}/ ${t}`).join('\n\n');
}

/**
 * Generate, verify, persist, and deliver channel variants for a published draft.
 * Throws on a hard failure (missing cms_url, LLM error, malformed JSON) — the caller
 * (approval handler) swallows it. Status is never touched, so publish state is safe.
 */
export async function repurpose(draft: Draft): Promise<RepurposedContent> {
  if (!draft.cms_url) {
    throw new Error(`repurpose: draft ${draft.id} has no cms_url — not published?`);
  }
  if (!draft.revised_draft) {
    throw new Error(`repurpose: draft ${draft.id} has no revised_draft to repurpose`);
  }
  const cmsUrl = draft.cms_url;

  const { title, body } = splitTitleAndBody(draft.revised_draft);
  // Grounding corpus = the source posts, so a figure the author actually stated is not
  // falsely flagged as ungrounded (same rule the blog generation uses).
  const sourcePosts = loadPosts(draft.source_post_ids);
  const sourceTexts = sourcePosts.map((p) => p.text);

  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  const MODEL = process.env.OPENAI_MODEL ?? 'gpt-5.5';

  console.log(`[repurpose] generate draft=${draft.id} model=${MODEL}`);
  const resp = await client.chat.completions.create({
    model: MODEL,
    response_format: { type: 'json_object' },
    messages: buildRepurposeMessages({ title, body, cmsUrl }),
  });

  const content = resp.choices[0]?.message?.content;
  if (!content) throw new Error('repurpose: model returned null content');

  const raw = JSON.parse(content) as RawVariants;

  const linkedin = typeof raw.linkedin === 'string' ? raw.linkedin : '';
  const newsletter = typeof raw.newsletter === 'string' ? raw.newsletter : '';
  const tweets: string[] = Array.isArray(raw.twitter)
    ? raw.twitter.map((t) => String(t))
    : typeof raw.twitter === 'string'
      ? [raw.twitter]
      : [];

  if (!linkedin.trim() || !newsletter.trim() || tweets.length === 0) {
    throw new Error('repurpose: model returned malformed or incomplete variant JSON');
  }

  // Build each variant with the cms_url guaranteed present, then verify it.
  const built: { channel: RepurposeChannel; label: string; text: string }[] = [
    { channel: 'linkedin', label: 'LinkedIn post', text: ensureUrl(linkedin, cmsUrl) },
    { channel: 'twitter', label: 'X / Twitter thread', text: renderThread(tweets, cmsUrl) },
    { channel: 'newsletter', label: 'Newsletter blurb', text: ensureUrl(newsletter, cmsUrl) },
  ];

  const variants: RepurposedVariant[] = built.map((v) => ({
    ...v,
    verification: verifyDraft(v.text, sourceTexts),
  }));

  for (const v of variants) {
    console.log(
      `[repurpose] ${v.channel} draft=${draft.id}` +
        ` passed=${v.verification.passed}` +
        ` banned=${v.verification.bannedTerms.length}` +
        ` ungrounded=${v.verification.ungroundedNumbers.length}`,
    );
  }

  const result: RepurposedContent = {
    draft_id: draft.id,
    cms_url: cmsUrl,
    blog_title: title,
    generated_at: new Date().toISOString(),
    variants,
  };

  // Persist FIRST — a Slack failure must not lose generated variants.
  updateDraft(draft.id, { repurposed_content: result });

  // Deliver to Slack (best-effort; notifyRepurposed never throws).
  await notifyRepurposed(result);

  return result;
}

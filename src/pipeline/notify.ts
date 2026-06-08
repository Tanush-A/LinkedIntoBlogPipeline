// src/pipeline/notify.ts
// Posts a Slack incoming webhook notification when a draft is ready for review.
// A draft may synthesize multiple source posts — the title/source lines note the extra
// sources, and the judge's theme is included when set. n=1 reads exactly as before.

import type { Draft, Post, RepurposedContent } from '../types';

export async function notify(draft: Draft, posts: Post[]): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) throw new Error('SLACK_WEBHOOK_URL not set');

  const baseUrl = (process.env.BASE_URL ?? 'http://localhost:3000').replace(/\/$/, '');
  const reviewUrl = `${baseUrl}/review/${draft.id}`;

  const extra = posts.length - 1;
  const suffix = extra > 0 ? ` (+${extra} more source${extra > 1 ? 's' : ''})` : '';
  const postTitle = (posts[0]?.text.split('\n')[0] ?? '').slice(0, 80) + suffix;
  const sourceLine = (posts[0]?.url ?? '') + suffix;

  const preview = (draft.revised_draft ?? '')
    .replace(/^#+\s*/m, '')
    .split('\n')
    .find((l) => l.trim().length > 0) ?? '[no content]';

  const payload = {
    text: [
      `*New draft ready for review*`,
      ``,
      ...(draft.theme ? [`*Theme:* ${draft.theme}`] : []),
      `*Post:* ${postTitle}`,
      `*Source:* ${sourceLine}`,
      `*Preview:* ${preview.slice(0, 120)}`,
      ``,
      `*Review:* ${reviewUrl}`,
    ].join('\n'),
  };

  const response = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`Slack webhook failed: ${response.status} ${response.statusText}`);
  }
}

/**
 * Deliver the post-publish promo kit to Slack as ONE message — the published title + URL at
 * the top, then a clearly labelled section per channel (LinkedIn / X / newsletter) for a human
 * to copy out. Nothing is auto-posted to any platform — the human gate is preserved.
 * Best-effort: never throws (the variants are already persisted on the draft row).
 */
export async function notifyRepurposed(content: RepurposedContent): Promise<void> {
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) {
    console.warn('[notify] SLACK_WEBHOOK_URL not set — skipping repurpose delivery');
    return;
  }

  const sections = content.variants.map((v) => {
    const v9n = v.verification.passed
      ? ''
      : `\n_⚠️ review:_ ${[
          v.verification.bannedTerms.length ? `banned: ${v.verification.bannedTerms.join(', ')}` : '',
          v.verification.ungroundedNumbers.length
            ? `ungrounded: ${v.verification.ungroundedNumbers.join(', ')}`
            : '',
        ]
          .filter(Boolean)
          .join('; ')}`;
    return `*${v.label}*${v9n}\n${v.text}`;
  });

  const text = [
    `*Promo kit ready — copy & post*`,
    `*${content.blog_title}*`,
    content.cms_url,
    ``,
    sections.join('\n\n──────────\n\n'),
  ].join('\n');

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!response.ok) {
      console.warn(`[notify] repurpose delivery failed: ${response.status} ${response.statusText}`);
    }
  } catch (err) {
    console.warn(`[notify] repurpose delivery error: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * One best-effort Slack line summarizing posts triaged out this cycle, e.g.
 * "Ingestion triage: 3 posts skipped (2 reshare, 1 too-short)". Never throws.
 */
export async function notifySkipped(skipped: { post_id: string; reason: string }[]): Promise<void> {
  if (skipped.length === 0) return;
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  if (!webhookUrl) return;

  const PREFILTER = new Set(['reshare', 'media-only', 'too-short']);
  const counts = new Map<string, number>();
  for (const s of skipped) {
    const bucket = PREFILTER.has(s.reason) ? s.reason : 'low-value';
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  const detail = [...counts.entries()].map(([r, c]) => `${c} ${r}`).join(', ');
  const text = `*Ingestion triage:* ${skipped.length} post${skipped.length > 1 ? 's' : ''} skipped (${detail})`;

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (err) {
    console.warn(`[notify] skip summary failed: ${err instanceof Error ? err.message : err}`);
  }
}

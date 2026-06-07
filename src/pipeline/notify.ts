// src/pipeline/notify.ts
// Posts a Slack incoming webhook notification when a draft is ready for review.
// A draft may synthesize multiple source posts — the title/source lines note the extra
// sources, and the judge's theme is included when set. n=1 reads exactly as before.

import type { Draft, Post } from '../types';

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

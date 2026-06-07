// prompts/group.ts
// Grouping judge — partitions a batch of posts into theme groups + singletons.
// Call with response_format: { type: "json_object" }, strong model.

import type { Post } from '../src/types';

export interface ExistingGroupSummary {
  theme: string;
  member_post_ids: string[];
  /** First line of each member post, for the judge's context. */
  member_summaries: string[];
}

const SYSTEM = `\
You are an editorial planner for a B2B revenue-intelligence blog. You receive a batch of
LinkedIn posts and must partition them into groups that should each become ONE blog post.

Group posts together ONLY when they argue the same underlying thesis or attack the same
problem from angles that belong in one piece. Surface-level keyword overlap ("both mention
AI") is NOT grounds for grouping. A reader of the resulting blog post must experience the
sources as one coherent argument, not a stapled-together digest.

Posts that stand alone stay alone — singletons are the normal case, groups are the
exception that must earn itself.

You also receive EXISTING THEMES with their member posts. If a new post clearly belongs
to an existing theme, output a partition containing the existing members' ids PLUS the
new post's id — this triggers an intentional roll-up piece. Only do this when the new
post genuinely extends the theme; do not force attachment.

Return JSON only, exactly this shape:
{
  "partitions": [
    {
      "theme": "Short editorial theme name, e.g. 'Fragmented data breaks revenue AI'",
      "post_ids": ["id1", "id2"],
      "confidence": 0.85
    }
  ]
}

Rules:
- EVERY new post id appears in EXACTLY ONE partition. No omissions, no duplicates.
- Singletons are partitions with one post_id. Give them a theme too.
- confidence is your belief (0–1) that the group is editorially coherent. Singletons: 1.0.
- Existing-member ids may ONLY appear in a partition that also contains at least one new id.`;

export function buildGroupingMessages(
  newPosts: Post[],
  existingGroups: ExistingGroupSummary[],
) {
  const postsBlock = newPosts
    .map((p) => `<post id="${p.id}">\n${p.text}\n</post>`)
    .join('\n\n');
  const groupsBlock = existingGroups.length
    ? existingGroups
        .map(
          (g) =>
            `<existing_theme name="${g.theme}" member_ids="${g.member_post_ids.join(',')}">\n` +
            g.member_summaries.map((s) => `- ${s}`).join('\n') +
            `\n</existing_theme>`,
        )
        .join('\n\n')
    : '(none yet)';

  const user = `\
NEW POSTS (partition all of these):

${postsBlock}

EXISTING THEMES (attach new posts only if they genuinely extend one):

${groupsBlock}

Return JSON only.`;

  return [
    { role: 'system' as const, content: SYSTEM },
    { role: 'user' as const, content: user },
  ];
}

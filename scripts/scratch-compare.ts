// scripts/scratch-compare.ts
// Run the 4-pass chain on 3 seed posts, print critique scores side by side,
// and write each post's revised_draft to docs/eval/<post-id>.md.
// No Slack, no publish, no DB writes.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import allPosts from '../seed/posts.json';
import { generate } from '../src/pipeline/generate';
import type { CritiqueOutput, CritiqueScores } from '../src/types';

const TARGET_IDS = ['d6456cd37b98', 'fedaea46bd69', '24b7e159d3d4'];

const posts = TARGET_IDS.map((id) => {
  const p = allPosts.find((p) => p.id === id);
  if (!p) throw new Error(`post ${id} not found in seed`);
  return p;
});

const DIMS: (keyof CritiqueScores)[] = [
  'hook', 'originality', 'voice_fit', 'value',
  'product_integration', 'structure', 'truth', 'extractability',
];

function pad(s: string, n: number) { return s.padEnd(n); }
function center(s: string, n: number) { return s.padStart(Math.floor((n + s.length) / 2)).padEnd(n); }

async function main() {
  const results: Array<{ postId: string; label: string; critique: CritiqueOutput; revised_draft: string }> = [];

  for (const post of posts) {
    const label = post.text.slice(0, 45).replace(/\n/g, ' ') + '…';
    console.log(`\n[compare] Running: ${post.id}`);
    const r = await generate([post]);
    const critique: CritiqueOutput = JSON.parse(r.critique);
    results.push({ postId: post.id, label, critique, revised_draft: r.revised_draft });
  }

  // ── Score table ────────────────────────────────────────────────────────────
  const COL = 22;
  console.log('\n\n═══════════════════════ CRITIQUE SCORES ═══════════════════════\n');
  console.log(pad('', 22) + results.map((r) => center(r.label.slice(0, COL - 2), COL)).join(''));
  console.log(pad('', 22) + results.map((r) => center(r.critique.overall.toString(), COL)).join(''));
  console.log('─'.repeat(22 + COL * results.length));

  for (const dim of DIMS) {
    const row = pad(dim, 22) + results.map((r) => center(String(r.critique.scores[dim]), COL)).join('');
    console.log(row);
  }

  console.log('─'.repeat(22 + COL * results.length));
  const overallRow = pad('OVERALL', 22) + results.map((r) => center(String(r.critique.overall), COL)).join('');
  console.log(overallRow);

  // ── Problems by post ───────────────────────────────────────────────────────
  console.log('\n\n═══════════════════════ TOP PROBLEMS ═══════════════════════\n');
  for (let i = 0; i < results.length; i++) {
    const { postId, label, critique } = results[i];
    console.log(`\n[${postId}] ${label}`);
    critique.problems.slice(0, 3).forEach((p) => console.log(`  • ${p}`));
  }

  // ── Write eval files ───────────────────────────────────────────────────────
  const evalDir = path.join(__dirname, '..', 'docs', 'eval');
  fs.mkdirSync(evalDir, { recursive: true });

  for (const { postId, critique, revised_draft } of results) {
    const scoreBlock = [
      '| dimension | score |',
      '|---|---|',
      ...DIMS.map((d) => `| ${d} | ${critique.scores[d]} |`),
      `| **overall** | **${critique.overall}** |`,
    ].join('\n');

    const problemsBlock = critique.problems.map((p) => `- ${p}`).join('\n');
    const cutBlock = critique.cut_list.map((c) => `- ${c}`).join('\n');
    const strengthenBlock = critique.strengthen.map((s) => `- ${s}`).join('\n');

    const content = [
      `## Critique scores`,
      '',
      scoreBlock,
      '',
      `### Problems`,
      problemsBlock,
      '',
      `### Cut list`,
      cutBlock,
      '',
      `### Strengthen`,
      strengthenBlock,
      '',
      '---',
      '',
      revised_draft,
    ].join('\n');

    const outPath = path.join(evalDir, `${postId}.md`);
    fs.writeFileSync(outPath, content, 'utf8');
    console.log(`\n[eval] Written: docs/eval/${postId}.md`);
  }

  console.log('\n[compare] Done.\n');
}

main().catch((err: unknown) => {
  console.error('[compare] Fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});

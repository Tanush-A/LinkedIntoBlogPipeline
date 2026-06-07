// src/lib/scorecard.ts
// Deterministic AEO/SEO scorecard for a draft — pure, no LLM. Surfaced read-only on the
// review page so the reviewer sees, at a glance, whether the answer-engine structure the
// draft prompt asks for actually landed. Each check is PASS or WARN (advisory, never blocking
// — the human gate decides). `body` is the post WITHOUT the TITLE: line.

import type { CritiqueOutput } from '../types';
import { deriveMetaDescription, META_MAX } from './text';

export interface ScoreCheck {
  label: string;
  status: 'pass' | 'warn';
  detail: string;
}

const TITLE_MAX = 60; // dev.to title cap

export function buildScorecard(
  body: string,
  title: string | null,
  critique?: CritiqueOutput,
): ScoreCheck[] {
  const checks: ScoreCheck[] = [];
  const paragraphs = body.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);

  // 1. Title length (purpose-built informational title, ≤60 for dev.to)
  const tlen = title?.length ?? 0;
  checks.push({
    label: 'Title length',
    status: title != null && tlen >= 1 && tlen <= TITLE_MAX ? 'pass' : 'warn',
    detail: title != null ? `${tlen}/${TITLE_MAX} chars` : 'no TITLE: line',
  });

  // 2. Quick-answer block: an explicit label, OR a 40–80 word paragraph in the opening
  //    (~first 200 words) — the AEO extractable answer.
  let quick = /quick answer/i.test(body.slice(0, 1200));
  let cumulative = 0;
  for (const p of paragraphs) {
    const wc = p.split(/\s+/).filter(Boolean).length;
    if (cumulative <= 200 && wc >= 40 && wc <= 80) quick = true;
    cumulative += wc;
    if (cumulative > 220) break;
  }
  checks.push({
    label: 'Quick-answer block',
    status: quick ? 'pass' : 'warn',
    detail: quick ? 'present in opening' : 'none in first ~200 words',
  });

  // 3. Question-style H2s (excluding the FAQ heading) — answer engines lift Q-shaped sections.
  const h2s = (body.match(/^##\s+.+$/gm) ?? []).filter(
    (h) => !/frequently asked questions/i.test(h),
  );
  const questionH2 = h2s.filter((h) => h.trim().endsWith('?')).length;
  checks.push({
    label: 'Question-style H2s',
    status: questionH2 >= 1 ? 'pass' : 'warn',
    detail: `${questionH2} of ${h2s.length} H2s`,
  });

  // 4. FAQ section present (the other AEO edge)
  const faq = /^##\s+frequently asked questions/im.test(body);
  checks.push({
    label: 'FAQ section',
    status: faq ? 'pass' : 'warn',
    detail: faq ? 'present' : 'missing',
  });

  // 5. Meta description length — the SAME text publish.ts sends, reported untruncated so a
  //    reviewer sees if it will be cut.
  const meta = deriveMetaDescription(body);
  const mlen = meta.length;
  const metaOk = mlen >= 40 && mlen <= META_MAX;
  checks.push({
    label: 'Meta description',
    status: metaOk ? 'pass' : 'warn',
    detail:
      mlen === 0
        ? 'no candidate paragraph'
        : `${mlen} chars${mlen > META_MAX ? ` (truncates to ${META_MAX})` : ''}`,
  });

  // 6. Extractability — the critique pass's own 1–5 score for "could an answer engine lift this?"
  const e = critique?.scores?.extractability;
  if (typeof e === 'number') {
    checks.push({
      label: 'Extractability (critique)',
      status: e >= 4 ? 'pass' : 'warn',
      detail: `${e}/5`,
    });
  }

  return checks;
}

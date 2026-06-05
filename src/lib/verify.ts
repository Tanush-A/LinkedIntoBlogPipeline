// src/lib/verify.ts
// Deterministic post-generation guardrail layer.
//
// No LLM calls — pure regex + brand config lookup. Runs at the end of every
// generation pass (generate.ts) and every re-gen pass (regenerate.ts).
//
// Design decision: prompt instructions are probabilistic; guardrails are
// enforced deterministically here. Results are surfaced to the human reviewer
// rather than hard-blocking publish — the human stays in control.
// See docs/DECISIONS.md for the full rationale.
//
// verifyDraft(draftText: string) takes the FULL revised_draft string (not a
// Draft object) because verification runs before the row exists. The function
// is stateless and has no DB dependency.

import { BRAND } from '../config/brand';
import type { VerificationResult } from '../types';

// ─── Stat extraction ─────────────────────────────────────────────────────────
// Pattern covers: multipliers (3.1x, 2X), percentages (40%), dollar amounts
// ($4M, $1.5B, $500K), and comma-grouped large numbers (45,000).
// Raw small integers (3, 7) are intentionally excluded — too noisy.
const STAT_RE_SRC =
  String.raw`\$[\d,]+(?:\.\d+)?[KMBkmb]?` + // $4M, $1.5B, $500K
  String.raw`|\d+(?:\.\d+)?[xX]` +           // 3.1x, 2x, 10X
  String.raw`|\d+(?:,\d{3})+(?:\.\d+)?` +    // 45,000; 1,000,000
  String.raw`|\d+%`;                           // 40%, 78%

function extractStats(text: string): Set<string> {
  return new Set(
    [...text.matchAll(new RegExp(STAT_RE_SRC, 'g'))].map((m) => m[0].toLowerCase()),
  );
}

// Demo figures: sourced from positive_examples, explicitly marked
// "do NOT reproduce as proven stats." They ARE in the full brand text
// (they appear in positioning too), so the "absent from brand" branch
// alone would pass them — the DEMO_FIGURES branch catches them.
const DEMO_FIGURES = extractStats(BRAND.voice.positive_examples.join(' '));

// All stat-shaped figures anywhere in the brand config.
// A figure must be present here AND absent from DEMO_FIGURES to be "grounded."
// (Net effect for the current config: every stat flags — there are no verified
// numeric facts in brand.ts beyond the Jeff Perry testimonial, which is qualitative.
// Add a verified stat to brand.ts and it will stop flagging.)
const ALL_BRAND_STATS = extractStats(JSON.stringify(BRAND));

// ─── Slop-ban checks ─────────────────────────────────────────────────────────

// Convert a slop_ban entry to { displayTerm, re } or null if the entry describes
// a meta-pattern (not literal text to scan for).
function slopTermToCheck(rawTerm: string): { displayTerm: string; re: RegExp } | null {
  // Strip parenthetical notes: "(used metaphorically — ...)"
  // displayTerm is the cleaned readable form returned in bannedTerms.
  const displayTerm = rawTerm.replace(/\s*\([^)]*\)/g, '').trim();

  // Skip entries that describe a pattern, not literal text
  if (/^(any\s|throat-clearing|em-dash)/i.test(displayTerm)) return null;
  // Skip entries with X/Y placeholder variables
  if (/\bX\b|\bY\b/.test(displayTerm)) return null;
  if (!displayTerm) return null;

  // Handle "A / B" variant lists (e.g. "game-changer / game-changing")
  const variants = displayTerm
    .split(/\s*\/\s*/)
    .map((v) => v.trim())
    .filter(Boolean);

  const patterns = variants.map((v) => {
    // Escape regex special characters (apostrophe is not special — passes through)
    const escaped = v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const words = v.split(/\s+/);
    let stem: string;
    if (words.length === 1 && v.endsWith('e')) {
      // For single words ending in 'e', drop the terminal 'e' so that
      // -ing forms are caught: \bdelv matches "delving"; \bsupercharg matches "supercharging".
      stem = escaped.slice(0, -1);
    } else {
      stem = escaped.replace(/\s+/g, '\\s+');
    }
    // Leading \b only — trailing \b omitted so common inflections pass through.
    // i flag handles case; no g flag so test() is stateless (no lastIndex reset needed).
    return `\\b${stem}`;
  });

  return { displayTerm, re: new RegExp(patterns.join('|'), 'i') };
}

// Build once at module load; brand config is constant.
const SLOP_CHECKS: Array<{ term: string; re: RegExp }> = (BRAND.voice.slop_ban as readonly string[])
  .flatMap((rawTerm) => {
    const result = slopTermToCheck(rawTerm);
    return result ? [{ term: result.displayTerm, re: result.re }] : [];
  });

// ─── Public API ───────────────────────────────────────────────────────────────

export function verifyDraft(draftText: string): VerificationResult {
  // ── bannedTerms ────────────────────────────────────────────────────────────
  const bannedTerms: string[] = [];
  for (const { term, re } of SLOP_CHECKS) {
    if (re.test(draftText)) bannedTerms.push(term);
  }

  // ── ungroundedNumbers ─────────────────────────────────────────────────────
  const ungroundedNumbers: string[] = [];
  const statsInDraft = [...draftText.matchAll(new RegExp(STAT_RE_SRC, 'g'))].map((m) => m[0]);

  for (const raw of statsInDraft) {
    const norm = raw.toLowerCase();
    // Flag if it's a demo figure (in brand but not a verified stat)
    // OR if it's not in the brand config at all (invented)
    if (DEMO_FIGURES.has(norm) || !ALL_BRAND_STATS.has(norm)) {
      if (!ungroundedNumbers.includes(raw)) ungroundedNumbers.push(raw);
    }
  }

  return {
    bannedTerms,
    ungroundedNumbers,
    passed: bannedTerms.length === 0 && ungroundedNumbers.length === 0,
  };
}

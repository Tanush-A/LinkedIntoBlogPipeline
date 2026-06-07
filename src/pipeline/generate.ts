// src/pipeline/generate.ts
// Generation chain: extract → draft → critique → revise → re-score loop → verify.
//
// Re-score loop: after the initial revise, critique the revised draft and
// re-revise until overall ≥ 4 or RESCORE_CAP iterations (env var, default 3).
// Tracks the highest-scoring draft seen and returns that (best-of), not the last.
// RESCORE_CAP is read from env per call so tests can override it per-scenario.

import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import OpenAI from 'openai';
import type { Post, ExtractedIdea, CritiqueOutput, VerificationResult, PublishedRef } from '../types';
import { buildExtractionMessages } from '../../prompts/extract';
import { buildDraftMessages } from '../../prompts/draft';
import { buildCritiqueMessages } from '../../prompts/critique';
import { buildReviseMessages } from '../../prompts/revise';
import { verifyDraft } from '../lib/verify';
import { PRODUCT_CONTEXT_BLOCK } from '../config/brand';

export interface GenerateResult {
  extracted_idea: ExtractedIdea;
  raw_draft: string;
  /** JSON-stringified CritiqueOutput for the best draft — ready for db verbatim. */
  critique: string;
  revised_draft: string;
  verification: VerificationResult;
}

function requireContent(content: string | null, pass: string): string {
  if (content === null) throw new Error(`generate: ${pass} pass returned null content`);
  return content;
}

export async function generate(
  posts: Post[],
  publishedRefs: PublishedRef[] = [],
): Promise<GenerateResult> {
  // Instantiate after dotenv has loaded (called from run.ts which imports dotenv/config).
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  // Read per call so tests can override via process.env.RESCORE_CAP / OPENAI_MODEL*.
  const RESCORE_CAP = parseInt(process.env.RESCORE_CAP ?? '3', 10);
  const MODEL = process.env.OPENAI_MODEL ?? 'gpt-5.5';
  const MODEL_EXTRACT = process.env.OPENAI_MODEL_EXTRACT ?? 'gpt-5.4-mini';

  // Partition identity for logs/artifacts: first id + size (n=1 is the 1:1 case).
  const postLabel = posts.map((p) => p.id).join('+');
  const artifactBase = `${posts[0].id}-n${posts.length}`;

  // ── Pass 1: Extract (all source posts → one unified idea) ───────────────────
  console.log(`[generate] extract  post=${postLabel}`);
  const extractResp = await client.chat.completions.create({
    model: MODEL_EXTRACT,
    response_format: { type: 'json_object' },
    messages: buildExtractionMessages(posts),
  });
  const extracted: ExtractedIdea = JSON.parse(
    requireContent(extractResp.choices[0].message.content, 'extract'),
  );

  // ── Pass 2: Draft ───────────────────────────────────────────────────────────
  console.log(`[generate] draft    post=${postLabel}`);
  const draftResp = await client.chat.completions.create({
    model: MODEL,
    max_completion_tokens: 4000,
    messages: buildDraftMessages(posts, extracted, PRODUCT_CONTEXT_BLOCK, publishedRefs),
  });
  const raw_draft = requireContent(draftResp.choices[0].message.content, 'draft');

  // ── Pass 3: Critique (of raw_draft) ─────────────────────────────────────────
  console.log(`[generate] critique post=${postLabel}`);
  const critiqueResp = await client.chat.completions.create({
    model: MODEL,
    response_format: { type: 'json_object' },
    messages: buildCritiqueMessages(raw_draft),
  });
  const initialCritiqueObj: CritiqueOutput = JSON.parse(
    requireContent(critiqueResp.choices[0].message.content, 'critique'),
  );

  // ── Pass 4: Revise ──────────────────────────────────────────────────────────
  console.log(`[generate] revise   post=${postLabel}`);
  const reviseResp = await client.chat.completions.create({
    model: MODEL,
    max_completion_tokens: 4000,
    messages: buildReviseMessages(raw_draft, initialCritiqueObj),
  });
  const initialRevised = requireContent(reviseResp.choices[0].message.content, 'revise');

  // ── Re-score loop: critique → revise until overall ≥ 4 or RESCORE_CAP ───────
  // currentDraft: working copy each iteration.
  // best*: highest-scoring version seen — returned on any exit reason.
  // Strict > for the tie-break so the earliest draft at a given score is kept (deterministic).
  // Fallback to initialCritiqueObj when RESCORE_CAP=0 (loop disabled).
  let currentDraft = initialRevised;
  let bestDraft = initialRevised;
  let bestScore = 0;
  let bestCritiqueObj: CritiqueOutput = initialCritiqueObj;

  for (let iter = 0; iter < RESCORE_CAP; iter++) {
    const rescoreResp = await client.chat.completions.create({
      model: MODEL,
      response_format: { type: 'json_object' },
      messages: buildCritiqueMessages(currentDraft),
    });
    const rescoreObj: CritiqueOutput = JSON.parse(
      requireContent(rescoreResp.choices[0].message.content, `rescore iter=${iter + 1}`),
    );

    const isNewBest = rescoreObj.overall > bestScore;
    console.log(
      `[generate] rescore  post=${postLabel}` +
      ` iter=${iter + 1}/${RESCORE_CAP}` +
      ` overall=${rescoreObj.overall}` +
      (isNewBest ? ' (new best)' : ''),
    );

    // Persist this iteration's draft + critique for offline review.
    // Gated on NODE_ENV !== 'test' so the test tree stays clean.
    if (process.env.NODE_ENV !== 'test') {
      try {
        const evalDir = resolve(__dirname, '../../docs/eval/rescore');
        mkdirSync(evalDir, { recursive: true });
        const scoreDetail = (Object.entries(rescoreObj.scores) as [string, number][])
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        const fileContent =
          `# Rescore iter ${iter + 1} — post ${postLabel}\n\n` +
          `**Overall: ${rescoreObj.overall}/5** (${scoreDetail})\n\n` +
          `## Problems\n\n` +
          `${rescoreObj.problems.map((p) => `- ${p}`).join('\n') || '_none_'}\n\n` +
          `## Strengthen\n\n` +
          `${rescoreObj.strengthen.map((s) => `- ${s}`).join('\n') || '_none_'}\n\n` +
          `## Draft\n\n` +
          `${currentDraft}\n`;
        writeFileSync(
          resolve(evalDir, `${artifactBase}-iter-${iter + 1}.md`),
          fileContent,
          'utf-8',
        );
      } catch {
        // Non-critical — file write failure must not fail generation
      }
    }

    if (isNewBest) {
      bestDraft = currentDraft;
      bestScore = rescoreObj.overall;
      bestCritiqueObj = rescoreObj;
    }

    if (rescoreObj.overall >= 4) break; // target reached — no further passes needed

    if (iter + 1 >= RESCORE_CAP) break; // cap reached without hitting target

    // Re-revise with this critique and loop again
    const reReviseResp = await client.chat.completions.create({
      model: MODEL,
      max_completion_tokens: 4000,
      messages: buildReviseMessages(currentDraft, rescoreObj),
    });
    currentDraft = requireContent(
      reReviseResp.choices[0].message.content,
      `re-revise iter=${iter + 1}`,
    );
  }

  // ── Verify (deterministic — no LLM) ─────────────────────────────────────────
  // Grounding corpus = ALL source posts in the group, so a figure cited by ANY of them
  // is treated as grounded (not a false-positive ungrounded flag).
  const verification = verifyDraft(bestDraft, posts.map((p) => p.text));
  console.log(
    `[generate] verify   post=${postLabel}` +
    ` passed=${verification.passed}` +
    ` banned=${verification.bannedTerms.length}` +
    ` ungrounded=${verification.ungroundedNumbers.length}`,
  );
  if (!verification.passed) {
    if (verification.bannedTerms.length > 0) {
      console.warn(`[generate] banned_terms="${verification.bannedTerms.join(', ')}"`);
    }
    if (verification.ungroundedNumbers.length > 0) {
      console.warn(`[generate] ungrounded_numbers="${verification.ungroundedNumbers.join(', ')}"`);
    }
  }

  return {
    extracted_idea: extracted,
    raw_draft,
    critique: JSON.stringify(bestCritiqueObj),
    revised_draft: bestDraft,
    verification,
  };
}

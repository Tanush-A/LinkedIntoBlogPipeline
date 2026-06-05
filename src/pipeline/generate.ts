// src/pipeline/generate.ts
// Stage 2: real 4-pass GPT-4o chain.
// extract → draft → critique → revise
// Returns all four pass outputs so run.ts can persist them on the Draft row.

import OpenAI from 'openai';
import type { Post, ExtractedIdea, CritiqueOutput, VerificationResult } from '../types';
import { buildExtractionMessages } from '../../prompts/extract';
import { buildDraftMessages } from '../../prompts/draft';
import { buildCritiqueMessages } from '../../prompts/critique';
import { buildReviseMessages } from '../../prompts/revise';
import { verifyDraft } from '../lib/verify';

export interface GenerateResult {
  extracted_idea: ExtractedIdea;
  raw_draft: string;
  critique: string;          // JSON-stringified CritiqueOutput — ready for db (critique is verbatim)
  revised_draft: string;
  verification: VerificationResult;
}

function requireContent(content: string | null, pass: string): string {
  if (content === null) throw new Error(`generate: ${pass} pass returned null content`);
  return content;
}

export async function generate(post: Post): Promise<GenerateResult> {
  // Instantiate after dotenv has loaded (called from run.ts which imports dotenv/config).
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  // ── Pass 1: Extract ─────────────────────────────────────────────────────────
  console.log(`[generate] extract  post=${post.id}`);
  const extractResp = await client.chat.completions.create({
    model: 'gpt-4o',
    response_format: { type: 'json_object' },
    messages: buildExtractionMessages(post),
  });
  const extracted: ExtractedIdea = JSON.parse(
    requireContent(extractResp.choices[0].message.content, 'extract'),
  );

  // ── Pass 2: Draft ───────────────────────────────────────────────────────────
  console.log(`[generate] draft    post=${post.id}`);
  const draftResp = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: buildDraftMessages(post, extracted),
  });
  const raw_draft = requireContent(draftResp.choices[0].message.content, 'draft');

  // ── Pass 3: Critique ────────────────────────────────────────────────────────
  console.log(`[generate] critique post=${post.id}`);
  const critiqueResp = await client.chat.completions.create({
    model: 'gpt-4o',
    response_format: { type: 'json_object' },
    messages: buildCritiqueMessages(raw_draft),
  });
  const critiqueRaw = requireContent(critiqueResp.choices[0].message.content, 'critique');
  // Parse to object for revise pass; re-stringify for db storage (critique column is verbatim).
  const critiqueObj: CritiqueOutput = JSON.parse(critiqueRaw);
  const critique = JSON.stringify(critiqueObj);

  // ── Pass 4: Revise ──────────────────────────────────────────────────────────
  console.log(`[generate] revise   post=${post.id}`);
  const reviseResp = await client.chat.completions.create({
    model: 'gpt-4o',
    messages: buildReviseMessages(raw_draft, critiqueObj),
  });
  const revised_draft = requireContent(reviseResp.choices[0].message.content, 'revise');

  // ── Pass 5: Verify (deterministic — no LLM) ─────────────────────────────────
  const verification = verifyDraft(revised_draft);
  console.log(
    `[generate] verify   post=${post.id}` +
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

  return { extracted_idea: extracted, raw_draft, critique, revised_draft, verification };
}

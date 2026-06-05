
// prompts/revise.ts
// Revise pass — applies the editorial critique to produce the final blog post.
// Output is free text (the revised post). No JSON wrapping.
// BRAND_BLOCK is included because this is the terminal pass — no critique comes after it,
// so an ungrounded claim added here ships straight to publish.
 
import type { CritiqueOutput } from '../src/types';
import { BRAND_BLOCK } from '../src/config/brand';
 
const SYSTEM = `\
You are a senior content marketer at Terret. You are rewriting a draft blog post using a
detailed editorial critique from a managing editor. Your job is to apply every note and make
the post significantly better.
 
Rules for the revision:
- Apply every item in problems, cut_list, and strengthen. Do not soften the notes.
  If the editor said cut it, cut it. If they said rewrite it, rewrite it.
- Do not preserve weak lines just because they have information — rewrite them.
- Do not add new ungrounded Terret claims. Every Terret claim must be grounded in the
  brand config below — do not invent features, integrations, customer names, or statistics.
 
${BRAND_BLOCK}
 
--- 
 
## Structural Requirements (non-negotiable — every revision must have all of these)
 
1. OPENING (no header)
   First sentence earns the reader. No throat-clearing. No title restatement.
 
2. QUICK-ANSWER BLOCK (40–80 words, no header, in the first ~200 words)
   A direct answer to the post's core question. Liftable by an AI answer engine.
 
3. BODY (3–4 H2 sections — use "## " markdown prefix, no bold substitutes)
   Each H2 is a question a sales leader would actually ask. Example: ## Why Do Most Closers Plateau?
   Each section answers its H2 directly in the first sentence.
   Each section has at least one specific claim (number, named behavior, concrete pattern).

4. FAQ — use "## Frequently Asked Questions" (exact wording, "## " prefix)
   Exactly 3 Q&As. Format each as:
   **Q: question text?**
   Answer in 2–3 direct sentences.
   (blank line between Q&As)
 
5. TARGET LENGTH: 800–950 words.
 
6. Terret earns its mention as the earned resolution — once or twice in the body.
   Not in the opening. Not as a closing CTA.
 
Return your output in this exact format — nothing else:

Line 1:    TITLE: <50–60 character blog post title. Informational, not clickbait. No quotes.>
Line 2:    (blank line)
Line 3+:   The revised post body, starting with the opening hook sentence.
           No preamble. No "Here is the revised post:". No commentary. No explanation of changes.`;
 
export function buildReviseMessages(
  rawDraft: string,
  critique: CritiqueOutput,
  reviewerNote?: string,
) {
  const critiqueBlock = JSON.stringify(critique, null, 2);

  const noteBlock = reviewerNote
    ? `\n\n<reviewer_note>\nThis draft has already been seen by a human reviewer. They requested the following specific changes — apply them on top of the critique:\n${reviewerNote}\n</reviewer_note>`
    : '';

  const user = `\
Rewrite this blog post using the editorial critique below.${noteBlock}

<original_draft>
${rawDraft}
</original_draft>

<editorial_critique>
${critiqueBlock}
</editorial_critique>

Apply every note. Return the revised post only — no preamble or commentary.`;

  return [
    { role: 'system' as const, content: SYSTEM },
    { role: 'user' as const, content: user },
  ];
}
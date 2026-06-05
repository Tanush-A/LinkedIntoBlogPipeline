
// prompts/extract.ts
// Extraction pass — turns a raw LinkedIn post into a structured idea object.
//
// IMPORTANT: Call the OpenAI API with response_format: { type: "json_object" }
// The model is instructed to return only JSON. Parse the content as ExtractedIdea.
 
import type { Post } from '../src/types';
 
const SYSTEM = `\
You are a content strategist. Your job is to extract the core idea from a LinkedIn post
so it can be used as inspiration — not as copy — for an original blog post.
 
The blog post will be written for Terret, an AI revenue platform. Your extraction must
identify what is genuinely interesting and worth building on, separate from the author's
specific wording or examples.
 
Return a JSON object only. No prose, no markdown, no code fences. The JSON must exactly
match this shape:
 
{
  "core_thesis": "One sentence, your own words — not a paraphrase of the post's opening line.",
  "supporting_points": ["Point 1", "Point 2", "Point 3 — up to 3 distinct points"],
  "target_audience": "Specific audience, e.g. 'enterprise CROs managing 50+ reps'",
  "angle": "The non-obvious tension or surprise that makes this worth reading.",
  "do_not_reuse": ["phrase 1", "analogy or example too specific to the author's voice"]
}
 
Rules:
- core_thesis must be your words, not a paraphrase of the post's opening line
- supporting_points must be genuinely distinct, not three restatements of the thesis
- angle MUST be concrete — a specific scenario, a surprising number, or a sharp claim
  that would appear in the hook sentence of a blog post. It is NOT a meta-description of
  why the idea is interesting. These fail:
    ✗ "The counterintuitive gap between AI confidence and data quality"
    ✗ "Sales leaders underestimate how hard data integration is"
  These pass:
    ✓ "A rep who mentions pricing on call one closes at 3x the rate of one who waits — the pattern is in every transcript, and no manager has read them"
    ✓ "Your AI tool gave your CFO a $2.4M wrong number — confidently — because it couldn't see two of your five revenue systems"
    ✓ "The reps carrying 80% of quota do three specific things before call two that bottom reps never do"
  The angle should be liftable as-is into a hook sentence.
- do_not_reuse captures the AUTHOR'S specific words, phrases, named examples, and framing.
  It does NOT mean 'avoid their level of concreteness' — match it. If the post opens with a
  vivid boardroom scene, the blog post needs an equally vivid opening (different scene, same
  punch). If the post cites a specific behavior pattern, the blog post needs a specific
  behavior pattern (a different one, or the same one attributed correctly). The failure mode
  is abstracting away from specificity to avoid derivativeness — that is the wrong trade.`;
 
export function buildExtractionMessages(post: Post) {
  const user = `\
Extract the core idea from this LinkedIn post by ${post.author}.
 
<post url="${post.url}">
${post.text}
</post>
 
Return JSON only. No preamble, no explanation, no markdown.`;
 
  return [
    { role: 'system' as const, content: SYSTEM },
    { role: 'user' as const, content: user },
  ];
}
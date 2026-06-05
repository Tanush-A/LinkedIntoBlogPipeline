// src/config/brand.ts
// Terret brand config — sourced from terret.ai.
// This is the single source of truth for all generation prompts.
// DO NOT invent claims, features, or customer names beyond what is here.
 
export const BRAND = {
  product_name: 'Terret Nexus',
  tagline: 'The Answer-to-Action Engine That Drives Revenue',
 
  /**
   * One-sentence description for inline use.
   */
  one_liner:
    'Terret Nexus is the answer-to-action engine for revenue teams — it finds the root cause of ' +
    'revenue problems and automatically deploys the fix across the entire sales team.',
 
  /**
   * Full positioning for use in generation system prompts.
   */
  positioning: `
Terret Nexus is the Answer-to-Action Engine for revenue teams.
 
WHAT IT DOES:
Terret answers the deep revenue questions no other AI can handle — why win rates are dropping,
where closers are outperforming, which deals are at risk today — then automatically turns those
answers into action: it builds playbooks from winning rep behavior, scripts calls for every rep,
updates the CRM, and delivers real-time briefs 30 minutes before every meeting.
 
THE THREE-STAGE LOOP:
1. ASK — The Revenue Graph unifies every revenue-facing system (calls, deals, CRM, email) and
   surfaces root-cause analysis. Not just "win rates dropped" but "deals where reps quantified
   ROI in the first call closed at 3.1x the rate of feature-led pitches."
2. OPERATIONALIZE — AI agents build the playbook from your top performers and make it ready
   to deploy.
3. ACTIVATE — The playbook deploys to every rep, call briefs update in real time, and the CRM
   stays current automatically.
 
WHO IT'S FOR:
CROs, sales leaders, revenue operations teams, and enterprise AEs at B2B companies.
 
THE CORE PAIN IT SOLVES:
Sales teams have sunk time and money into AI tools and still can't get from "I know what's
wrong" to "it's fixed across 500 reps automatically." Most tools deliver analysis without
action, or automation without insight. Terret closes that loop.
 
THE DIFFERENTIATOR:
It's the only platform that goes from question → root cause → playbook → deployed to every rep
→ real-time call briefs — in one connected system. Other platforms stop at analysis or
automation. Terret does both.
 
PROOF POINTS (use these; do not invent others):
- Customers include Carta, Cloudflare, Grafana, Teradata, Sisense, AuditBoard, Workato, Mistral
- Jeff Perry, CRO at Carta: Terret has become integral to their sales motion; everything works
  together; passed rigorous infosec review
 
PRODUCTS (name only what's relevant):
- Terret Nexus — the main product (Answer-to-Action Engine)
- Terret Forecast — machine-precision pipeline forecasting
- Terret Conversation Intelligence — conversations translated into revenue signals
`.trim(),
 
  /**
   * How Terret earns its mention in a blog post.
   * The product is the earned resolution — not the subject of the post.
   */
  promotion_contract: `
Terret earns its mention by being the answer to the question the post raises.
- Lead with the reader's problem. Deliver real value. Then show Terret as what makes the
  insight automatic at scale — not just useful for the individual who read this article,
  but deployed across the entire team.
- Never open with Terret. Never end with "Terret can help with this."
- The product appears once or twice in the body, as the natural resolution.
- A post that is a product ad with a thin idea on top is the failure mode.
  A genuinely useful piece where Terret is the obvious next step is the goal.
`.trim(),
 
  voice: {
    description: `
Specific and data-dense. Every claim has a number or a name behind it.
Confident, not hypey. Outcome-first. Short declarative paragraphs.
Second person ("you", "your team") where natural. No exclamation marks.
`.trim(),
 
    /**
     * VOICE CADENCE EXAMPLES ONLY.
     *
     * These figures come from Terret's interactive product demo interface — they illustrate
     * what Nexus would surface for a hypothetical customer, not published/verified results.
     *
     * The original garbled version fused two separate demo stats:
     *   - 3.1x belongs to: "deals where reps quantified ROI in the first call vs feature-led"
     *   - "pricing in the first call" has its own separate figure (78% / 2.4x)
     * Combining them produced a third claim that is true of neither. Corrected below.
     *
     * Use these examples to understand voice cadence — the specificity, the sentence
     * structure, the directness. Do NOT reproduce these numbers in published posts as
     * Terret's verified stats. See BRAND_BLOCK for the explicit model instruction.
     */
    positive_examples: [
      'Deals where reps quantified ROI in the first call closed at 3.1x the rate of feature-led pitches.',
      'Three patterns explain the entire gap across 45,000 calls.',
      'Won deals had CFO involvement by meeting 3. Lost deals averaged meeting 7.',
    ],
 
    slop_ban: [
      "In today's fast-paced world",
      'In the ever-evolving landscape of',
      "It's not just X — it's Y",
      'Empty tricolons ("analyze, optimize, and grow")',
      'delve',
      'tapestry',
      'testament to',
      'navigating the complexities of',
      'Em-dash overuse',
      'can help (without a specific claim)',
      'may improve',
      'is a powerful tool that',
      'Any opener that restates the title',
      'Throat-clearing intro paragraphs that say nothing',
      'secret sauce',
      'game-changer / game-changing',
      'unlock (used metaphorically — "unlock potential", "unlock insights")',
      'supercharge',
      'level up',
      'revolutionize',
    ],
  },
} as const;
 
/**
 * Formatted brand block for use in prompt system messages.
 * Import this string directly into prompt builders.
 */
export const BRAND_BLOCK = `
## Terret Brand Config
 
${BRAND.positioning}
 
## Promotion Contract
 
${BRAND.promotion_contract}
 
## Voice
 
${BRAND.voice.description}
 
Positive examples of the target voice — study these for specificity, structure, and cadence:
${BRAND.voice.positive_examples.map((e) => `- "${e}"`).join('\n')}
 
IMPORTANT — these figures are from Terret's product demo interface (illustrative mockups of
what Nexus would surface for a hypothetical customer, not published or verified customer
results). Use them to understand how the voice works. Do NOT reproduce these specific numbers
in a published post as Terret's proven stats. The only verified external endorsement in this
config is the Jeff Perry / Carta testimonial.
 
## Slop Ban-List (never use any of these)
${BRAND.voice.slop_ban.map((s) => `- ${s}`).join('\n')}
 
## Do Not Fabricate
Every Terret claim must be grounded in the brand config above.
Do not invent features, integration names, customer names, or statistics.
If you want to assert something about Terret that is not here, do not assert it.
The specific performance figures in the voice examples above (3.1x, 45,000 calls, meeting
numbers) come from Terret's product demo interface — they illustrate what Nexus would surface
for a hypothetical customer, not published results. Do not present them as Terret's proven
stats in a post. Use them only to understand the voice.
The one verified external claim in this config: Jeff Perry (CRO, Carta) endorses Terret as
integral to their sales motion and notes it passed rigorous infosec review.
`.trim();
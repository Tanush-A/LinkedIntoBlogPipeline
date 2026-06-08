// src/types.ts
// Core domain contracts for the Terret content pipeline.
// All pipeline state flows through these types.

// ---------------------------------------------------------------------------
// Source contract — one LinkedIn post
// ---------------------------------------------------------------------------

export interface Post {
  /** Stable dedup key. Use a hash of the URL or the platform's own post ID. */
  id: string;
  author: string;
  /** Source LinkedIn URL */
  url: string;
  /** Full post body text */
  text: string;
  /** ISO 8601. Optional — seed posts have no reliable date and we do not invent one. */
  posted_at?: string;
  media?: string[];
}

// ---------------------------------------------------------------------------
// Grouping / synthesis contracts
// ---------------------------------------------------------------------------

/** One partition produced by the grouping judge (or seed/groups.json). */
export interface GroupPartition {
  theme: string;
  post_ids: string[];
  /** Judge's confidence this is a coherent group, 0–1. Overrides are 1.0. */
  confidence: number;
}

/** A published piece, passed to pillar drafts for topic-cluster linking. */
export interface PublishedRef {
  title: string;
  cms_url: string;
  source_post_ids: string[];
}

// ---------------------------------------------------------------------------
// Pipeline state — one generated draft
// ---------------------------------------------------------------------------

export type DraftStatus =
  | 'pending'       // draft written, awaiting review
  | 'approved'      // reviewer approved; publish() may proceed
  | 'rejected'      // reviewer rejected; terminal
  | 'needs_edits'   // reviewer requested edits; re-gen triggered or in progress
  | 'failed'        // pipeline error; see logs for run_id
  | 'published';    // publish() succeeded; cms_url set; TERMINAL

export interface Draft {
  /** UUID — pipeline run ID. Stamped in every log line for correlation. */
  id: string;
  /** All source posts synthesized into this draft. n=1 for singletons. */
  source_post_ids: string[];
  /** sha256 of sorted source_post_ids — the dedup key. See src/lib/fingerprint.ts */
  group_fingerprint: string;
  /** Theme name assigned by the grouping judge (or groups.json override). */
  theme?: string;
  status: DraftStatus;
  /**
   * Increments on each needs_edits cycle.
   * Capped at MAX_REVISIONS (env var, default 3).
   */
  revision_count: number;
  /** Populated on needs_edits; injected into re-gen context. */
  reviewer_note?: string;
  /** Output of the extraction pass. */
  extracted_idea?: ExtractedIdea;
  /** Output of the draft pass. */
  raw_draft?: string;
  /** JSON-stringified CritiqueOutput from the critique pass. */
  critique?: string;
  /** Output of the revise pass. This is what gets published. */
  revised_draft?: string;
  /**
   * Set by publish() on success.
   * IMPORTANT: null here is the idempotency guard — publish() checks cms_url == null
   * before calling Hashnode. A non-null cms_url means the post already exists.
   */
  cms_url?: string;
  /** Optional manual rubric scores — for README before/after delta. Not a pipeline step. */
  eval_scores?: EvalScores;
  /** Output of the deterministic verification pass. JSON-stored. */
  verification?: VerificationResult;
  /** Post-publish channel variants (LinkedIn/X/newsletter). Set by repurpose() after publish. JSON-stored. */
  repurposed_content?: RepurposedContent;
  /** ISO 8601 */
  created_at: string;
  /** ISO 8601 */
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Generation pass output shapes
// ---------------------------------------------------------------------------

/**
 * Output of the extraction pass.
 * The generation chain works from this object — not from the raw post text.
 */
export interface ExtractedIdea {
  /** The single most interesting idea worth building on. One sentence. */
  core_thesis: string;
  /** Up to 3 distinct supporting points. */
  supporting_points: string[];
  /** Specific audience who would most benefit — e.g. "enterprise CROs managing 50+ reps" */
  target_audience: string;
  /** The non-obvious tension or insight that makes this worth reading. */
  angle: string;
  /** Phrases or framings too specific to the author's voice to reuse. */
  do_not_reuse: string[];
  tension: string;
}

export interface CritiqueScores {
  hook: number;            // 1–5: does the first sentence earn the reader?
  originality: number;     // 1–5: specific POV, not generic?
  voice_fit: number;       // 1–5: reads like Terret's real team?
  value: number;           // 1–5: reader leaves with something concrete?
  product_integration: number; // 1–5: Terret earned, not bolted on?
  structure: number;       // 1–5: skimmable, logical flow?
  truth: number;           // 1–5: every claim grounded in brand config?
  extractability: number;  // 1–5: AI answer engine could lift a clean answer?
}

export interface CritiqueOutput {
  scores: CritiqueScores;
  overall: number;          // 1–5 composite
  problems: string[];       // specific issues — quote the weak line, explain why it fails
  cut_list: string[];       // sentences or phrases to delete entirely
  strengthen: string[];     // specific things to add, sharpen, or restructure
}

// ---------------------------------------------------------------------------
// Verification pass — deterministic post-generation guardrail
// ---------------------------------------------------------------------------

export interface VerificationResult {
  /** Slop-ban terms found in the draft (case-insensitive, word-boundary matched). */
  bannedTerms: string[];
  /**
   * Numeric/stat claims not grounded in brand.ts as verified facts.
   * Includes demo figures explicitly marked "do NOT reproduce as proven stats."
   */
  ungroundedNumbers: string[];
  /** true iff both lists are empty. */
  passed: boolean;
}

// ---------------------------------------------------------------------------
// Repurposing — post-publish channel variants (generation-layer add)
// ---------------------------------------------------------------------------

/** A distribution channel a published blog post is repurposed into. */
export type RepurposeChannel = 'linkedin' | 'twitter' | 'newsletter';

/** One channel-native variant of a published blog post. */
export interface RepurposedVariant {
  channel: RepurposeChannel;
  /** Human label for the Slack section, e.g. "LinkedIn post". */
  label: string;
  /** Channel-ready copy. For Twitter this is the numbered thread, joined. Always ends with the cms_url. */
  text: string;
  /** Same deterministic guardrail the blog runs — slop terms + ungrounded figures, surfaced not blocking. */
  verification: VerificationResult;
}

/**
 * The full repurposing artifact stored on the Draft row (JSON column).
 * Generated AFTER a successful publish; never affects publish state.
 */
export interface RepurposedContent {
  /** Reference back to the originating draft. */
  draft_id: string;
  /** The published blog URL every variant links to. */
  cms_url: string;
  /** Title of the published blog post the variants promote. */
  blog_title: string;
  /** ISO 8601 — when the variants were generated. */
  generated_at: string;
  /** One per channel (LinkedIn, Twitter/X, newsletter). */
  variants: RepurposedVariant[];
}

// ---------------------------------------------------------------------------
// Manual output evaluation — README artifact only, not a pipeline step
// ---------------------------------------------------------------------------

export interface EvalScores {
  /** Scores on the raw first draft (before critique/revise) */
  pre_revision: CritiqueScores;
  /** Scores on the final revised draft */
  post_revision: CritiqueScores;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Structured log entry
// ---------------------------------------------------------------------------

export interface LogEntry {
  run_id: string;
  step: string;
  status: 'ok' | 'error' | 'skip';
  timestamp: string; // ISO 8601
  error?: string;
  meta?: Record<string, unknown>;
}

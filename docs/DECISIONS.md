# Decision Log

Decisions are recorded in reverse chronological order.

---

## [2026-06-07] Repurposing (blog → LinkedIn / X / newsletter) — scoped and cut for time

**Status:** Accepted (map, not build) — the fastest future add

**Context:**
A natural extension of the pipeline is to fan the published blog post back out into
channel-native variants (a LinkedIn post, an X thread, a newsletter blurb), each linking back
to the canonical article. It is on the roadmap and the `upcoming: repurposing` todos in
`tests/publish.test.ts` are its placeholders. It was cut from this build for time.

**Decision:**
- **Cut now; documented as the single fastest future add.** This is a **generation-layer
  addition only** — there is no architectural risk, which is exactly why it is the cheapest
  thing to add next.
- **Where it slots in:** one post-publish step, triggered by the publish event — i.e. right
  after `publish()` sets `status='published'` and persists `cms_url` (the existing terminal
  transition). It does not touch the gate, the state machine, or the ingestion/grouping path.
- **What it reuses, unchanged:** the same OpenAI model and prompt-builder pattern as the
  existing passes, and the same deterministic `verifyDraft` guardrail (slop-ban + ungrounded-
  figure checks) on every variant before it is stored. Each variant embeds the published
  `cms_url` as its canonical back-link and is stored with a reference to the originating draft
  id — no schema migration (a `repurposed_variants` row or a JSON column references
  `draft.id`; reuse the existing JSON-column pattern).
- **Human gate:** variants are drafts too — they go through the same review surface before
  anything posts to a channel. Nothing auto-publishes to LinkedIn/X.

**Why it is low-risk (the case for "fastest add"):**
- No new gate states, no new idempotency model (key off `draft.id` + variant channel),
  no new external ingestion surface. The only new external write targets (LinkedIn/X/
  newsletter APIs) sit behind the SAME human-approval gate the blog publish already uses.
- It is additive and independently demonstrable: the core loop (raw signal → grouped synthesis
  → human gate → published artifact) is complete and defensible without it.

**Rejected / deferred alternatives:**
- Building it now — pure time trade; it earns nothing the core loop does not already prove,
  and the generation + verification machinery it needs already exists.
- Auto-posting variants without review — violates the project's non-negotiable ("nothing
  publishes without approval"); variants must pass the same gate.

**Consequences:**
- `tests/publish.test.ts` keeps the three `upcoming: repurposing` todos as the spec for the
  add (trigger on publish → N variants; each variant body contains the `cms_url`; variants
  stored with a reference to the original draft id).

---

## [2026-06-06] Stage 8 — Fully-automatic ingestion via LinkdAPI (live source mode)

**Status:** Accepted

**Context:**
Until now ingestion read a hand-curated `seed/posts.json`. Stage 8 adds a live source: poll
Justin Shriber's LinkedIn posts through LinkdAPI (an unofficial scraper), map them onto the
existing `Post` contract, and let new posts flow through the same 1:1 + judge pipeline with no
downstream change. The contract is the seam.

**Decisions:**

- **Fully-automatic ingestion over an editorial paste-a-URL flow.** The product is "raw signal →
  published artifact, human in the loop." A human pasting each post URL is neither fully automatic
  (defeats the agentic premise) nor editorial (the human gate is already downstream, at approval).
  Rejected paste-a-URL as falling between the two stools. The reviewer's judgment belongs at the
  draft gate, not at ingestion; ingestion should be hands-off and continuous.

- **`SOURCE_MODE` = `seed` (default) | `live`.** The demo must never depend on a third-party
  scraper being up. `seed` is the deterministic fallback AND the test fixture; `live` is the
  LinkdAPI path. Same code below the `Post` contract. `npm run pipeline` stays seed; `npm run
  poll` / `npm run watch` default to live.

- **Unofficial-API ToS/enforcement risk is real and acknowledged.** LinkdAPI scrapes LinkedIn,
  which violates LinkedIn's ToS; the endpoint can break or get blocked without notice. This is
  acceptable for a demo on public posts of a consenting subject, but is NOT the production design.
  **Production = authorized access to the CEO's OWN content** — his LinkedIn OAuth token or a
  data export. The `Post` contract and `src/ingest/*` adapter boundary mean swapping LinkdAPI for
  an authorized source is a single-file change. The `seed` fallback is the standing insurance if
  the scraper dies mid-demo.

- **Polling, not webhooks.** LinkedIn offers no post-publish webhook, so there is nothing to
  subscribe to — the only option is to poll. `POLL_INTERVAL_MINUTES` defaults to 60 (trial credits
  are finite; CEO post cadence is hours/days, not seconds). `npm run poll` is a one-shot for the
  demo; `npm run watch` loops with a reentrancy guard.

- **Triage is the THIRD quality control.** Source quality gates output quality, so curation must
  be automated when ingestion is. Three independent gates now stack, each catching what the
  others cannot: (1) **ingestion triage** — deterministic prefilters + a judge skip list drop
  non-text/thin/promotional posts before they cost a generation; (2) the **rescore loop** —
  iterates draft quality to overall ≥4; (3) the **human gate** — nothing publishes without
  approval. A deterministic prefilter cannot tell "thin promo" from "sharp argument" (the judge
  can); the judge cannot guarantee draft quality (the rescore loop does); neither can be trusted
  to publish (the human does). False discards are mitigated by logging every skip with a reason
  and by `seed/groups.json`, which force-includes a post regardless of triage (recovery path).

- **Deterministic prefilter signals (from the live response schema).** `resharedPostContent != null`
  or a `header` "reposted" annotation → reshare; `mediaContent` present with no substantive text →
  media-only; text < `MIN_POST_CHARS` (default 400) → too-short (this also catches polls and
  one-liners — the API exposes no poll type). Each skip is logged with its reason.

- **`/posts/all` omits text for ~1/3 of real posts — backfill from `/posts/info`.** Discovered
  live: the listing endpoint returned empty `text` for 34/100 posts, including known substantial
  text posts (the full text lives in the per-post detail endpoint). Discarding them as "too-short"
  would silently drop a third of real content. Mitigation: `BACKFILL_POST_TEXT` (default on)
  fetches `/posts/info` for NEW, non-reshare, thin-listing posts before triage. Bounded to new
  posts (steady-state polling backfills ~0–2/cycle); `MAX_POSTS_PER_CYCLE` caps the cold-start
  burst. Known limitation documented; `groups.json` is the manual recovery for anything still missed.

- **Backfill rate limiting: defer, never misclassify.** The Testing tier caps `/posts/info` at
  ~7 req/min; an unthrottled backfill loop trips a 429, loses the text, and the post would then
  be wrongly discarded as "too-short" — conflating "genuinely short" with "not yet fetched."
  Fix: (a) throttle backfill calls (`BACKFILL_THROTTLE_MS`, default 9000 ≈ under 7/min); (b) cap
  calls per cycle (`BACKFILL_MAX`, default 5); (c) one 429 retry honoring `Retry-After` before
  giving up. Crucially (d) a post whose full text could NOT be recovered (rate-limited, error,
  or cap reached) is **deferred** — not persisted (neither active nor discarded), logged
  distinctly, and left unknown so it is re-fetched next cycle. "too-short" is only assigned when
  the text is authoritative (listing already long enough, or backfill returned). This keeps the
  prefilter honest: it discards on what a post IS, never on what we failed to fetch.

- **Discarded posts persist (`status='discarded'` + `discard_reason`) and join the dedup set.**
  A triaged-out post is kept in the posts table so it is never re-judged (dedup =
  drafted ∪ discarded) and stays resolvable for roll-ups, with its reason auditable. `id =
  SHA-256-of-normalized-URL` (shared `src/lib/postId.ts`, same recipe as the seed builder).
  Consequence: seed URLs (`/posts/..._activity-N`) and live URLs (`/feed/update/...activity:N`)
  hash differently, so the same logical post has different ids across modes — fine, since one
  `SOURCE_MODE` runs per deployment and dedup is airtight within a mode.

- **Cross-process status via a `meta` table; `MAX_DRAFTS_PER_CYCLE` for cost.** The watcher
  (separate process) writes its last-poll result to `meta`; the always-on server reads it at
  `GET /status` (mirrors the existing Run A/Run B split). `MAX_DRAFTS_PER_CYCLE` caps generation
  per cycle — guards both finite credits and a first-poll Slack burst (one cold feed → dozens of
  pings). Capped-but-ungenerated partitions stay active and surface next cycle (intentional;
  discards persist independent of the cap). API error / quota-exhaustion (detected off the
  `{success:false}` envelope, not just HTTP status) → log, record, skip cycle, never crash.

- **Triage applies in both modes; seed discards are intentionally NOT sticky.** The judge skip
  list can fire in `seed` mode too (empty in practice for the curated seed). `syncSeedToDb` upserts
  every seed row each run and resets `status` to `active` by design — so a judge-discarded SEED
  post is re-judged next `npm run pipeline` (no duplicate draft, since it was never drafted). In
  `live` mode discards ARE sticky: ingest skips known ids and never re-upserts a discarded post.
  The watcher defaults to bounded `MAX_POSTS_PER_CYCLE`/`MAX_DRAFTS_PER_CYCLE` so a bare
  `npm run poll` against a cold feed cannot burst the full history through generation at once.

---

## [2026-06-06] Stage 7 — Batch many:1 synthesis with automated grouping

**Status:** Accepted (supersedes the [2026-06-04] 1:1-cardinality decision below)

**Context:**
1:1 (one LinkedIn post → one blog) published redundant pieces: 3 of 8 seed posts share the
"unify your revenue data" thesis, so 1:1 ships 3 near-duplicate blogs. A real marketing team
writes one pillar piece from a theme. This stage adds a grouping judge that partitions each
batch into theme groups (n≥2 → one pillar draft) and singletons (n=1 → the existing 1:1 draft).
1:1 is now the n=1 case of the same code path — nothing about the gate, publish, or idempotency
guarantees changed.

**Decisions:**

- **Batch partition over per-arrival streaming.** One judge call sees the WHOLE batch and
  partitions it at once, rather than judging each post against the registry as it arrives.
  Why: (1) it matches the real ingestion cadence — posts are polled in batches, not streamed
  one-at-a-time; (2) a single judge call with the whole batch in context makes globally coherent
  grouping decisions a per-arrival judge can't (it would commit to a singleton before seeing the
  post that should have grouped with it); (3) it collapses the redundant "1:1 draft now, pillar
  draft later" noise within a batch into one decision. Rejected: per-arrival streaming with a
  sliding window + periodic consolidation pass — that is the production evolution (mapped in
  SPEC §13), and the fingerprint model already supports it (attachment = new fingerprint =
  roll-up), but it is not needed at batch/demo cadence and adds windowing state.

- **Auto-act on the judge's grouping; the human gate catches false positives.** The judge groups
  and the pipeline generates ONE draft per partition without a human confirming the grouping
  first. Why: the existing non-negotiable ("nothing publishes without approval") already puts a
  human in front of every pillar draft — a bad group surfaces as an incoherent draft the reviewer
  rejects, exactly like any other weak draft. Adding a separate "approve the grouping" step would
  double the human touchpoints for no extra safety. A confidence floor (default 0.6) splits
  weak groups back into singletons before they ever reach generation. Rejected: a human grouping-
  approval gate before generation (redundant with the content gate).

- **Group identity = sha256 of sorted member ids; idempotency keys on it.** `group_fingerprint`
  replaces per-post dedup. Re-running the same batch produces the same fingerprints → existing
  drafts → no-ops (exactly like the old per-`source_post_id` dedup). A later batch that attaches
  a new post to a prior theme produces a partition with changed membership → a NEW fingerprint →
  a new roll-up draft. The old draft (possibly already published) is immutable and left intact;
  the roll-up complements it. Rejected: mutable groups (a published draft would have to be
  re-opened and re-gated — breaks draft immutability and the terminal-`published` guarantee).

- **Rejected: embedding-threshold grouping.** Clustering by cosine similarity over post
  embeddings with a fixed distance threshold was rejected as the grouping mechanism. Why: a
  similarity threshold groups on surface topic overlap ("both mention AI") — it cannot tell a
  coherent shared *thesis* (groupable into one argument) from two posts that merely share
  vocabulary (not groupable). The judge reasons about editorial coherence, which is the actual
  grouping criterion. Embeddings remain the right PRODUCTION PREFILTER (cluster candidates →
  judge confirms/labels only the candidates, cutting judge tokens ~10x and scaling past context
  limits) — mapped in SPEC §13, not built; at seed scale one judge call sees the whole batch.

- **Judge is untrusted input: deterministic validation, fail-open to singletons.** The judge's
  JSON is re-validated in code — every new post id must be covered exactly once; partitions with
  an unknown id, a duplicated id, or only existing-member ids are dropped and their NEW ids
  re-covered as singletons; groups below the confidence floor are split (re-covering NEW ids only
  — existing members simply drop out, never minting a draft for a post that existed only inside a
  prior group). ANY judge failure (API error, unparseable JSON) falls open to all-singletons.
  Generation is never blocked by grouping.

- **Legacy `source_post_id` column kept and compat-written.** Reads go exclusively through the
  new `source_post_ids` JSON array; the legacy NOT-NULL column on existing DBs is written
  `source_post_ids[0]` on insert so old databases don't reject the row. A JS backfill at startup
  fills `source_post_ids`/`group_fingerprint` for pre-existing rows (ALTER TABLE can't add NOT
  NULL columns without a default). A full table rebuild is the clean production migration —
  documented, not built (acceptable for SQLite at this scale).

- **Canonical posts table; seed file is just a source that feeds it.** `posts` (id, url, author,
  text, posted_at, ingested_at) is the canonical post store. Ingest upserts every post it sees;
  `loadPosts` and the judge's existing-theme member summaries read from the table, not the seed
  file. Why: live ingestion lands next session and needs this seam — the seed file becomes one
  feeder among many. Migration: the seed is upserted into the table on startup/ingest.

- **`splitTitleAndBody` moved to `src/lib/text.ts`.** `db.getPublishedRefs` needs the title and
  `publish.ts` needs the same splitter; importing it from publish into db is a circular
  dependency. A pure text module both import is the clean seam.

- **Self-canonical cluster linking.** Every piece stays self-canonical (dev.to default). The
  topic-cluster signal is the internal links themselves: a pillar draft receives the
  `PublishedRef`s whose source posts overlap its partition and links DOWN to them as deeper dives.
  Spoke→pillar back-links are a future edit (mapped, not built).

---

- [2026-06-05] Decision: swap generation chain from GPT-4o to GPT-5.5; make model env-configurable.
  Chose: `OPENAI_MODEL=gpt-5.5` (flagship, verified via GET /v1/models; `gpt-5.5-2026-04-23` is the
  dated pin) for draft/critique/revise; `OPENAI_MODEL_EXTRACT=gpt-5.4-mini` for the extract pass
  (simple structured JSON extraction doesn't need the flagship). Both default to these values if
  env vars are absent. GPT-4o was the original choice during Stage 2; model deprecation is a real
  operational dependency — production systems that hardcode a model string require a code change
  per upgrade; env-configurable swaps take only a config change.
  API change: gpt-5.x does not accept `max_tokens` — changed to `max_completion_tokens` everywhere.
  `response_format: { type: 'json_object' }` and response shape are unchanged.
  Rejected: gpt-5.4 — gpt-5.5 (2026-04-23) is the newer, higher-capability release confirmed
  available on this key. Rejected: gpt-5.5-pro — pro variant is disproportionate cost for
  text-only essay generation; flagship is sufficient.

- [2026-06-05] Decision: pass PRODUCT_CONTEXT_BLOCK to buildDraftMessages as third argument.
  Chose: import PRODUCT_CONTEXT_BLOCK in generate.ts and thread it through to buildDraftMessages(post, extracted, PRODUCT_CONTEXT_BLOCK). The function signature already required a third parameter — the call site was the gap.
  Rejected: reading product_context directly from BRAND.product_context in generate.ts — PRODUCT_CONTEXT_BLOCK is the canonical formatted export and the prompt expects that wrapper text.

- [2026-06-05] Decision: raise max_tokens to 4000 on draft and all revise calls.
  Chose: max_tokens: 4000 on draft pass, Pass 4 revise pass, and re-revise in rescore loop. Target 1,200–1,800 words ≈ 1,800–2,700 output tokens; previous default was likely 1,024 or unlimit-but-shared-budget, both risky for truncation.
  Rejected: only setting it on the first revise pass — the re-revise in the rescore loop is the same task and must not truncate either.

- [2026-06-05] Decision: TITLE parsing confirmed intact, no changes needed.
  Chose: leave publish.ts splitTitleAndBody() and approval.ts TITLE: extraction untouched. The revise prompt still emits "TITLE: <title>\n\n<body>"; both parsers handle it correctly. publish.test.ts exercises the TITLE: path end-to-end — no additional unit test added.
  Rejected: extracting splitTitleAndBody into a shared utility — premature; only two call sites, both stable.

- [2026-06-05] Decision: doc sync — no stale references found.
  Chose: no edits to SPEC.md or CLAUDE.md. Neither file contained "800–950 words" or "question-template structure" references; the doc sync instruction described a condition that does not exist in the current files.
  Rejected: adding the new essay design description as new prose — docs are not yet stale, so adding would create duplication risk.

- [2026-06-05] Decision: source-post figures are grounded; demo figures are not, even in source.
  Chose: `verifyDraft(draftText, sourcePosts: string[] = [])` — figures present in the source
  post text(s) are added to the grounding corpus so the draft can cite a number the original
  author stated without triggering a false-positive flag. Ordering: (1) demo-check first and
  unconditional — 3.1x flags even if the source post cites it, because a source post citing a
  Terret demo figure does not license repeating it as a proven stat; (2) brand config or source
  corpus → grounded; (3) otherwise → default-deny.
  `run.ts` confirmed as a non-call-site: it calls `generate(post)` which handles verification
  internally. No run.ts change required.
  Rejected: extending the source-post rescue to demo figures — the whole purpose of DEMO_FIGURES
  is that those numbers must not appear as facts regardless of context.

- [2026-06-05] Decision: product_context added to brand.ts; scoped to draft pass only.
  Chose: a stat-free, analytically-written product_context field describing the problem
  narrative, the three-stage mechanical loop, integrations, five named use cases, and target
  persona — in neutral prose, not marketing copy. Exported as PRODUCT_CONTEXT_BLOCK and added
  to prompts/draft.ts only (not BRAND_BLOCK, which would feed critique and revise prompts).
  Source: terret.ai homepage (June 2026). /product and /solutions returned 404 — the site
  appears to be single-page. No numeric stats added: every figure on the site appears inside
  the interactive product demo ("what Nexus would surface for your data") — the same context as
  the positive_examples figures already marked do-not-reproduce. Adding any site figure to
  brand.ts would enter it into ALL_BRAND_STATS and silently disable the verify.ts guard for
  that figure.
  Added one exemplar paragraph to draft.ts anchoring the target analytical register (not
  LinkedIn voice): dense, specific, no hype, no demo figures.
  Rejected: adding product_context to BRAND_BLOCK — increases token cost for critique and
  revise prompts with no corresponding benefit; those passes need brand voice rules, not
  product substance.

- [2026-06-05] Decision: re-score loop — quality as a convergent loop, best-of retained.
  Chose: after the initial revise pass, run critique→revise iterations until `overall ≥ 4`
  or `RESCORE_CAP` iterations (new env var, default 3). Track the highest-scoring draft and
  return that — not the last — so a revision that makes things worse does not ship.
  `critique` on the DB row is updated to reflect the best draft's critique, keeping it
  coherent with `revised_draft` for future regeneration passes.
  Rejected: (A) single extra critique pass with no loop — a draft can score 3 and improve
  on a second pass; one-and-done would leave that iteration on the table; (B) reusing
  `MAX_REVISIONS` for the rescore cap — `MAX_REVISIONS` is a human governance setting;
  `RESCORE_CAP` is an automated quality gate; conflating them would let a reviewer run
  out of edits because the pipeline used up the shared budget; (C) blocking on overall < 4
  indefinitely — a hard block on quality score would stall the pipeline if the LLM
  consistently grades below threshold; the cap is the escape valve.
  Why: critique is probabilistic; a single pass can miss issues a second critique catches.
  The loop closes the gap between first-try quality and iterated quality without human cost.
  Judgment call (surfaced per CLAUDE.md): "Verify on one seed post: the log shows the score
  improving across iterations." This requires a live OpenAI run. The mocked tests
  ([3,3,4]→9 calls, final=v3; [4]→5 calls, no extra revise; [3,1]→7 calls, v1 retained
  over worse v2) demonstrate the convergence logic deterministically. A live run is a
  manual pre-demo step: set OPENAI_API_KEY and run `npm run pipeline` — the
  `[generate] rescore  post=... iter=N/3 overall=M` log lines show convergence.
  Not treating a live API run as a test-suite artifact.

- [2026-06-05] Decision: verification layer design — deterministic guardrails, surfaced not hard-blocking.
  Chose: `verifyDraft(draftText: string)` runs after every revise pass (generate.ts and regenerate.ts),
  persists `VerificationResult` on the draft row, and renders the result on the review page.
  Rejected: (A) LLM-based re-scoring as the primary guardrail — probabilistic, adds latency and cost,
  would undermine the principle that the gate is deterministic and auditable; (B) hard-blocking publish
  when `passed: false` — removes the human from the loop; a reviewer may knowingly approve a draft that
  uses a demo figure with proper editorial context. The gate non-negotiable ("nothing publishes without
  approval") already guarantees a human sees every issue. (C) taking a `Draft` object rather than a
  `draftText: string` — verification runs before the DB row exists (inside generate.ts), so the object
  is not available at call time; a string input keeps the function pure and dependency-free.
  Why: prompt instructions are probabilistic; any LLM may produce a slop term or cite a demo figure
  despite explicit instructions. Deterministic checks at the output boundary catch these regardless
  of model behavior. Surfacing to the human rather than auto-blocking keeps the reviewer in control
  and avoids false-positive blocks on legitimate uses of flagged patterns.

---

- [2026-06-05] Stage 6 — `DEVTO_DRAFT_MODE` env not picked up by running server. Chose: update article via dev.to PUT API (no pipeline re-run). Rejected: killing and re-running the pipeline (wasteful API spend, creates duplicate draft). Why: `dotenv/config` loads once at process start; a running server does not see `.env` changes. Fix: always restart approval server after `.env` edits, or set env vars in the shell before starting.

- [2026-06-05] Stage 6 — `splitTitleAndBody` TITLE: check not matching in running server. Chose: fix title via PUT to dev.to API. Rejected: restarting server mid-demo (unnecessary friction for the live example). Why: the approval server (PID 7586) loaded an older version of `publish.ts` (the file has uncommitted changes — `M src/pipeline/publish.ts` in git status). The compiled-at-startup code lacked the TITLE: stripping. Fix: commit pending changes to publish.ts before starting the server.

- [2026-06-04] Decision: post→blog mapping cardinality. Chose: 1:1 (one LinkedIn post → one blog).
  **[SUPERSEDED 2026-06-06 — batch many:1 synthesis shipped; see the Stage 7 block at the top of
  this log. 1:1 is now the n=1 case of the synthesis design, not a separate mode.]**
  Rejected: many:1 theme-synthesis (cluster related posts → one pillar post). Why: 1:1 gives a
  clean, idempotent, demonstrable loop and was buildable in the time available. Synthesis is the
  better product — a real marketing team writes pillar pieces from a theme, not a blog per post —
  but needs a clustering step, a multi-post synthesis pass, and a 1:many Draft↔Post model.
  Evidence it matters: 3 of 5 seed posts share the "unify your data" thesis, so 1:1 would publish
  3 redundant blogs. Scoped as the #1 production upgrade.

## [2026-06-04] Stage 5 — Deferred hardening (map-not-build)

**Status:** Accepted

**Context:**
Stage 5 was scoped as "minimal hardening only" in CLAUDE.md. At demo scale — single pipeline
run, single reviewer, localhost server — the cost of building these items exceeds the risk they
mitigate. Each is documented below with what would be added in production and why it wasn't built
now. What already exists: run-ID stamped on every log line; `failed` status re-exposes the
Approve button so any transient publish error has a manual retry path without DB surgery.

**Deferred items:**

- **Automatic retries + backoff (`p-retry`):** wrap each of the five API calls (extract, draft,
  critique, revise, dev.to publish) with p-retry (max 3 attempts, 1 s → 2 s → 4 s backoff);
  transient network errors currently fail the draft permanently and require a human re-approve
  click. Already mapped in SPEC §8. Manual retry via `failed`→Approve covers the demo case.

- **Observability / alerting:** add a structured log transport (stdout lines exist; add Datadog/
  Loki/CloudWatch sink) and alert on `status: failed` rows older than N minutes; currently a
  failed draft is silent until a human checks the review page.

- **Auth-token refresh:** rotate `OPENAI_API_KEY`, `SLACK_WEBHOOK_URL`, and `DEVTO_API_KEY` via
  a secrets manager (AWS Secrets Manager, Doppler) with automatic reload on expiry; env-var
  tokens are fine for a demo timeline but will expire silently in production.

- **Rate-limit handling:** dev.to and OpenAI both rate-limit; a burst of posts in quick
  succession (live ingestion mode) will hit 429s that p-retry alone won't absorb — add a token
  bucket or queue with per-minute backpressure. No issue at seed/demo scale (one post at a time).

- **Scale / scheduling:** fan-out to a queue (BullMQ, SQS) and a cron trigger (node-cron,
  GitHub Actions) when live ingestion lands; current manual-trigger model is correct for demo
  but doesn't scale past a handful of posts per day.

- **Unauthenticated approval endpoint:** anyone who can reach `GET /review/:draftId` can approve
  and publish; add a secret token in the URL path or HTTP Basic Auth before exposing via ngrok
  or any public tunnel. Localhost is acceptable for the submission live example — production
  deployment is not.

**Fix first (single highest priority):**
The unauthenticated approval endpoint. Every other item on this list is a reliability or
operational concern — recoverable. An open approval URL lets anyone who discovers the link
publish content under the brand without the reviewer's knowledge. The fix is two lines (compare
a path token from env; return 401 if absent). It becomes load-bearing the moment ngrok is
running.

---

## [2026-06-04] Stage 3 — Full Gate Decisions

**Status:** Accepted

**Context:**
Building the request-edits gate: reviewer submits a note → background re-gen → re-notify → loop or cap → reject path.

**Decisions:**

- **Re-gen scope: revise-only (Pass 4).** Only the revise pass re-runs; extract/draft/critique passes are unchanged. Reviewer notes are editorial ("make section 2 shorter", "add a specific metric") — they target the output text, not the idea. Re-running extract+draft would re-spend 3 API calls to produce the same idea and risk drifting content the reviewer didn't ask to change. Rejected: full 4-pass re-gen (over-broad for a targeted editorial note; reserved for "wrong angle" cases which can be handled by rejecting and running the pipeline on a different post).

- **Accumulate mode: re-gen works from previous `revised_draft`.** Each revision builds on the last. Rationale: iterative editing is natural — "round 2: make this shorter" shouldn't undo "round 1: sharpen the hook". Rejected: reset to `raw_draft` each round (loses round 1 edits; the reviewer would re-review a regressed draft).

- **Increment revision_count on success only.** A failed re-gen doesn't burn a revision slot — the reviewer can retry immediately without consuming cap. Rejected: increment-on-click (punishes transient API errors with permanent cap consumption).

- **`regenerate.ts` is self-contained; approval handler fire-and-forgets.** The HTTP response (202) returns before the OpenAI call. `regenerate()` catches its own errors internally and writes `status: needs_edits` + prefixed error note on failure — it never throws to the caller. The `.catch()` in the handler is a last-resort logger only.

- **Failure reverts to `needs_edits`, not `failed`.** `needs_edits` means "re-gen triggered but not complete" — an error mid-re-gen leaves the draft in the same logical state: awaiting a successful revision. `failed` is reserved for publish errors (not generation errors) per the existing gate logic. The reviewer sees the error prefix in `reviewer_note` and can try again.

- **Cap enforced server-side at POST handler time.** Client-side hiding of the Request Edits button is UI convenience only, not the guard. The 400 is the authoritative rejection.

- **Reviewer note required (non-empty).** An empty note would inject a blank `<reviewer_note>` block into the revise pass — meaningless context. HTML `required` attribute enforces non-empty in the browser; server trims + checks for empty string for defense in depth.

**Consequences:**
- The gate loop: `needs_edits` → re-gen → `pending` → reviewer clicks approve/reject/request-edits again.
- `revision_count` is a success counter, not an attempt counter. MAX_REVISIONS=3 means 3 successful re-gen cycles before the cap fires.
- `reviewer_note` is overloaded: shows the latest editorial note OR a `[Re-gen failed]` prefix on error. UI renders it in both cases; the prefix makes failures distinguishable.

---

## [2026-06-04] Generation prompts locked at Stage 2 baseline

**Status:** Accepted

**Context:**
Two tuning rounds were run against three seed posts (board-meeting, closer-DNA, post-mortems) to
raise the critique ceiling from its initial 2/5 overall. After Round 2 the floor is 3/5 overall
on all three posts and the primary regressions (closer-DNA voice_fit, product_integration bolted-on
pattern) are resolved. Eval outputs are in `docs/eval/<post-id>.md`.

**Decision:**
- **Generation prompts (extract.ts, draft.ts, brand.ts slop_ban) are locked at this baseline.**
  No further prompt tuning in Stage 3 infra build. Changes are:
  - `extract.ts`: `angle` must be a concrete hook-ready claim (specific scenario / number / sharp
    claim), not a meta-description of the idea. `do_not_reuse` clarified: avoid the author's exact
    words, not their level of concreteness — match it.
  - `draft.ts`: opening instruction is now "concrete AND on-voice" with explicit hype fail examples.
    Product integration instruction now requires Terret to emerge from the argument (develop problem
    → reach natural "how at scale" question → answer with specific mechanism). Includes good/bad
    integration examples.
  - `brand.ts`: hype phrases added to slop_ban: "secret sauce", "game-changer/game-changing",
    "unlock (metaphorical)", "supercharge", "level up", "revolutionize".
- **Originality push (ceiling still at 3/5) is deferred.**
  Rejected: further prompt iteration now. Originality requires a contrarian angle in extraction and
  a willingness to take a position in the draft — harder to engineer prompt-side without risking
  voice or truth regressions. Deferred to a dedicated quality pass in Phase 4, done against the live
  rendered dev.to output where the full post can be evaluated as a reader would see it.

**Consequences:**
- Stage 3 infra build starts from a stable generation layer producing 3/5 overall across source posts.
- The originality debt is known and tracked; it ships as a Phase 4 item.
- `docs/eval/<post-id>.md` files are the baseline for the Phase 4 before/after delta.

---

## [2026-06-04] CMS switch: Hashnode → dev.to

**Status:** Accepted

**Context:**
Hashnode's GraphQL API (`gql.hashnode.com`) moved all access behind a paid Pro plan; every request returns HTTP 301 → `https://hashnode.com/announcements/graphql-api` at the Cloudflare layer before the GraphQL server sees the payload. The Stage 1 live-publish checkpoint could not close.

**Decision:**
- **Switched publish target to dev.to REST API** (`POST https://dev.to/api/articles`). Rejected: paying for Hashnode Pro (unnecessary cost for a demo; same CMS outcome); Ghost self-hosted (adds infra; not needed at this scale). Dev.to is free, has a clean REST API, and produces a real public URL.
- **Auth header: `api-key: <DEVTO_API_KEY>` (NOT `Authorization: Bearer`).** Dev.to uses its own header name; Bearer would return 401.
- **Tags: plain lowercase alphanumeric string array, max 4.** Opposite of Hashnode's `{ name, slug }` objects. Fifth tag is silently dropped. Stage 1 uses static tags `["sales", "revenue", "ai", "saas"]`; dynamic tags from content are Stage 4.
- **No publication ID.** Dev.to posts go to the authenticated user's account. `HASHNODE_PUBLICATION_ID` removed from env; `DEVTO_API_KEY` added.
- **`canonical_url` field (not `originalArticleURL`).** Field name differs from Hashnode. Left null for Stage 1; set in Stage 4 full field mapping.
- **Slug auto-derived from title.** Dev.to derives it; setting slug directly is not supported.

**Consequences:**
- `src/pipeline/publish.ts` is a clean REST POST, no GraphQL mutation.
- `CLAUDE.md` stack table, env vars, and Build Gotchas updated to reflect dev.to rules.
- `SPEC.md` §7 publish field mapping updated.
- Stage 1 live-publish loop now closeable once `DEVTO_API_KEY` is in `.env`.

---

## [2026-06-04] Stage 2 — Real Generation Chain

**Status:** Accepted

**Context:**
Replacing the Stage 1 stub `generate()` with the real 4-pass GPT-4o chain (extract → draft → critique → revise). Several storage and sequencing decisions required resolution.

**Decisions:**

- **`openai` npm package installed; no `p-retry` yet.** `p-retry` is Stage 5. Installing it in Stage 2 would violate "one stage at a time" and add code paths that aren't exercised. Rejected: wrapping calls in manual try/retry (non-trivial; wait for the dedicated hardening stage).

- **OpenAI client instantiated inside `generate()`, not at module top.** `dotenv/config` runs in `run.ts` before `generate()` is called; instantiating at import time risks capturing an empty `OPENAI_API_KEY`. Inside the function body, the env is guaranteed loaded by the time the client is constructed.

- **`extracted_idea` passed as object to `insertDraft`; `critique` passed as stringified string.** `db.ts` `JSON_COLUMNS` includes `extracted_idea` (auto-serialized) but not `critique` (stored verbatim). Passing an object for `critique` would throw at bind time; pre-stringifying `extracted_idea` would double-encode it on write and leave a raw string after round-trip. The type boundary is enforced: `ExtractedIdea` object → `insertDraft`, `JSON.stringify(critiqueObj)` → `insertDraft`.

- **Single in-memory `critiqueObj` used for both revise pass and db storage.** Parse once from the API response string → object; pass to `buildReviseMessages`; re-stringify for db. Rejected: reading back from DB between passes (extra round-trip, adds failure surface, no benefit in a single sequential run).

- **`GenerateResult` extended to carry all four pass outputs.** `run.ts` persists `extracted_idea`, `raw_draft`, `critique`, and `revised_draft` on the initial `insertDraft` call. Stage 1 only stored `revised_draft` — the other three fields were unfilled and would have been inaccessible for the re-gen context in Stage 3. Fixed here.

- **Verification via `scripts/scratch-generate.ts` (not `npm run pipeline`).** Running the pipeline entry point would fire Slack for every new post. The scratch script runs `generate()` + `insertDraft` + `getDraft` in isolation, prints critique scores, and asserts the round-trip invariants (extracted_idea is object, critique is parseable string). The existing `scratch-db` pattern was the model.

**Consequences:**
- The 4-pass chain is live. One seed post produces a real `revised_draft` with no slop-ban violations and no Terret claims outside `brand.ts`.
- Critique overall score was 2/5 on first run — the revise pass improved hook and structure but the angle remained generic. Quality iteration is Stage 3+ (reviewer note injection). The pipeline architecture is sound.
- `run.ts` now stores all four pass outputs; Stage 3 re-gen has the raw_draft and critique it needs for context injection.

---

## [2026-06-04] Stage 1 — Walking Skeleton Decisions

**Status:** Accepted

**Context:**
Building the walking skeleton: ingest → stub generate → notify → Express review → approve → Hashnode publish. Several implementation choices required resolution.

**Decisions:**

- **`express.urlencoded` (not `express.json`) as the primary body parser.** The review UI POSTs via HTML `<form>` elements (application/x-www-form-urlencoded). `express.json()` alone would leave `req.body.action` undefined on form submits. Both parsers are mounted; form submits hit urlencoded, API-style POSTs hit json.

- **`approve` gate: `['pending', 'needs_edits', 'failed']`.** Publish failures set status to `failed`; the gate admits `failed` so the reviewer can retry without DB surgery. `rejected` and `published` stay terminal → 400. `approved` is a transient state only (immediately transitions to `published` on success or `failed` on failure — never sticky). Decision: user-directed.

- **`crypto.randomUUID()` from `node:crypto` instead of a `uuid` package.** Node 25 ships it natively; one fewer dep for a stage that should stay minimal.

- **`dotenv` package for env loading.** Both entry points (run.ts, approval.ts) call `import 'dotenv/config'` as the first line. Alternative was `--env-file=.env` Node flag, but tsx's flag forwarding to the underlying Node process was uncertain. `dotenv` is explicit and zero-surprise.

- **`getDraftBySourcePostId` added to db.ts.** Ingest needs to check whether a draft already exists for a given source post. The existing Stage-0 index (`idx_drafts_source_post_id`) is the backing index; this function completes the intended access pattern. Uses `ORDER BY created_at DESC LIMIT 1` to return the most recent draft if somehow multiple exist.

- **publish.ts content-type guard before JSON.parse.** Hashnode's GraphQL API (`gql.hashnode.com`) now requires a Pro plan. Non-Pro requests receive a 301 redirect to their announcements page; `fetch(redirect: 'follow')` follows it and returns HTML with `Content-Type: text/html`. Without the content-type check, `response.json()` would throw a generic parse error. The guard produces a specific, actionable error: "Hashnode API returned non-JSON... may require Pro plan upgrade." See **Hashnode Pro blocker** section below.

- **Stage 1 request-edits returns 501.** Request-edits background re-gen is Stage 3 work. The button is rendered in the UI (showing the reviewer persona what's coming) but the endpoint returns 501 until Stage 3.

**Hashnode Pro blocker (confirmed, not assumed):**
Raw curl probe of `https://gql.hashnode.com` with the production token returns HTTP 301 → `https://hashnode.com/announcements/graphql-api` at the Cloudflare layer before the GraphQL server receives the request. Not an auth error (token format is correct). Not a mutation shape error (same 301 regardless of payload). The API is behind a hard paywall. To upgrade: Hashnode dashboard → Billing → Upgrade to Pro. Until then, publish() receives an HTML redirect body (not JSON), the content-type guard in publish.ts catches it, and the draft lands in `failed` status so the reviewer can retry once Pro is active.

**Consequences:**
- All other Stage 1 checkpoints verified: 5 posts ingested, 5 Slack notifications sent, review UI renders correctly, reject path works, second-approve-on-published returns 400, re-running ingest finds 0 new posts.
- The live Hashnode URL checkpoint requires Hashnode Pro upgrade before it can close.

---

## [2026-06-04] Seed data — id derivation & optional posted_at

**Status:** Accepted

**Context:**
Building `seed/posts.json` from 5 real Justin Shriber LinkedIn posts (text + url
only). `Post.id` is the dedup key. The supplied URLs carry LinkedIn share/tracking
query params (`?utm_source=share&utm_medium=…&rcm=…`) that vary per share. No
reliable publish dates were available.

**Decision:**
- **`id` = SHA-256 of the *normalized* url, first 12 hex chars.** Normalization
  strips the query string and any trailing slash before hashing, so the same post
  shared two different ways collapses to one stable id. Rejected: hashing the raw
  url (a re-share with different utm params would dodge dedup); using the LinkedIn
  activity id directly (works, but a hash keeps the contract source-agnostic for the
  stretch LinkdAPI ingest). 12 hex chars = 48 bits, ample for this scale.
- **Stored `url` keeps the full original link** (trimmed), not the normalized form —
  a reviewer needs to click through to the real post. Only the hash *input* is
  normalized.
- **`Post.posted_at` made optional; omitted from every seed row.** Real dates are
  unknown and inventing them would be a fabricated claim. Rejected: backfilling
  guessed/`Date.now()` timestamps.
- **`seed/posts.json` generated by `scripts/build-seed.ts`** (raw text pasted there
  verbatim) rather than hand-authored — avoids JSON-escaping errors across long
  bodies and documents the exact id-derivation recipe. The script is the source of
  truth; the JSON is its committed output and asserts id uniqueness on build.

**Consequences:**
- Anything that sorts/filters by date must treat `posted_at` as possibly absent.
- Stage 1 ingest must compute `source_post_id` from the *same* normalization recipe
  if it ever re-hashes a url; safer for ingest to read `Post.id` straight from the
  seed (which it does) and only re-derive for live (LinkdAPI) sources.

---

## [2026-06-04] Stage 0 — DB layer storage & access decisions

**Status:** Accepted

**Context:**
`src/db.ts` must persist the `Draft` type to SQLite. SQLite has no object/array
column types, and several `Draft` fields are optional or structured. Repo also had
no `package.json`/`tsconfig.json`, so the checkpoint (`tsc --noEmit` + scratch run)
was not runnable.

**Decision:**
- **Object columns (`extracted_idea`, `eval_scores`) stored as JSON TEXT**; serialized
  on write and parsed on read inside the helpers. Rejected: separate normalized tables
  (over-engineering at demo scale; these are read/written whole, never queried by field).
- **`critique` stored verbatim, not re-serialized.** The `Draft` contract already defines
  it as a JSON *string*. Double-serializing would corrupt the `JSON.parse(draft.critique)`
  step in `generate.ts`.
- **`insertDraft` / `getDraft` / `updateDraft` are the only DB access path; raw `db`
  handle is not exported.** Concentrates JSON (de)serialization and the `undefined -> null`
  coercion (better-sqlite3 rejects `undefined` binds) in one place. Rejected: exporting
  the connection (would scatter serialization logic and invite bypasses).
- **`updateDraft` returns the freshly re-fetched row and auto-bumps `updated_at`.**
  Directly supports the "re-fetch before guarding on status" gotcha — callers never act
  on a stale in-memory object.
- **`status` CHECK constraint** pins the six `DraftStatus` values at the DB layer (defense
  in depth behind the TS enum). `cms_url` left nullable — NULL is the publish idempotency
  guard. WAL mode enabled (Run A writer + Run B reader are separate processes).
- **Minimal toolchain scaffolded:** `package.json`/`tsconfig.json` with only Stage-0 deps
  (`better-sqlite3`, `tsx`, `typescript`, types). Rejected: installing all SPEC deps now
  (violates "one stage at a time"; later stages add their own).

**Consequences:**
- JSON columns are not independently queryable — acceptable; no query touches their internals.
- A caller could bypass the JSON boundary only by reaching the unexported handle (it cannot).
- Native module (`better-sqlite3`) compiles/loads against Node 25 locally — verified working.

---

## [2026-06-04] Stage 4 — Structured publish on dev.to

**Status:** Accepted

**Context:**
Mapping the `revised_draft` to all dev.to API fields with AEO structure. Four decisions
required resolution.

**Decisions:**

- **Title source: revise pass emits `TITLE: <title>` as first output line.** `publish.ts`
  splits it from the body and passes it as the separate `title` field to the API.
  Rejected: derive from `extracted_idea.core_thesis` (truncation mid-phrase; title quality
  not guaranteed); derive from first H2 (makes title identical to a body section heading).
  This is the only approach that produces a purpose-built 50–60 char informational title
  without an extra API call. Trade-off: touches the generation contract — `regenerate.ts`
  also produces TITLE: lines, which the review UI now extracts and displays separately.

- **`canonical_url` is a two-step: POST → persist `cms_url` → PUT best-effort.**
  The POST creates the article; `status: published` and `cms_url` are persisted
  immediately on success. Then a PUT sets `canonical_url = postUrl` explicitly.
  If the PUT fails, the post is already live and persisted — the PUT failure is logged
  but does not throw or revert status. dev.to self-canonicalizes to the article URL by
  default, so a PUT failure is cosmetic. Rejected: PUT before persisting (if PUT throws,
  status reverts to `failed`, reviewer retries, and a duplicate POST is made — idempotency
  broken).

- **`tags` sent as comma-separated string per Forem v1 API spec** (`"sales,revenue,ai,saas"`).
  The Forem OpenAPI schema defines `tags` as `type: string` with the Forem editor guide
  confirming "max of four tags, needs to be comma-separated." Stage 1 used a JSON array
  (`["sales","revenue","ai","saas"]`); the server appears to coerce both formats, but the
  official type is string. Changed to match spec to avoid silent coercion surprises.
  Tags remain static for Stage 4; dynamic extraction from `extracted_idea` is post-core-loop.

- **JSON-LD: documented in SPEC.md §16 as "map, not build."** dev.to owns `<head>` and
  strips injected `<script>` tags from `body_markdown`. Injecting JSON-LD into the hosted
  CMS page is not possible. The three schemas (Article + FAQPage + Organization) are fully
  specified in SPEC.md §16 using fields already available at publish time. Production path:
  self-hosted front end (static + Git or Ghost) where the template layer controls `<head>`.

- **`## ` markdown syntax made explicit in the revise prompt.** Inspection of a Stage 2/3 draft
  showed the model used `**bold text**` for H2 sections rather than `## heading` markdown.
  dev.to renders `##` as real H2 elements for SEO/AEO; bold text does not produce heading
  semantics. Fixed by adding explicit syntax requirement and a format example for body H2s and
  the FAQ block ("## Frequently Asked Questions", "**Q: question?**" + answer).

**Consequences:**
- `prompts/revise.ts` now requires `TITLE: <title>\n\n<body>` format AND explicit `## ` heading
  syntax. Existing `revised_draft` rows (pre-Stage 4) fall back to the legacy `deriveTitle()`
  path in `publish.ts`.
- Review UI (`approval.ts`) extracts and displays proposed title separately above content.
- The AEO body structure (quick-answer block, question H2s, FAQ) is enforced by the revise
  prompt — not validated at publish time. Verification is via inspection of a real published post.

---

## [YYYY-MM-DD] Title

**Status:** Proposed | Accepted | Superseded

**Context:**
<!-- What situation forced a decision? -->

**Decision:**
<!-- What was decided? -->

**Consequences:**
<!-- What are the trade-offs? -->

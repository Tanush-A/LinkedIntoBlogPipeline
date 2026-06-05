# Decision Log

Decisions are recorded in reverse chronological order.

---

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

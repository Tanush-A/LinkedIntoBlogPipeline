# Decision Log

Decisions are recorded in reverse chronological order.

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

## [YYYY-MM-DD] Title

**Status:** Proposed | Accepted | Superseded

**Context:**
<!-- What situation forced a decision? -->

**Decision:**
<!-- What was decided? -->

**Consequences:**
<!-- What are the trade-offs? -->

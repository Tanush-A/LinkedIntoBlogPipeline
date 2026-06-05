# Terret Agentic Content Pipeline — SPEC.md
 
> **Phase 1 + Phase 2 decisions locked.** Implementation-ready.
> Runtime: TypeScript/Node. Approval surface: Option C (Slack notify + Express endpoint).
 
---
 
## 1. What It Does
 
An agentic pipeline that ingests public LinkedIn posts from Justin Shriber (Terret's CEO),
transforms them into Terret-branded blog content via a 3-pass GPT-4o generation chain, notifies
a reviewer automatically via Slack, gates publishing behind a mandatory human approval step
(approve / reject / request-edits) on an Express UI, and publishes approved posts to Hashnode as
fully-structured, AEO/GEO-optimized pages.
 
**Nothing publishes without human approval.** All pipeline state lives in a SQLite status table.
The loop closes with a real, publicly accessible Hashnode URL.
 
---
 
## 2. Layer Map
 
| Layer | Job | Tool |
|---|---|---|
| **1. Ingest** | Read source posts, deduplicate by post ID | Seed JSON file → `Post` contract; stretch: LinkdAPI source node |
| **2. Generate** | 3-pass chain: extract → draft → critique → revise | GPT-4o (`gpt-4o`) via `openai` npm |
| **3. Notify** | Alert reviewer when draft is ready | Slack incoming webhook (HTTP POST) |
| **4. Gate** | Human approves, rejects, or requests edits | Express endpoint (`/review/:draftId`) — Option C |
| **5. Publish** | POST structured content to CMS | dev.to REST API → live public URL |
 
**Cross-cutting — built:** idempotency (post_id dedup + publish cms_url guard), retries (p-retry,
per API call), minimal observability (run ID + structured logs per step).
 
**Cross-cutting — mapped:** scale, scheduling, auth refresh, endpoint auth.
 
---
 
## 3. Architecture
 
```
[Seed JSON] ──► Ingest ──► Generate (3-pass) ──► Notify (Slack) ──► [Express /review]
                 │               ▲                                          │
              dedupe        request-edits ◄────────────────────────────────┤
             (post_id)     (bg task + note)                          approve│reject
                                                                            │
                                                                  [publish() ← idempotent]
                                                                            │
                                                              status: approved + cms_url null
                                                                            │
                                                                   [Hashnode → live URL]
                                                                            │
                                                                  status → 'published'
```
 
**Two separate processes:**
- **Run A** (`src/run.ts`) — triggered manually; runs ingest→generate→notify then **exits**.
- **Run B** (`src/server/approval.ts`) — long-running Express server; handles all approval
  interactions.
**publish() is idempotent:** guards on `status === 'approved' && draft.cms_url == null`.
Double-click / POST refresh → returns early, no duplicate Hashnode post.
 
---
 
## 4. Data Contracts
 
Finalized in TypeScript — see `src/types.ts`.
 
### Post
 
```
id           string     // stable dedup key — hash of URL or platform post ID
author       string     // "Justin Shriber"
url          string     // source LinkedIn URL
text         string     // post body text
posted_at    string     // ISO 8601
media?       string[]   // optional image/video URLs
```
 
### Draft
 
```
id                string        // UUID — pipeline run ID; stamped in every log line
source_post_id    string        // FK → Post.id
status            DraftStatus   // see enum below
revision_count    number        // increments on each needs_edits cycle
reviewer_note?    string        // stored on needs_edits; injected into re-gen context
extracted_idea?   ExtractedIdea // output of extraction pass
raw_draft?        string        // output of draft pass
critique?         string        // JSON-stringified CritiqueOutput
revised_draft?    string        // final content — what gets published
cms_url?          string        // set by publish() on success; null = idempotency guard
eval_scores?      EvalScores    // optional manual rubric scores for README
created_at        string        // ISO 8601
updated_at        string        // ISO 8601
```
 
### DraftStatus enum
 
```
'pending'      // draft written, awaiting review
'approved'     // reviewer approved; publish() can proceed
'rejected'     // reviewer rejected; terminal
'needs_edits'  // reviewer requested edits; re-gen triggered or in progress
'failed'       // pipeline error (generation or publish); see logs for run_id
'published'    // publish() succeeded; cms_url set; TERMINAL — no further transitions
```
 
---
 
## 5. Pipeline — Step by Step
 
1. **Ingest** — read seed file; for each `Post`, query `drafts` table for existing
   `source_post_id`; skip if found (idempotency check).
2. **Extract** — GPT-4o (`response_format: json_object`): extract `core_thesis`,
   `supporting_points`, `target_audience`, `angle`, `do_not_reuse` as structured JSON.
   The model works from the *idea*, not the post text.
3. **Draft** — GPT-4o: generate blog post from extracted idea + Terret brand config
   + voice rules. No slop tells. Promotion earned, not bolted on.
4. **Critique** — GPT-4o (`response_format: json_object`): act as a skeptical managing
   editor. Return scored JSON (rubric dimensions 1–5) + problems, cut_list, strengthen.
5. **Revise** — GPT-4o: rewrite using critique as instructions. Output is the final content.
6. **Write to DB** — initial run: INSERT a new `Draft` row with `status: 'pending'`, all pass
   outputs stored. Re-gen (triggered by request-edits): UPDATE the existing row — same `id`,
   incremented `revision_count`, new pass outputs, `status` back to `'pending'`.
7. **Notify** — POST to Slack incoming webhook: post title, source URL, one-sentence preview,
   link to `http://BASE_URL/review/:draftId`.
8. **Exit Run A.** The Express server (Run B) handles everything from here.
9. **Publish** — called by the Express handler on approve:
   - Guard: `status === 'approved' && draft.cms_url == null` — return early if not met
   - Call Hashnode GraphQL API with all structured fields (see §6)
   - On success: `db.update({ status: 'published', cms_url: returnedUrl })`
   - On failure: leave `status: 'approved'` (re-triggerable); log with run_id
10. **Log** — structured log line at every step: `{ run_id, step, status, timestamp, error? }`
---
 
## 6. Gate Architecture — Option C
 
### Run A — `src/run.ts`
 
Entry point. Triggered manually (`ts-node src/run.ts` or `npm start`) for the build demo.
Runs ingest → generate (steps 1–7) → POST Slack notification → **exits**.
Nothing is awaited after the Slack POST. State is durable in SQLite.
 
### Run B — `src/server/approval.ts`
 
Long-running Express server. Start once before the demo; keep running.
 
**Endpoints:**
 
`GET /review/:draftId`
Render the review page — full `revised_draft`, source post URL, `extracted_idea`, proposed
metadata (title, slug, tags), action buttons (Approve / Reject / Request Edits + textarea).
 
`POST /action/:draftId`
Body: `{ action: 'approve' | 'reject' | 'needs_edits', note?: string }`
 
**APPROVE**
```
1. Fetch draft by ID (always re-fetch — never use a stale in-memory object).
   Guard: status is not 'pending' or 'needs_edits' → 400.
     ('published' is terminal. 'rejected' and 'failed' cannot be approved.)
2. db.update(id, { status: 'approved' })
3. Re-fetch draft (so publish() receives the updated status).
   await publish(updatedDraft)
   publish() guards internally: status === 'approved' && cms_url == null (defense-in-depth).
4. On success: redirect 302 → cms_url
5. On publish failure: return 500; status stays 'approved' (re-triggerable via another click)
```
 
**REJECT**
```
1. db.update(id, { status: 'rejected' })
2. Return 200 with confirmation page
```
 
**REQUEST-EDITS**
```
1. If draft.revision_count >= MAX_REVISIONS → 422 "Max revisions reached; review manually"
2. db.update(id, { status: 'needs_edits', reviewer_note: note })
3. Respond 200 immediately (do NOT await re-gen — this is the background task pattern)
4. setImmediate(async () => {
     try {
       const newContent = await regenPipeline(draft, note)  // re-runs steps 2–5 with note
       db.update(id, {
         ...newContent,
         status: 'pending',
         revision_count: draft.revision_count + 1,
         reviewer_note: note
       })
       await postSlackNotification(draft.id)   // re-notify via same incoming webhook
     } catch (err) {
       db.update(id, {
         status: 'needs_edits',   // revert to needs_edits — cleanly re-clickable
         reviewer_note: `Re-gen failed: ${err.message}`
       })
       log({ run_id: draft.id, step: 'regen', status: 'failed', error: err.message })
     }
   })
```
 
**publish() — `src/pipeline/publish.ts`**
```typescript
export async function publish(draft: Draft): Promise<void> {
  // Idempotency guard — safe to call multiple times
  if (draft.status !== 'approved' || draft.cms_url != null) return;
  const url = await callHashnodeAPI(draft);                 // retried via p-retry
  db.update(draft.id, { status: 'published', cms_url: url });
}
```
 
**Approval endpoint accessibility**
- Local dev / live example: Slack message links to `http://localhost:3000/review/:draftId`.
  Reviewer approves on the same machine. This is correct for the submission's live example.
- Public URL for a real reviewer: `ngrok http 3000` (temporary) or Render/Railway free tier
  (persistent). Set `BASE_URL` env var; Slack notification uses it to build the review link.
---
 
## 7. AEO / GEO / SEO — Publish Requirements
 
"Properly published" is a specific set of fields and structures. The dev.to API call must
set all of these — not just the body text.
 
**Required CMS fields (dev.to REST API — `POST /api/articles`):**
 
| Field | Notes |
|---|---|
| `title` | 50–60 chars; informational, not clickbait |
| `body_markdown` | Structured body — headings, quick-answer block, FAQ all render from markdown |
| `description` | 150–160 chars; reads like a direct extractable answer (maps to meta description) |
| `tags` | Array of plain lowercase alphanumeric strings, MAX 4. e.g. `["sales","revenue","ai","saas"]` |
| `canonical_url` | Canonical URL (set to the live dev.to URL after first publish for re-publishes) |
| `published` | `true` to publish immediately |
 
*Note: `slug` is derived from `title` automatically — do not set directly. No `publicationId` — posts go to the authenticated account.*
 
**Auth: `api-key: <DEVTO_API_KEY>` header.** NOT `Authorization: Bearer`.
 
**JSON-LD schema — stack all three in the body via HTML comment or front-matter (Stage 4):**
- `Article` — headline, description, author, publisher, datePublished, dateModified
- `FAQPage` — mirrors the question-shaped H2s; each section = one Q&A pair
- `Organization` — Terret brand entity (name, url, sameAs: LinkedIn/Crunchbase)
**In-body AEO requirements (generated by the draft prompt):**
- 40–80 word quick-answer block in the first ~200 words (answer engines lift this)
- 3–4 H2s phrased as real questions ("How do top closers actually outperform?")
- FAQ section at the end (3 Q&As) — maps to FAQPage schema
- Evidence density: specific numbers, named examples, concrete claims
---
 
## 8. Retries — Built, Minimal
 
- Each of the 5 API calls (extract, draft, critique, revise, dev.to publish) wrapped with
  `p-retry`.
- Config: max 3 attempts, exponential backoff (1 s → 2 s → 4 s).
- On final failure: log `{ run_id, step, error }`, set `draft.status = 'failed'`.
---
 
## 9. Observability — Built, Minimal
 
- `Draft.id` (UUID) is the run ID; stamped in every log line for correlation.
- Structured log per step: `{ run_id, step, status, timestamp, error? }` → stdout.
- **Production upgrade (mapped):** add a log transport (Datadog/Loki/CloudWatch).
  Zero pipeline code changes required.
---
 
## 10. Decision Log
 
| # | Decision | Chosen | Rejected | Why |
|---|---|---|---|---|
| 1 | Orchestrator paradigm | Code-first plain script | n8n, Make/Zapier | n8n = "I can use a tool" signal; SaaS = weak resourcefulness story |
| 2 | Gate substrate | Async status table | Durable orchestrator (Inngest/Trigger.dev) | Async gate has no in-flight state — DB row already survives restarts; orchestrator's headline feature is moot; over-engineering at this scale is a judgment ding |
| 3 | Gate type | Async | Sync / durable pause | Follows from #2: nothing to suspend or resume |
| 4 | Ingestion — build | Seed JSON behind typed Post contract | ToS-violating scraping; commercial APIs | Scraping = ToS/contract liability (§8.2(4), Proxycurl precedent); no official read API; seed = zero risk, proves swappability |
| 5 | Ingestion — production narrative | Authorized access via CEO's account | Third-party APIs | Influencer is the company CEO → owner consent available; dissolves scraping + consent problems |
| 6 | Ingestion — stretch | LinkdAPI source node post-core-loop | Built upfront | Proves swappability; documented with ToS-bucket tradeoff |
| 7 | Model | GPT-4o (`gpt-4o`) | Gemini Flash (named free-tier fallback), local models | Quality is the graded surface for this audience; demo volume costs pennies; Head of Marketing judges output directly — this is where to pay |
| 8 | Model — reach step | Switch to Anthropic API | Separate search API | Native web_search tool; trivial endpoint swap |
| 9 | Pipeline shape | 3-pass: extract → draft → critique → revise | 1-shot (slop), 2-pass (fewer artifacts) | Quality delta visible to HoM; all three artifacts showable in live example; mirrors real content team workflow |
| 10 | Output evaluation | Manual / ad-hoc against rubric | Automated 4th pipeline pass | README artifact only; before/after delta proves the critique/revise chain works |
| 11 | Terret brand supply | Config object from terret.ai (done) | Hardcoded in prompt | Swappable; single source of truth; prevents brand drift |
| 12 | Generation stretch | Context-finding pass post-core-loop | Built in core loop | Adds evidence density; kills hallucination risk; switch to Anthropic API for native search |
| 13 | CMS | Hashnode | dev.to, Ghost self-hosted, static-site+Git | Free, structured API, real public URL, supports all AEO fields |
| 14 | Scale | Mapped | Built | No fan-out problem at demo scale |
| 15 | Scheduling | Mapped → one-liner with live ingestion | Built | Manual trigger fine for seed build |
| 16 | Retries | Built minimal (p-retry) | Mapped | Explicit trade for dropping durable orchestrator |
| 17 | Observability | Built minimal (run ID + logs) | Full stack | Sufficient for demo; upgrade is a log transport |
| 18 | Auth refresh | Mapped | Built | Env var tokens fine for demo timeline |
| 19 | Idempotency | Built (~5 lines dedup + publish guard) | Mapped | #1 naive build miss; already have the status table |
| 20 | Approval surface | Option C: Slack notify + Express endpoint | A: Block Kit buttons (3s ack + Slack retry/dedup complexity); B: own endpoint only (no Slack notification) | Block Kit requires background task + interaction dedup (our dedup is on source_post_id, not interaction ID); own endpoint is synchronous, no timeout constraint; Slack notify + link preserves the "reviewer gets pinged" story |
| 21 | Runtime | TypeScript / Node.js | Python | GPT-4o official SDK is TS-first; Express webhook handler; typed contracts as interfaces |
| 22 | publish() idempotency | Guard on `status === 'approved' && cms_url == null` + terminal `published` status | Status-only guard | Double-click / POST refresh on approve cannot create duplicate Hashnode post; `published` is the unambiguous terminal state |
 
---
 
## 11. Build vs. Map Summary
 
| Component | Status | Notes |
|---|---|---|
| Ingest (seed JSON + Post contract + dedup) | **Built** | |
| Generate (3-pass GPT-4o chain) | **Built** | |
| Notify (Slack incoming webhook) | **Built** | |
| Gate (Express approval server, 3 verbs, back-edge, revision cap) | **Built** | |
| Publish (Hashnode API + structured fields + published status) | **Built** | |
| Retries (p-retry per call) | **Built minimal** | |
| Observability (run ID + structured logs) | **Built minimal** | |
| Idempotency (post_id dedup + cms_url guard) | **Built** | |
| Scale (fan-out) | **Mapped** | Queue architecture in README |
| Scheduling (cron trigger) | **Mapped** | One-liner when live ingestion lands |
| Auth refresh | **Mapped** | Env vars for demo; rotation pattern in README |
| Approval endpoint auth | **Mapped** | Localhost for demo; token/deploy for prod |
 
---
 
## 12. Build Sequence
 
1. `src/types.ts` — Post, Draft, DraftStatus, ExtractedIdea, CritiqueOutput
2. `src/db.ts` — SQLite setup, table schema, query helpers
3. `src/pipeline/ingest.ts` — seed reader + idempotency check
4. `src/config/brand.ts` — Terret brand config object
5. `prompts/` — all four prompt builders (extract, draft, critique, revise)
6. `src/pipeline/generate.ts` — 3-pass chain calling the prompts
7. `src/pipeline/notify.ts` — Slack incoming webhook POST
8. `src/server/approval.ts` — Express review + action endpoints
9. `src/pipeline/publish.ts` — Hashnode API + idempotent guard
10. `src/run.ts` — pipeline entry point (Run A)
11. Harden: add `p-retry` wrappers, run ID stamping, structured logs
12. **End-to-end test:** one complete loop (seed post → Slack notify → approve → live URL)
13. Stretch A: swap seed → LinkdAPI source node
14. Stretch B: context-finding pass; switch model to Anthropic API
---
 
## 13. Stretch Goals (post-core-loop)
 
| Stretch | What it adds | Dependency |
|---|---|---|
| **LinkdAPI source node** | Live Shriber post ingestion; proves contract swappability | LinkdAPI free credits |
| **Context-finding pass** | Web search between draft + critique; grounds claims; boosts AEO evidence density | Switch to Anthropic API for native web_search |
| **Scheduling** | Auto-trigger on new posts | Live ingestion first |
| **Automated eval pass** | 4th API call → rubric scorecard; delta artifact for README | Optional |
 
---
 
## 14. Phase 2 Prep
 
- [x] Terret brand positioning pulled from terret.ai → `src/config/brand.ts` written
- [x] Runtime: TypeScript / Node.js
- [x] Approval surface: Option C — Slack notify + Express endpoint
- [x] Generation model: GPT-4o
- [ ] Collect 5–10 real public Justin Shriber LinkedIn posts → `seed/posts.json`
- [ ] Create Hashnode account → get API token + publication ID → `.env`
- [ ] Get OpenAI API key → `.env`
- [ ] Set up Slack incoming webhook URL → `.env`
- [ ] Start ngrok (`ngrok http 3000`) or deploy to Render for a public approval URL
---
 
## 15. Known Failure Modes — Preview
 
Full ranked table goes in README §8.
 
| Failure mode | Layer | Likelihood | Impact | Mitigation built? |
|---|---|---|---|---|
| Gate bypass — path publishes without status guard | Gate | Low | Catastrophic | Yes — `publish()` idempotent guard + `published` terminal status |
| Double-publish — approve clicked twice | Gate | Medium | High | Yes — `cms_url == null` guard in `publish()` |
| Hallucinated Terret claims | Generate | Medium | High | Partial — brand config constrains; critique flags; no automated fact-check |
| Idempotency miss — same post processed twice | Ingest | Medium | High | Yes — post_id dedup |
| Notify failure — Slack token expired | Notify | Low | High | Partial — p-retry; no dead-letter queue |
| Request-edits loop — no convergence | Gate | Low | Medium | Yes — revision_count cap + MAX_REVISIONS |
| Partial CMS publish — post created, fields missing | Publish | Low | Medium | Partial — verify API response before status flip |
| Prompt drift — model update degrades output quality | Generate | Medium | Medium | No — pin model version; eval harness is "fix first with real budget" |
| Approval endpoint unauthenticated — anyone who can reach the URL can approve | Gate | Medium | High | Mapped — localhost is acceptable for the live example; for a public URL add a secret token in the path or basic auth; note in README |
| Re-gen background task fails silently | Gate | Low | Medium | Yes — catch block reverts to `needs_edits`; logged with run_id |
 
**Fix first:** prompt drift + an eval harness. A silent model version update breaks output
quality with no alert. A rubric-scored regression test on a golden input set is the real
answer; everything else is recoverable.
 
---
 
*Implementation-ready. See CLAUDE.md for builder rules and build sequence.*
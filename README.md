# Terret Agentic Content Pipeline

**Justin Shriber's LinkedIn posts → multi-pass GPT generation → Slack notification → human approval → structured dev.to publish.**

The CEO's posts are watched automatically; each becomes a timely, on-brand blog draft; recurring themes are detected and consolidated into pillar pieces; **nothing publishes without a human's approval.** One complete loop runs end-to-end with a real, clickable published URL.

> Two registers below. **Part 1** is what it does, in marketing terms. **Part 2** is the technical appendix — architecture, decisions, failure modes, and an interview crib. Read Part 1 first.

---
---

# PART 1 — In Marketing Terms

## What it does, in your terms

You publish thought leadership off the back of the CEO's voice. Today that means someone reads his LinkedIn, notices a good post, writes a blog version, gets it reviewed, and posts it. This automates the tedious 90% and keeps you in charge of the 10% that matters — the decision to publish.

| The promise | What it means for you |
|---|---|
| **His posts are watched automatically** | No one has to babysit LinkedIn. New CEO posts are picked up on their own. |
| **Each becomes a timely draft** | A LinkedIn post becomes a full, on-brand blog draft — title, structure, FAQ, the works — while the topic is still hot. |
| **Recurring themes become pillar pieces** | If he posts three times about the same idea, you don't get three near-identical blogs. The system notices the shared theme and writes **one** strong pillar article instead. |
| **Nothing publishes without your approval** | Every draft lands in a clean review screen. You **Approve**, **Reject**, or **Request Edits** (in plain English — "sharpen the hook," "cut section 2"). Only your click publishes. This is a hard rule, enforced in code, with no bypass. |
| **Every published post ships with a promo kit** | The moment a post goes live, the system writes channel-native variants — a LinkedIn post, an X thread, a newsletter blurb — each linking back to the article, and drops them into Slack for you to copy out. Nothing posts to any channel automatically; the variants pass the same quality checks as the blog. |

You are the only gate. The machine does the drafting and the chasing; you do the judging.

## The review screen — your control surface

When a draft is ready, you get a **Slack message** with the title, the source post, a one-line preview, and a link. The link opens a review page built for you, not for engineers:

- The **proposed title** and the full **rendered article**, exactly as it will read.
- The **source post(s)** it came from — one for a normal piece, several for a pillar piece, with the detected **theme** labelled.
- An **AEO scorecard** — a plain checklist of whether the post is structured to get picked up by AI answer engines (Google's AI summaries, ChatGPT, Perplexity): does it have an extractable quick-answer, question-style headings, an FAQ, a clean meta description.
- A **verification panel** — an automatic, deterministic check that flags two specific risks before you ever read the draft: **banned "AI-slop" phrases** and **unverified numbers** (any statistic the system can't trace to our brand facts or the CEO's own post). Green means clean; amber means "look here before you approve."
- The three buttons: **Approve & Publish**, **Reject**, **Request Edits**.

Approving publishes a fully-structured page to dev.to and sends you straight to the live URL. Done.

## Live example — a real post, start to finish

This loop ran for real. Every artifact is saved in [`docs/live-example/`](docs/live-example/).

**Source:** a Justin Shriber LinkedIn post — *"Dashboards are post-mortems"* (the idea that revenue dashboards tell you what already went wrong, too late to fix it). → [`01-source-post.json`](docs/live-example/01-source-post.json)

| Step | What happened | Artifact |
|---|---|---|
| **Extract** | Pulled the core thesis, supporting points, audience (CROs), and the sharp angle — *not* the post's wording | [`02-extracted_idea.json`](docs/live-example/02-extracted_idea.json) |
| **Draft** | Wrote a first blog version from the idea | [`03-raw_draft.md`](docs/live-example/03-raw_draft.md) |
| **Critique** | A simulated skeptical editor scored it (overall **3/5**), flagged a generic hook, weak product fit, a slop word | [`04-critique.json`](docs/live-example/04-critique.json) |
| **Revise** | Rewrote against every critique note; sharpened the hook; earned the Terret mention | [`05-final_draft.md`](docs/live-example/05-final_draft.md) |
| **Notify** | Slack message fired with the review link | [`06-slack-notification-payload.json`](docs/live-example/06-slack-notification-payload.json) |
| **Review** | The approval screen you'd actually see | [`07-approval-screen.html`](docs/live-example/07-approval-screen.html) |
| **Approve → Publish** | One click → live, structured dev.to article | **[Live URL ↗](https://dev.to/tanush_aggarwal_76b2e8d04/how-ai-transforms-raw-sales-data-into-precise-revenue-actions-3g0n)** |

Full step-by-step, including two honest incidents during the run: [`08-chain-report.md`](docs/live-example/08-chain-report.md).

> **One honest note on this specific artifact.** This example was captured from an earlier model generation, and it leaked exactly two things the system is built to prevent: the word *"delve"* and the figure *"3.1x"* presented as a proven stat (it's a demo-only number). That leak is the whole reason the **verification layer** exists — see "What breaks #1" in Part 2. Running today's deterministic check on this very post flags `delve`, `3.1x`, `20%` and turns the panel amber, which is precisely how a reviewer would now catch it before approving. The published URL proves *the loop closes*; current pipeline output (below) is the *quality* showcase.

## Output quality — how it stays good, and how we measured it

Three things keep the writing from reading like generic AI:

1. **Voice & grounding.** Generation works from the *idea*, never by paraphrasing the CEO. It's fed a brand config — Terret's real positioning, the one verified customer quote (Jeff Perry, CRO at Carta), a ban-list of AI-slop phrases — and a hard rule: **no invented claims, features, customers, or numbers.** The product earns its mention as the answer to the post's problem; it never opens or closes as an ad.
2. **Self-editing loop.** Every draft is critiqued and revised, then **re-scored and revised again** until it hits a quality bar (overall ≥ 4/5) or caps out — and we keep the best version, not the last.
3. **Deterministic safety net.** A non-AI check runs on every draft for banned phrases and ungrounded numbers, and surfaces them to you. Prompts are probabilistic; this check is not.

**The measured quality journey.** We improved output along three levers (overall score, 1–5):

| Lever | What changed | Overall score |
|---|---|---|
| **Model (baseline)** | First real chain, untuned prompts | **2 / 5** |
| **Prompts** | Two tuning rounds: sharper hooks, earned product integration, expanded slop ban-list | **3 / 5** floor across 3 test posts |
| **Model + loop** | Newer flagship model + the re-score loop | **4 / 5** |
| **Sources** | Theme-grouping: 3 near-duplicate posts → **1 pillar piece** | *(editorial win — kills redundancy, not a score bump)* |

The "sources" lever is the important product insight: a real marketing team writes **one** pillar piece from a theme, not a blog per post. Of 8 seed posts, 3 share the "unify your revenue data" thesis — the old 1:1 approach would have published 3 redundant blogs.

---
---

# PART 2 — Technical Appendix

## Architecture at a glance

```
                          SOURCE_MODE = seed (default) | live (LinkdAPI)
                                         │
seed/posts.json ──► Ingest ──► posts table (canonical) ──► dedup (known ids)
   or LinkdAPI         │                                        │ new posts
   (triage + backfill) │                                  groups.json override
                       ▼                                        │ remainder
                  ┌─────────────────  LLM grouping judge (1 call)  ─────────┐
                  │  partitions: group (n≥2 → pillar) | singleton (n=1)     │
                  └─────────────────────────────────────────────────────────┘
                       │  group_fingerprint = sha256(sorted member ids)
                       │  fingerprint exists? ──yes──► skip (idempotent no-op)
                       ▼ no
        4-pass chain:  extract → draft → critique → revise
                                          └──── re-score loop ────┘ (best-of, ≥4)
                       │
                  verifyDraft()  ── deterministic guardrail (slop + ungrounded #)
                       ▼
                  insert Draft (status: pending) ──► Notify (Slack webhook)
                       │
   ── RUN A exits here. State is durable in SQLite. ──────────────────────────
                       │
   ── RUN B (always-on Express server) ──────────────────────────────────────
                       ▼
   GET /review/:id  ── rendered draft + AEO scorecard + verification panel
   POST /action/:id ── approve | reject | needs_edits(note)
                       │
           approve ───► publish()  [guard: status==='approved' && cms_url==null]
                       │                    │ fail → status:'failed' (re-approvable)
           needs_edits ─► setImmediate(regenerate) ─► re-notify  [bg, returns 202]
                       ▼
              dev.to POST → live URL → status:'published'  (TERMINAL)
                       │
           repurpose(published)  ── 3 channel variants (LinkedIn/X/newsletter),
           [awaited, fail-safe]     cms_url enforced + verifyDraft'd → Slack (copy, don't auto-post)
```

**Two processes, async gate (Option C).** **Run A** (`src/run.ts`) ingests → generates → notifies, then **exits** — there is no in-flight state to hold. **Run B** (`src/server/approval.ts`) is the always-on server handling every approval interaction. The "wait for a human" is a `status` column in SQLite, not a suspended workflow. Trigger of the gate is the reviewer's `POST /action/:id`.

### The five layers + cross-cutting

| Layer | Implementation | File |
|---|---|---|
| **1. Ingest** | Seed JSON or live LinkdAPI behind one typed `Post` contract; triage + text backfill; dedup | `src/pipeline/ingest.ts`, `src/ingest/*` |
| **2. Generate** | 4-pass chain + re-score loop + deterministic verify | `src/pipeline/generate.ts`, `prompts/*`, `src/lib/verify.ts` |
| **3. Notify** | Slack incoming webhook (HTTP POST) | `src/pipeline/notify.ts` |
| **4. Gate** | Express `GET /review` + `POST /action`; 3 verbs; async status table | `src/server/approval.ts` |
| **5. Publish** | dev.to REST API, structured fields, idempotent guard | `src/pipeline/publish.ts` |
| **Repurpose** | Post-publish: 3 channel variants → verify → Slack (copy, not auto-post) | `src/pipeline/repurpose.ts`, `prompts/repurpose.ts` |
| **Grouping** | Pool → LLM-judge partition → group-fingerprint identity | `src/pipeline/group.ts`, `src/lib/fingerprint.ts` |
| **State / idempotency** | post-id dedup **+** group-fingerprint dedup **+** `cms_url` publish guard | `src/db.ts` |
| **Observability** | Draft UUID = run ID, stamped on every structured log line | throughout |

### Key mechanisms (the parts worth probing)

**Pool + LLM-judge grouping + group-fingerprint idempotency.** Ingestion delivers a *batch*. One LLM-judge call sees the whole batch and partitions it into theme groups (n≥2 → one pillar draft) and singletons (n=1 → the normal 1:1 draft — it's the same code path). Identity of a group is `sha256(sorted member post-ids)`. Re-running the same batch → same fingerprints → existing drafts → no-ops. A later batch that attaches a *new* post to a prior theme → changed membership → **new** fingerprint → a new roll-up pillar that complements the old (immutable, possibly already-published) draft. The judge is **untrusted input**: its JSON is re-validated in code (every new id covered exactly once; unknown/duplicate/existing-only partitions dropped; low-confidence groups split), and **any** judge failure falls open to all-singletons — generation is never blocked by grouping.

**4-pass chain + re-score loop.** `extract → draft → critique → revise`. Extract works from the *idea* (returns `core_thesis`, `supporting_points`, `target_audience`, `angle`, `do_not_reuse`). Critique is a skeptical-editor pass returning a 1–5 scorecard + problems/cut-list/strengthen. The **re-score loop** then iterates `critique ↔ revise` until `overall ≥ 4` or `RESCORE_CAP` (default 3), **retaining the highest-scoring draft, not the last** — a revision that regresses cannot ship. Per-iteration scorecards are saved to `docs/eval/rescore/`.

**Deterministic verification layer.** `verifyDraft(text, sourcePosts)` — pure regex + brand-config lookup, **no LLM**. Two checks: (1) **slop ban-list** terms (built from `brand.ts`); (2) **ungrounded numbers** — every stat-shaped figure must trace to the brand config *or* the source post, else it's flagged; **demo figures always flag** even if a source post cites them (a source quoting "3.1x" doesn't license republishing it as a proven stat). Runs after every revise pass; result is persisted and **surfaced on the review page, not hard-blocking** — the human decides. *(Verified: running this on the published live example returns `bannedTerms:['delve'], ungroundedNumbers:['3.1x','20%']` — it catches its own showcase's leak.)*

**AEO/SEO scorecard.** `buildScorecard()` — also pure/deterministic, read-only on the review page: title length, quick-answer block in the first ~200 words, question-style H2s, FAQ section, meta-description length, and the critique's extractability score. Advisory (PASS/WARN), never blocking.

**Post-publish repurposing.** `repurpose(draft)` runs in the approve path *after* `publish()` persists `published` + `cms_url`. One `json_object` call produces all three channel variants (LinkedIn post, X thread, newsletter blurb); the `cms_url` is **enforced into each variant deterministically** (not trusted to the LLM); each variant is run through the same `verifyDraft` guardrail (corpus = the source posts) and delivered as one Slack message for a human to copy out — **nothing auto-posts**, so the gate is preserved. It is **awaited but fail-safe**: it never writes draft status, so a repurpose failure cannot revert the live post, and the handler swallows any error before redirecting. `repurposed_content` is persisted before the Slack call so a webhook outage never loses the variants.

**Source-mode ingestion.** `SOURCE_MODE=seed` (default, deterministic — also the test fixture) | `live` (LinkdAPI polling). Same code below the `Post` contract. Live mode adds: **triage** (deterministic prefilters drop reshares/media-only/too-short, + a judge skip-list — the *third* quality gate alongside the re-score loop and the human), **text backfill** (`/posts/all` omits text for ~⅓ of posts; backfill from `/posts/info`, throttled + capped, and **defer-not-discard** on rate-limit so "not yet fetched" is never misclassified as "too short"), and **cross-process status** via a `meta` table read at `GET /status`. Polling, not webhooks (LinkedIn offers no post webhook).

## What I built vs. what I mapped

> Every **mapped / not-built** item, with the one-line plan to build it: **[`docs/MAP.md`](docs/MAP.md)**.

| Component | Status | Note |
|---|---|---|
| Ingest — seed + `Post` contract + dedup | **Built** | |
| Ingest — live LinkdAPI source mode (triage, backfill, watcher) | **Built** | `seed` is the standing fallback |
| Generate — 4-pass chain + re-score loop | **Built** | |
| Verification layer + AEO scorecard | **Built** | deterministic, surfaced on review page |
| Grouping — pool + judge + fingerprint idempotency | **Built** | 1:1 is the n=1 case |
| Notify — Slack webhook | **Built** | |
| Gate — Express server, 3 verbs, back-edge, revision cap | **Built** | async status table |
| Publish — dev.to structured fields + idempotent guard | **Built** | live URL closed |
| Observability — run-ID stamped structured logs | **Built (minimal)** | stdout |
| **Retries (`p-retry`)** | **Mapped, NOT built** | no `p-retry` dependency; SPEC §8 over-states it. Today: a publish failure sets `status:'failed'` and re-exposes Approve for a manual retry |
| Scheduling / scale fan-out / queue | **Mapped** | watcher loop exists; no queue |
| Auth-token refresh | **Mapped** | env-var tokens for demo |
| Approval-endpoint auth | **Mapped** | localhost only; see fix-first |
| JSON-LD schema stack | **Mapped, not built** | hosted CMS owns `<head>` — see #6 |
| Repurposing / promo kit (post-publish LinkedIn/X/newsletter variants) | **Built** | runs after publish, fail-safe, delivered-to-Slack not auto-posted |

## Decisions & tradeoffs

Scannable: **Decision · Chose · Rejected · Why.**

| # | Decision | Chose | Rejected | Why |
|---|---|---|---|---|
| 1 | Orchestrator | Code-first plain TS scripts | n8n / Make / Zapier | n8n signals "I can use a tool"; SaaS = weak resourcefulness story; full control of the loop |
| 2 | Gate substrate | Async **status table** | Durable orchestrator (Inngest/Temporal) | Async gate has **no in-flight state** — the DB row already survives restarts; the orchestrator's headline feature (resumable pauses) is moot here; using one would be over-engineering |
| 3 | Approval surface | **Option C**: Slack notify + Express endpoint | (A) Slack Block Kit buttons; (B) endpoint only, no Slack | A needs 3s-ack + interaction dedup; B loses the "reviewer gets pinged" story. C keeps the ping and a synchronous, timeout-free handler |
| 4 | Ingestion — built | Seed JSON behind typed `Post` | Scraping; commercial APIs upfront | Scraping = ToS liability; no official read API; seed = zero-risk and proves contract swappability |
| 5 | Ingestion — production story | **Authorized access to the CEO's own content** (his OAuth/export) | Third-party scrapers as the prod path | The influencer *is* the company CEO → owner consent is available; dissolves the ToS + consent problem |
| 6 | Ingestion — live demo | LinkdAPI behind `SOURCE_MODE`, seed fallback | Build live upfront / paste-a-URL | Proves swappability; `seed` insures the demo if the scraper dies; paste-a-URL is neither automatic nor editorial |
| 7 | Model | Flagship GPT, env-configurable | Hardcoded model string; cheap models | Quality is the graded surface; demo cost is pennies; **env-configurable because models deprecate mid-project** (this one did) |
| 8 | Pipeline shape | 4-pass + re-score loop | 1-shot (slop); 2-pass | Quality delta is visible; all artifacts showable; mirrors a real content team |
| 9 | Grouping mechanism | **LLM judge** partition | Embedding/cosine threshold | A similarity threshold groups on topic overlap ("both mention AI"), not a shared *thesis*; the judge reasons about editorial coherence. Embeddings are the right *production prefilter* (§ scale) |
| 10 | Grouping trust | **Auto-act** on judge + human gate catches errors | Separate "approve the grouping" gate | A bad group surfaces as an incoherent draft the reviewer rejects — the content gate already covers it; a second gate doubles human touchpoints for no safety. Confidence floor (0.6) + fail-open-to-singletons are the built guards |
| 11 | Group identity | Fingerprint = hash of sorted ids; membership change = new draft | Mutable groups | Keeps drafts immutable and the terminal-`published` guarantee intact; roll-ups complement, never re-open |
| 12 | Verification | Deterministic, **surfaced not blocking** | (A) LLM re-scoring as guardrail; (B) hard-block on fail | Prompts are probabilistic; deterministic checks catch leaks regardless of model. Hard-blocking removes the human + false-positives on legitimate uses |
| 13 | Re-gen scope | Revise-only, accumulate from last draft | Full 4-pass re-gen; reset to raw | Reviewer notes are editorial (target the text, not the idea); accumulate so round 2 doesn't undo round 1 |
| 14 | Revision cap | `revision_count` increments on **success only** | Increment on click | A transient API error shouldn't burn a reviewer's revision slot |
| 15 | CMS | **dev.to** REST | Hashnode (moved behind paid Pro mid-build); Ghost self-host | Free, clean REST, real public URL, all AEO fields. Auth is `api-key:` header (not Bearer); tags comma-separated max 4 |
| 16 | publish() idempotency | Guard `status==='approved' && cms_url==null` + terminal `published` | Status-only guard | Double-click / POST refresh cannot create a duplicate dev.to post |
| 17 | Retries | **Mapped, not built** | Build now | Explicit trade for dropping the durable orchestrator; manual `failed`→Approve covers demo scale |
| 18 | Repurposing | **Built** post-publish; awaited + fail-safe; delivered-to-Slack | Fire-and-forget; auto-post to channels | Runs after publish and never writes status, so a failure can't revert the live post; awaited so it completes in-request; variants still pass the human gate (copied from Slack, not auto-posted) |

Full rationale and rejected alternatives: [`docs/DECISIONS.md`](docs/DECISIONS.md). Architecture spec: [`docs/SPEC.md`](docs/SPEC.md), [`docs/SPEC-BATCH.md`](docs/SPEC-BATCH.md).

## Publishing & discoverability

`revised_draft` → dev.to fields: `title` (parsed from the revise pass's `TITLE:` first line, ≤60 chars), `body_markdown` (AEO structure baked in by the prompt), `description` (first substantive paragraph, ≤155 chars, same text the scorecard reports), `tags` (comma-separated, max 4), `canonical_url` (two-step: POST to create → persist `cms_url` → best-effort PUT; dev.to self-canonicalizes so a PUT failure is cosmetic). In-body AEO is enforced by the revise prompt: a 40–80 word quick-answer up top, question-shaped H2s, a 3-Q FAQ, evidence density.

**JSON-LD (Article + FAQPage + Organization): mapped, not built — deliberately.** dev.to/Forem owns the page `<head>` and strips `<script>` injected into `body_markdown`, so JSON-LD cannot persist on a hosted CMS. All three schemas are fully specified in [SPEC §16](docs/SPEC.md), populated from fields already on the draft row at publish time. Production path = a self-hosted front end (static-site + Git, or Ghost) whose template layer controls `<head>`.

## What breaks

Ranked by likelihood × impact. The **headline** is #1 — it's the most *instructive* failure (it shaped the architecture). The **fix-first** is a separate axis, called out below the table.

| # | Failure mode | Layer | L × I | Mitigation (built / mapped) |
|---|---|---|---|---|
| 1 | **Prompt guardrails are probabilistic** — the model emits a slop word or a demo figure despite explicit instructions | Generate | High × High | **Built:** deterministic `verifyDraft` at the output boundary catches what the prompt + self-critique miss, surfaced to the reviewer |
| 2 | **LLM self-critique saturates** — scores cluster and stop discriminating; the model can't reliably grade past ~4/5 | Generate | High × Med | **Built:** re-score loop uses scores to *rank* iterations (best-of), not as ground truth; the **human** makes the publish call. Scores order drafts; they don't decide |
| 3 | **Judge false-positive grouping** — two unrelated posts merged into one incoherent pillar | Generate | Med × Med | **Built:** confidence floor (0.6) + deterministic re-validation + fail-open-to-singletons; the **human gate** rejects an incoherent pillar. **Config dial (rejected as default):** a "suggest-mode" grouping-approval step. **At scale:** embedding prefilter → judge confirms |
| 4 | **Unofficial LinkedIn API (LinkdAPI)** — ToS violation, can break/get blocked without notice | Ingest | Med × High | **Built:** `seed` fallback + one-file adapter seam. **Production:** authorized access to the CEO's *own* content (OAuth/export) — no ToS issue |
| 5 | **Model deprecation mid-project** — a model version is retired or silently changes voice | Generate | Med × Med | **Built:** model is env-configurable (`OPENAI_MODEL`), swap is a config change. **Gap:** no regression test → see fix-first (quality) |
| 6 | **JSON-LD can't persist** — hosted CMS strips injected schema | Publish | High (known) × Low | **Mapped:** fully specified; needs a self-hosted front end that owns `<head>` |
| 7 | **Unauthenticated approval endpoint** — anyone who reaches `/review/:id` can publish | Gate | Med × High | **Mapped:** localhost OK for the demo; **fix-first** (security) below |
| 8 | **Retries not built** — a transient API error fails a draft | Cross | Med × Med | **Built (partial):** publish failure → `status:'failed'` re-exposes Approve for manual retry. **Mapped:** `p-retry` on all 5 calls |
| 9 | **Re-gen background task fails silently** | Gate | Low × Med | **Built:** `regenerate` catches internally, reverts to `needs_edits` with an error-prefixed note, logged with run-ID |
| 10 | **Double-publish** — approve clicked twice | Gate | Med × High | **Built:** `cms_url==null` guard + terminal `published` status |

**Fix first (security) — beats every reliability item:** the **unauthenticated approval endpoint**. Every other item is recoverable; an open approval URL lets anyone who finds the link publish under the brand. The fix is ~2 lines (compare a path token to an env secret; 401 if absent) and becomes load-bearing the instant ngrok runs.

**Fix first (quality) — the #1 investment:** a **rubric-scored eval harness** on a golden input set. A silent model bump degrades voice with no alert today; the eval files in `docs/eval/` are the manual baseline this would automate.

## With more time / a real budget

- **Eval harness** — automate the `docs/eval/` baseline into a regression test that fails CI on a quality drop (directly mitigates #5).
- **Secure + deploy the gate** — path-token auth, then Render/Railway so a real reviewer approves from anywhere.
- **Durable retries + observability** — `p-retry` on all 5 calls; ship logs to Loki/Datadog; alert on `failed` rows older than N minutes.
- **Embedding prefilter** for grouping at scale — cluster candidates by cosine similarity, judge confirms only the clusters (~10× fewer judge tokens).
- **Production ingestion** — swap LinkdAPI for the CEO's authorized OAuth/export (one adapter file).

## Interview crib — "why did you…?"

| They ask | One-line answer | Rejected alternative |
|---|---|---|
| **…go code-first, not n8n?** | I wanted full control of the loop and a real engineering signal; n8n shows tool-use, not judgment | n8n / Make / Zapier |
| **…publish to dev.to?** | Free, clean REST, a real public URL, all AEO fields — Hashnode moved behind paid Pro mid-build | Hashnode (paywalled) / Ghost self-host |
| **…make the gate async (status table)?** | There's nothing in-flight to suspend — the DB row already survives restarts, so a durable orchestrator's headline feature is moot | Inngest/Temporal sync pause |
| **…auto-act on the grouping judge?** | The human gate already fronts every pillar; a bad group is just a draft the reviewer rejects — a second gate doubles touchpoints for no safety | Separate grouping-approval gate |
| **…surface verification instead of blocking?** | Prompts are probabilistic so the check must be deterministic; but a reviewer may knowingly approve a flagged figure with proper context — keep the human in control | Hard-block on `passed:false` |
| **…pay for the flagship model?** | Quality is what the HoM evaluates directly and demo volume costs pennies; I made it env-configurable because the model *did* deprecate mid-build | Cheap/local model; hardcoded string |
| **…keep a seed fallback after building live ingestion?** | The demo must never depend on a third-party scraper being up; `seed` is also the deterministic test fixture | Live-only |
| **…publish 1:1 immediately and roll up later, not hold posts to see if they group?** | Holding adds windowing state and delays timely posts; the fingerprint model makes a later attachment a clean new roll-up (new fingerprint), and 1:1 is just the n=1 case — batch-partition now, streaming roll-up is mapped | Hold-and-wait windowing |
| **…choose quality over latency?** | A multi-pass + re-score loop is slower but the HoM grades the *post*, not the wall-clock; cadence is hours/days, not seconds | One-shot for speed |
| **…leave retries unbuilt?** | Explicit trade for dropping the orchestrator; at one-post-at-a-time scale, `failed`→Approve is a sufficient manual retry; `p-retry` is mapped | Build durable retries now |

## How to run it

```bash
npm install
cp .env.example .env        # fill OPENAI_API_KEY, SLACK_WEBHOOK_URL, DEVTO_API_KEY

# Run B — the always-on approval server (start first, keep running)
npm run server              # http://localhost:3000

# Run A — the pipeline (seed mode): ingest → group → generate → notify → exit
npm run pipeline

# → Slack pings you with a review link → open it → Approve → live dev.to URL

# Live ingestion (stretch): set SOURCE_MODE=live + LINKDAPI_KEY in .env
npm run poll               # one-shot LinkdAPI poll
npm run watch              # continuous polling loop

npm test                   # full suite (deterministic, no live API calls)
```

Key env vars: `OPENAI_MODEL` / `OPENAI_MODEL_EXTRACT` (model swap), `MAX_REVISIONS` (human revision cap), `RESCORE_CAP` (auto quality-loop cap), `GROUP_CONFIDENCE_MIN` (grouping floor), `SOURCE_MODE`, `DEVTO_DRAFT_MODE` (publish as dev.to draft for test runs). Full list in [`.env.example`](.env.example).

To reproduce the live example: the full artifact chain is already captured in [`docs/live-example/`](docs/live-example/).

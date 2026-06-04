# CLAUDE.md
 
**This is Tanush's interview take-home for Terret (Agentic Workflow Intern, Summer 2026).**
Every decision will be defended live. Surface judgment calls before resolving them.
Do not improvise architecture.
 
---
 
## What This Project Does
 
Justin Shriber's LinkedIn posts → 3-pass GPT-4o generation → Slack notification →
human approval (Express UI) → structured Hashnode publish.
 
Full architecture and all ratified decisions: **SPEC.md**
Micro-decisions made during the build: **docs/decision-log.md** (append as you go)
 
---
 
## Stack
 
| Concern | Tool |
|---|---|
| Runtime | TypeScript / Node.js |
| Database | SQLite via `better-sqlite3` |
| Generation | OpenAI GPT-4o (`gpt-4o`) via `openai` npm |
| Retries | `p-retry` (wraps every API call) |
| Notify | Slack incoming webhook — HTTP POST |
| Approval surface | Express — `GET /review/:draftId`, `POST /action/:draftId` |
| Publish | Hashnode GraphQL API |
| Local tunnel | ngrok (for public approval URL during demo) |
 
---
 
## Project Layout
 
```
/
├── CLAUDE.md                      ← you are here
├── SPEC.md                        ← architecture, contracts, all decisions
├── docs/
│   └── decision-log.md            ← append micro-decisions during build
├── seed/
│   └── posts.json                 ← Justin Shriber LinkedIn posts (5-10 real posts)
├── src/
│   ├── types.ts                   ← Post, Draft, DraftStatus, ExtractedIdea, CritiqueOutput
│   ├── db.ts                      ← SQLite setup, table schema, query helpers
│   ├── run.ts                     ← Run A: pipeline entry point (ingest→generate→notify→exit)
│   ├── config/
│   │   └── brand.ts               ← Terret brand config — do NOT invent claims beyond this
│   ├── pipeline/
│   │   ├── ingest.ts              ← seed reader + post_id idempotency check
│   │   ├── generate.ts            ← 3-pass chain (extract, draft, critique, revise)
│   │   ├── notify.ts              ← Slack incoming webhook POST
│   │   └── publish.ts             ← Hashnode API + idempotent guard
│   └── server/
│       └── approval.ts            ← Run B: Express review + action endpoints (always-on)
├── prompts/
│   ├── extract.ts                 ← extraction pass messages builder
│   ├── draft.ts                   ← draft pass messages builder
│   ├── critique.ts                ← critique pass messages builder
│   └── revise.ts                  ← revise pass messages builder
└── .env                           ← secrets (never commit)
```
 
---
 
## Environment Variables
 
```
OPENAI_API_KEY=
SLACK_WEBHOOK_URL=
HASHNODE_TOKEN=
HASHNODE_PUBLICATION_ID=
BASE_URL=http://localhost:3000     # approval link base; update to ngrok URL for demo
DATABASE_URL=./db/pipeline.sqlite
MAX_REVISIONS=3
PORT=3000
```
 
---
 
## Non-Negotiables
 
1. **Nothing publishes without approval.**
   `publish()` guards on `status === 'approved' && draft.cms_url == null`.
   The `published` status is terminal — nothing transitions out of it.
   No bypasses. No exceptions.
2. **No invented Terret claims.**
   All product statements must be grounded in `src/config/brand.ts`.
   If the generation produces an ungrounded claim, the critique pass should flag it.
   Catch it in manual review if it doesn't.
3. **Thin-slice first, then deepen.**
   Get one end-to-end loop closing (even with minimal content) before polishing any layer.
   The live example is the non-negotiable deliverable.
4. **Log all micro-decisions.**
   Format for `docs/decision-log.md`:
   `- [date] Decision: <what>. Chose: <X>. Rejected: <Y>. Why: <one line.>`
5. **Surface judgment calls.**
   If a decision touches architecture, the gate logic, or publish behavior — stop and flag it.
   Don't resolve silently.
---
 
## Build Order
 
One stage at a time. Verify the checkpoint before moving to the next stage.
 
**Stage 0 — Foundation**
`src/db.ts`: SQLite schema matching the Draft type exactly, plus query helpers. Verify the table creates cleanly and the helpers read/write a round-trip.
 
**Stage 1 — Walking skeleton** *(front-loads gate and idempotency risk)*
Wire the entire loop with a stubbed `generate()` that returns a fixed string. Ingest one seed post → stub draft written with `status: pending` → Slack notify fires → Express review UI shows the draft → approve → Hashnode publish with minimal required fields → `status: published`. The full path must close before any real content is generated.
 
**Stage 2 — Real generation**
Replace the stub with the 4-pass chain: extract → draft → critique → revise. One real post in, `revised_draft` out. Verify no slop tells and no ungrounded Terret claims before proceeding.
 
**Stage 3 — Full gate**
Request-edits background re-gen with reviewer note injected into context, revision cap enforced, reject flow, failure-revert to `needs_edits`.
 
**Stage 4 — Structured publish**
Full Hashnode field mapping: all AEO/GEO fields, JSON-LD schema stack (Article + FAQPage + Organization). Verify canonical URL, tags as `{name, slug}` objects, and meta description are all set on the live post.
 
**Stage 5 — Minimal hardening only**
`p-retry` on every API call, run-ID stamping, structured log lines per step. No queues, no monitoring stack, no auth refresh — those are mapped.
 
**Stage 6 — Live-example capture**
Run the full pipeline on a real Justin Shriber LinkedIn post from the seed file. Capture the complete loop: source post → extracted idea → raw draft → critique scores → revised draft → Slack notification → approval click → live Hashnode URL. This is the submission artifact.
 
---
 
## Build Gotchas
 
Concrete traps that will break the system silently if missed. Read before writing any handler or pipeline step.
 
**Always re-fetch from DB before guarding on status.**
Never guard on a stale in-memory `draft` object fetched before a status update. Pattern for every handler and `publish()`: fetch by ID → update status → re-fetch → pass fresh object downstream. `db.update(id, {...})` does not mutate the local variable.
 
**Approve only from `pending` or `needs_edits` — else 400.**
`pending` is the normal incoming state for a fresh draft. `needs_edits` is re-clickable after a re-gen. `published` is terminal. `rejected` and `failed` cannot be approved. Anything else → 400.
Inside `publish()`: guard on `status === 'approved' && cms_url == null`. These are two separate guards — `published` is the terminal status, `cms_url != null` is the idempotency check.
 
**`draft.critique` is a JSON string — parse it before calling `buildReviseMessages`.**
SQLite stores it as text. `buildReviseMessages` takes a `CritiqueOutput` object. In `generate.ts`, do `JSON.parse(draft.critique)` before passing. TypeScript will catch it if you forget — do not cast around the error.
 
**Hashnode publish: field names are exact.**
Canonical URL field: `originalArticleURL` (current Hashnode GraphQL API — do not change to `canonicalUrl`).
Tags MUST be `{ name: string, slug: string }` objects — plain strings are silently dropped and the post publishes tagless. Verify all field names against live Hashnode GraphQL docs before writing the publish step.
 
---
 
## Key Reminders for the Interview
 
- The approval surface (`/review/:draftId`) is a showable artifact — the Head of Marketing
  is the persona for this UI. Make it clear and usable.
- The `publish()` idempotency guard and `published` terminal status are explicit interview
  talking points. Know why they exist.
- The async gate (Run A exits, Run B handles approval) is a deliberate architectural choice
  documented in SPEC.md §6. Know the rejected alternatives and why Option C won.
- Output quality is what the HoM can directly evaluate. Grade the final blog post against
  the rubric in SPEC.md §7 before submitting.# CLAUDE.md
 
**This is Tanush's interview take-home for Terret (Agentic Workflow Intern, Summer 2026).**
Every decision will be defended live. Surface judgment calls before resolving them.
Do not improvise architecture.
 
---
 
## What This Project Does
 
Justin Shriber's LinkedIn posts → 3-pass GPT-4o generation → Slack notification →
human approval (Express UI) → structured Hashnode publish.
 
Full architecture and all ratified decisions: **SPEC.md**
Micro-decisions made during the build: **docs/decision-log.md** (append as you go)
 
---
 
## Stack
 
| Concern | Tool |
|---|---|
| Runtime | TypeScript / Node.js |
| Database | SQLite via `better-sqlite3` |
| Generation | OpenAI GPT-4o (`gpt-4o`) via `openai` npm |
| Retries | `p-retry` (wraps every API call) |
| Notify | Slack incoming webhook — HTTP POST |
| Approval surface | Express — `GET /review/:draftId`, `POST /action/:draftId` |
| Publish | Hashnode GraphQL API |
| Local tunnel | ngrok (for public approval URL during demo) |
 
---
 
## Project Layout
 
```
/
├── CLAUDE.md                      ← you are here
├── SPEC.md                        ← architecture, contracts, all decisions
├── docs/
│   └── decision-log.md            ← append micro-decisions during build
├── seed/
│   └── posts.json                 ← Justin Shriber LinkedIn posts (5-10 real posts)
├── src/
│   ├── types.ts                   ← Post, Draft, DraftStatus, ExtractedIdea, CritiqueOutput
│   ├── db.ts                      ← SQLite setup, table schema, query helpers
│   ├── run.ts                     ← Run A: pipeline entry point (ingest→generate→notify→exit)
│   ├── config/
│   │   └── brand.ts               ← Terret brand config — do NOT invent claims beyond this
│   ├── pipeline/
│   │   ├── ingest.ts              ← seed reader + post_id idempotency check
│   │   ├── generate.ts            ← 3-pass chain (extract, draft, critique, revise)
│   │   ├── notify.ts              ← Slack incoming webhook POST
│   │   └── publish.ts             ← Hashnode API + idempotent guard
│   └── server/
│       └── approval.ts            ← Run B: Express review + action endpoints (always-on)
├── prompts/
│   ├── extract.ts                 ← extraction pass messages builder
│   ├── draft.ts                   ← draft pass messages builder
│   ├── critique.ts                ← critique pass messages builder
│   └── revise.ts                  ← revise pass messages builder
└── .env                           ← secrets (never commit)
```
 
---
 
## Environment Variables
 
```
OPENAI_API_KEY=
SLACK_WEBHOOK_URL=
HASHNODE_TOKEN=
HASHNODE_PUBLICATION_ID=
BASE_URL=http://localhost:3000     # approval link base; update to ngrok URL for demo
DATABASE_URL=./db/pipeline.sqlite
MAX_REVISIONS=3
PORT=3000
```
 
---
 
## Non-Negotiables
 
1. **Nothing publishes without approval.**
   `publish()` guards on `status === 'approved' && draft.cms_url == null`.
   The `published` status is terminal — nothing transitions out of it.
   No bypasses. No exceptions.
2. **No invented Terret claims.**
   All product statements must be grounded in `src/config/brand.ts`.
   If the generation produces an ungrounded claim, the critique pass should flag it.
   Catch it in manual review if it doesn't.
3. **Thin-slice first, then deepen.**
   Get one end-to-end loop closing (even with minimal content) before polishing any layer.
   The live example is the non-negotiable deliverable.
4. **Log all micro-decisions.**
   Format for `docs/decision-log.md`:
   `- [date] Decision: <what>. Chose: <X>. Rejected: <Y>. Why: <one line.>`
5. **Surface judgment calls.**
   If a decision touches architecture, the gate logic, or publish behavior — stop and flag it.
   Don't resolve silently.
---
 
## Build Order
 
One stage at a time. Verify the checkpoint before moving to the next stage.
 
**Stage 0 — Foundation**
`src/db.ts`: SQLite schema matching the Draft type exactly, plus query helpers. Verify the table creates cleanly and the helpers read/write a round-trip.
 
**Stage 1 — Walking skeleton** *(front-loads gate and idempotency risk)*
Wire the entire loop with a stubbed `generate()` that returns a fixed string. Ingest one seed post → stub draft written with `status: pending` → Slack notify fires → Express review UI shows the draft → approve → Hashnode publish with minimal required fields → `status: published`. The full path must close before any real content is generated.
 
**Stage 2 — Real generation**
Replace the stub with the 4-pass chain: extract → draft → critique → revise. One real post in, `revised_draft` out. Verify no slop tells and no ungrounded Terret claims before proceeding.
 
**Stage 3 — Full gate**
Request-edits background re-gen with reviewer note injected into context, revision cap enforced, reject flow, failure-revert to `needs_edits`.
 
**Stage 4 — Structured publish**
Full Hashnode field mapping: all AEO/GEO fields, JSON-LD schema stack (Article + FAQPage + Organization). Verify canonical URL, tags as `{name, slug}` objects, and meta description are all set on the live post.
 
**Stage 5 — Minimal hardening only**
`p-retry` on every API call, run-ID stamping, structured log lines per step. No queues, no monitoring stack, no auth refresh — those are mapped.
 
**Stage 6 — Live-example capture**
Run the full pipeline on a real Justin Shriber LinkedIn post from the seed file. Capture the complete loop: source post → extracted idea → raw draft → critique scores → revised draft → Slack notification → approval click → live Hashnode URL. This is the submission artifact.
 
---
 
## Build Gotchas
 
Concrete traps that will break the system silently if missed. Read before writing any handler or pipeline step.
 
**Always re-fetch from DB before guarding on status.**
Never guard on a stale in-memory `draft` object fetched before a status update. Pattern for every handler and `publish()`: fetch by ID → update status → re-fetch → pass fresh object downstream. `db.update(id, {...})` does not mutate the local variable.
 
**Approve only from `pending` or `needs_edits` — else 400.**
`pending` is the normal incoming state for a fresh draft. `needs_edits` is re-clickable after a re-gen. `published` is terminal. `rejected` and `failed` cannot be approved. Anything else → 400.
Inside `publish()`: guard on `status === 'approved' && cms_url == null`. These are two separate guards — `published` is the terminal status, `cms_url != null` is the idempotency check.
 
**`draft.critique` is a JSON string — parse it before calling `buildReviseMessages`.**
SQLite stores it as text. `buildReviseMessages` takes a `CritiqueOutput` object. In `generate.ts`, do `JSON.parse(draft.critique)` before passing. TypeScript will catch it if you forget — do not cast around the error.
 
**Hashnode publish: field names are exact.**
Canonical URL field: `originalArticleURL` (current Hashnode GraphQL API — do not change to `canonicalUrl`).
Tags MUST be `{ name: string, slug: string }` objects — plain strings are silently dropped and the post publishes tagless. Verify all field names against live Hashnode GraphQL docs before writing the publish step.
 
---
 
## Key Reminders for the Interview
 
- The approval surface (`/review/:draftId`) is a showable artifact — the Head of Marketing
  is the persona for this UI. Make it clear and usable.
- The `publish()` idempotency guard and `published` terminal status are explicit interview
  talking points. Know why they exist.
- The async gate (Run A exits, Run B handles approval) is a deliberate architectural choice
  documented in SPEC.md §6. Know the rejected alternatives and why Option C won.
- Output quality is what the HoM can directly evaluate. Grade the final blog post against
  the rubric in SPEC.md §7 before submitting.
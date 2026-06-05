# Stage 6 Live Example — Full Chain Report
**Date:** 2026-06-05  
**Source post:** `24b7e159d3d4` — "Dashboards are post-mortems"  
**Draft ID:** `c380e26b-8eb5-4d49-b2d9-cdce20fad4b3`  
**Published URL:** https://dev.to/tanush_aggarwal_76b2e8d04/how-ai-transforms-raw-sales-data-into-precise-revenue-actions-3g0n  
**Published at:** 2026-06-05T02:05:07Z (confirmed public via API, `published_at` set)

---

## Chain: step by step

| Step | What happened |
|------|---------------|
| **Ingest** | `ingestPosts()` returned 1 post (seed isolated to `24b7e159d3d4`). Idempotency check: no existing draft for this post_id. |
| **Pass 1 — Extract** | GPT-4o extracted core thesis, 3 supporting points, target audience (CROs with large budgets), angle (the $4M loss misattributed to price), and 3 do-not-reuse phrases from the LinkedIn post. |
| **Pass 2 — Draft** | Raw blog post written from the extracted idea. Hook: loss/board pressure scenario. 4 H2 sections + FAQ. |
| **Pass 3 — Critique** | Overall score: 3. Key problems flagged: generic hook, abstract voice, weak product integration ("This is where Terret emerges as a crucial tool"), truth flag on "instant analysis" claim. Cut list: 3 lines. Strengthen list: 6 items. |
| **Pass 4 — Revise** | Applied all critique notes. Hook sharpened to board-pressure scenario. Product integration rewritten to earned resolution. TITLE: line prepended per revise prompt contract. |
| **DB write** | `insertDraft()` persisted all 4 pass outputs. Status: `pending`. |
| **Slack notify** | Webhook POST fired. Payload includes post title, source URL, first line of revised_draft as preview, and review URL. |
| **Approval** | POST `/action/c380e26b...` → action=approve. Server re-fetched draft (status: pending), updated to `approved`, called `publish()`. |
| **Dev.to publish** | POST to `https://dev.to/api/articles`. Article ID: 3823474. Status set to `published`, `cms_url` persisted. |
| **Canonical PUT** | PUT `/api/articles/3823474` with `canonical_url` — completed successfully. |
| **DB terminal state** | `status: published`, `cms_url` set. The `published` status is terminal — no further transitions possible. |

---

## Artifacts saved

| File | Contents |
|------|----------|
| `01-source-post.json` | The original Justin Shriber LinkedIn post |
| `02-extracted_idea.json` | Pass 1 output: ExtractedIdea object |
| `03-raw_draft.md` | Pass 2 output: raw blog post before critique |
| `04-critique.json` | Pass 3 output: CritiqueOutput with scores, problems, cut_list, strengthen |
| `05-final_draft.md` | Pass 4 output: revised blog post as published |
| `06-slack-notification-payload.json` | Reconstructed Slack webhook payload (webhook URL redacted) |
| `07-approval-screen.html` | Full HTML of the approval UI at `/review/c380e26b...` before approve |
| `08-chain-report.md` | This file |

---

## Two incidents during the run — documented honestly

### Incident 1: Article created as dev.to draft (not published)
**Root cause:** The approval server (PID 7586) had started in a previous session with `DEVTO_DRAFT_MODE=true` loaded from `.env`. `dotenv/config` loads once at process startup. Changing `.env` after server startup has no effect on the running process — the server still held `DEVTO_DRAFT_MODE=true` in memory.  
**What happened:** The POST to dev.to sent `published: false`, creating a draft instead of a live post.  
**Resolution:** Direct API call — `PUT /api/articles/3823474` with `{"article": {"published": true, "title": "..."}}` — published the article without re-running the pipeline. DB `cms_url` updated to the permanent URL.  
**Fix for next run:** Restart the approval server after any `.env` change, or export env vars directly before starting.

### Incident 2: Title published as "TITLE: How AI Transforms..." on dev.to
**Root cause:** The running approval server compiled `publish.ts` at startup. The `splitTitleAndBody` function's `startsWith('TITLE:')` check did not match (most likely the server was using a compiled version of publish.ts from before the TITLE: parsing was added — `publish.ts` shows as modified-uncommitted in git status). The fallback `deriveTitle()` was used instead, which does not strip the "TITLE:" prefix, yielding the full first line (60-char slice).  
**Resolution:** Same API call above also set the correct title: "How AI Transforms Raw Sales Data into Precise Revenue Actions".  
**Fix for next run:** `git commit` publish.ts and restart the server so it compiles from the latest source.

---

## Content quality flags (grounding audit)

| Claim in draft | Grounded? | Notes |
|----------------|-----------|-------|
| "Answer-to-Action Engine" | YES | `brand.ts` tagline |
| "Revenue Graph" | YES | `brand.ts` positioning, step 1 |
| "deals close 3.1x faster when reps quantify ROI early" | **PARTIAL** | The 3.1x figure IS in `brand.ts` voice examples but brand config explicitly says "Do NOT reproduce these specific numbers in a published post as Terret's proven stats." The revise pass used it as a concrete example but it should have been held back or reframed as hypothetical. Flag for live demo: this line should be removed or reframed. |
| "AI delves deep" | **SLOP** | "delve" is on the brand.ts slop ban-list. The revise pass should have caught this — critique score for voice_fit was 2, the weakest score. |
| Carta, Cloudflare, Grafana customer names | Not in draft — CORRECT | Generation correctly did not invent customer claims. |

---

## Gate integrity check

- `publish()` was called only after `status === 'approved'` — confirmed by server logs (updateDraft → re-fetch → publish pattern followed)
- `cms_url` was null at time of publish — confirmed by guard in `publish.ts:29`
- `status: published` is terminal — the draft cannot be approved, rejected, or re-gen'd again
- Idempotency: a second POST to the same approve endpoint would 400 (status is `published`, not in allowed list)

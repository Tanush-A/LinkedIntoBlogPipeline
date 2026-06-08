# MAP.md — Mapped (Not Built)

Everything designed but deliberately not built. One full loop runs for real; these are the limbs.
Rationale lives in `DECISIONS.md`; full specs in `SPEC.md` / `SPEC-BATCH.md`.

**Fix first:** endpoint auth (security) and an eval harness (quality).

## Hardening & ops
- **Endpoint auth** — `/review` + `/action` are open. Add a secret token (env var), 401 if missing. ~2 lines. **Do before any public tunnel.**
- **Retries** — no `p-retry` yet; a transient error fails the draft (recover via `failed`→Approve). Wrap the 6 API calls, 3 attempts, 1→2→4s.
- **Observability** — structured logs go to stdout only. Add a log sink (Datadog/Loki) + alert on `failed` rows.
- **Auth-token refresh** — static env tokens. Move to a secrets manager with auto-reload.
- **Rate limits** — none for OpenAI/dev.to (LinkdAPI throttle is built). Add a token bucket under burst load.
- **Scale + scheduling** — runs a batch sequentially; `npm run watch` loops but there's no queue/cron. Add a queue (BullMQ/SQS) + a real scheduler.

## Synthesis at scale
- **Embedding prefilter** — today one judge call groups the whole batch. Add cosine-similarity clustering → judge confirms only candidates (~10× fewer tokens).
- **Streaming ingestion** — batch-per-cycle today. Add a sliding window (judge each new post vs the theme registry). The fingerprint model already supports the roll-ups.
- **Judge chunking** — cap ~30–40 posts/call; chunk larger batches, carrying themes forward.
- **Spoke→pillar back-links** — pillars link down to spokes today; add the reverse links + a cluster index page.

## Publishing
- **JSON-LD (Article + FAQPage + Organization)** — fully specced in `SPEC.md §16`, but dev.to strips it from the page `<head>`. Needs a self-hosted front end. (Blocked, not lazy.)

## Quality
- **Eval harness** — `docs/eval/` is the manual baseline. Automate it into a rubric-scored regression test that fails CI on a quality drop.
- **Originality pass** — push the originality ceiling (contrarian angle) without regressing voice/truth.

## Ingestion
- **Authorized ingestion** — demo uses LinkdAPI (unofficial, ToS risk; `seed` is the fallback). Swap to the CEO's own OAuth/export — a single adapter-file change.

## Repurposing follow-ups
- **Re-run hook** — `published` is terminal, so a failed promo kit can't be retried. Add a standalone `repurpose(draftId)` trigger.

## Deliberately NOT planned (choices, not gaps)
- Auto-posting variants to channels — violates the human gate; they're delivered to Slack to copy.
- A separate "approve the grouping" step — redundant; the content gate already catches bad groups.
- A durable orchestrator for the gate — the async status-table gate has no in-flight state to suspend.

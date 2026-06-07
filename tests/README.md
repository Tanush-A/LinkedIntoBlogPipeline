# Tests

## Running

| Command | What it does |
|---|---|
| `npm test` | Full fast suite — no network, no API cost |
| `npm run test:watch` | Re-runs on every file change |
| `npm run test:live` | Real Slack + dev.to smoke (manual, pre-demo only) |

## Design

All tests run against the **real code paths** — `db.ts`, the approval handlers, the generation chain, publish, notify. Only three external edges are mocked:

| Edge | How |
|---|---|
| OpenAI (model via `OPENAI_MODEL` env) | `vi.mock('openai')` — intercepts `new OpenAI()` and `chat.completions.create` |
| dev.to HTTP | `vi.stubGlobal('fetch', mockFetch)` — captures POST/PUT |
| Slack webhook | Same global fetch stub |

**DB isolation:** vitest's `pool: 'forks'` runs each test file in a separate child process, so each file gets its own `:memory:` SQLite instance (set via `vitest.config.ts env.DATABASE_URL`). Within a file, `_resetDbForTesting()` is called in `beforeEach` to wipe all rows between cases.

## Files

| File | What it covers |
|---|---|
| `gate.test.ts` | HTTP handler state machine: approve, reject, request-edits, failure, retry, edge cases |
| `dedup.test.ts` | `ingestPartitions()` dedup by `group_fingerprint` (judge fails open → 1:1) |
| `synthesis.test.ts` | Batch many:1: grouping judge (mocked) validation, fingerprint dedup/roll-up, N-post extract, verify corpus, posts table |
| `generation.test.ts` | 4-pass GPT chain with mocked LLM — orchestration and row shape |
| `notify.test.ts` | Slack webhook — message shape and review URL construction |
| `publish.test.ts` | dev.to field mapping, auth header, idempotency guard, DEVTO_DRAFT_MODE |
| `smoke.test.ts` | Real API smoke (gated by `RUN_LIVE=1`) |
| `setup.ts` | Seed-syncs the posts table once per worker (loadPosts reads the DB) |
| `helpers/fixtures.ts` | Shared `makeDraft()`, mock posts, mock LLM responses |

## Adding a test when a feature lands

Each `it.todo()` stub in the test files maps to an upcoming extension. When a feature lands:

1. Find the matching `it.todo(...)` in the relevant file.
2. Replace it with a full `it('description', async () => { ... })` block.
3. Follow the mock pattern of neighboring tests in that file:
   - Need an LLM response? `mockCreate.mockResolvedValueOnce({ choices: [{ message: { content: '...' } }] })`
   - Need a fetch response? `mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({...}) })`
4. Run `npm test` to confirm the suite is green.

### Extension map

| todo location | Feature |
|---|---|
| `gate.test.ts` › upcoming: verification layer | Banned-term + ungrounded-number checker |
| `gate.test.ts` › upcoming: re-score loop | Score-gated revision loop |
| `generation.test.ts` › upcoming: scorecard | AEO/GEO structure scorecard |
| `publish.test.ts` › upcoming: repurposing | Post-publish repurposing pipeline |
| `dedup.test.ts` › upcoming: synthesis | Multi-post synthesis grouping |

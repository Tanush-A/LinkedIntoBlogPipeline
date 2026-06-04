# Decision Log

Decisions are recorded in reverse chronological order.

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

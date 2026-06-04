// src/db.ts
// SQLite persistence for the content pipeline, via better-sqlite3 (synchronous API).
//
// insertDraft / getDraft / updateDraft are the ONLY DB access path. Every caller goes
// through them, so two concerns live in exactly one place:
//   1. JSON (de)serialization of object columns (extracted_idea, eval_scores).
//   2. undefined -> null coercion (better-sqlite3 rejects `undefined` as a bind value).
//
// Note: `critique` is stored verbatim. Per the Draft contract it is ALREADY a
// JSON-stringified CritiqueOutput (string), so the DB layer must not re-serialize it.
// The raw db handle is intentionally NOT exported — there is no bypass.

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Draft, DraftStatus, ExtractedIdea, EvalScores } from './types';

const DB_PATH = process.env.DATABASE_URL ?? './db/pipeline.sqlite';

// better-sqlite3 will not create the parent directory; do it ourselves (skip for in-memory).
if (DB_PATH !== ':memory:') {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const db = new Database(DB_PATH);
// Run A (writer) and Run B (reader) are separate processes hitting the same file.
// WAL lets readers proceed without blocking on the writer.
db.pragma('journal_mode = WAL');

// The six DraftStatus values, enforced at the DB layer via CHECK so an invalid
// status can never be persisted — defense in depth behind the TypeScript enum.
const STATUSES: DraftStatus[] = [
  'pending',
  'approved',
  'rejected',
  'needs_edits',
  'failed',
  'published',
];

db.exec(`
  CREATE TABLE IF NOT EXISTS drafts (
    id              TEXT PRIMARY KEY,
    source_post_id  TEXT NOT NULL,
    status          TEXT NOT NULL CHECK (status IN (${STATUSES.map((s) => `'${s}'`).join(', ')})),
    revision_count  INTEGER NOT NULL DEFAULT 0,
    reviewer_note   TEXT,
    extracted_idea  TEXT,   -- JSON(ExtractedIdea)
    raw_draft       TEXT,
    critique        TEXT,   -- JSON string of CritiqueOutput (already stringified by caller)
    revised_draft   TEXT,
    cms_url         TEXT,   -- NULL is the publish() idempotency guard
    eval_scores     TEXT,   -- JSON(EvalScores)
    created_at      TEXT NOT NULL,
    updated_at      TEXT NOT NULL
  );
`);

// Ingest dedups by querying for an existing source_post_id — index that lookup.
db.exec(`CREATE INDEX IF NOT EXISTS idx_drafts_source_post_id ON drafts (source_post_id);`);

// ---------------------------------------------------------------------------
// Row <-> Draft mapping
// ---------------------------------------------------------------------------

/** Raw shape as stored in SQLite: absent optionals are NULL, object columns are JSON text. */
interface DraftRow {
  id: string;
  source_post_id: string;
  status: string;
  revision_count: number;
  reviewer_note: string | null;
  extracted_idea: string | null;
  raw_draft: string | null;
  critique: string | null;
  revised_draft: string | null;
  cms_url: string | null;
  eval_scores: string | null;
  created_at: string;
  updated_at: string;
}

/** Columns a caller may write (everything except the `id` primary key). */
type WritableColumn =
  | 'source_post_id'
  | 'status'
  | 'revision_count'
  | 'reviewer_note'
  | 'extracted_idea'
  | 'raw_draft'
  | 'critique'
  | 'revised_draft'
  | 'cms_url'
  | 'eval_scores'
  | 'created_at'
  | 'updated_at';

/** Object columns serialized to JSON on write and parsed on read. */
const JSON_COLUMNS = new Set<WritableColumn>(['extracted_idea', 'eval_scores']);

/** Coerce a Draft field to a value better-sqlite3 will accept (string | number | null). */
function toBind(column: WritableColumn, value: unknown): string | number | null {
  if (value === undefined || value === null) return null;
  if (JSON_COLUMNS.has(column)) return JSON.stringify(value);
  return value as string | number;
}

/** Map a stored row back to a Draft, parsing JSON columns and dropping NULL optionals. */
function rowToDraft(row: DraftRow): Draft {
  return {
    id: row.id,
    source_post_id: row.source_post_id,
    status: row.status as DraftStatus,
    revision_count: row.revision_count,
    ...(row.reviewer_note != null ? { reviewer_note: row.reviewer_note } : {}),
    ...(row.extracted_idea != null
      ? { extracted_idea: JSON.parse(row.extracted_idea) as ExtractedIdea }
      : {}),
    ...(row.raw_draft != null ? { raw_draft: row.raw_draft } : {}),
    ...(row.critique != null ? { critique: row.critique } : {}),
    ...(row.revised_draft != null ? { revised_draft: row.revised_draft } : {}),
    ...(row.cms_url != null ? { cms_url: row.cms_url } : {}),
    ...(row.eval_scores != null
      ? { eval_scores: JSON.parse(row.eval_scores) as EvalScores }
      : {}),
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// Query helpers — the only DB access path
// ---------------------------------------------------------------------------

/** Insert input: a full Draft, with timestamps optional (stamped here if omitted). */
export type DraftInsert = Omit<Draft, 'created_at' | 'updated_at'> &
  Partial<Pick<Draft, 'created_at' | 'updated_at'>>;

/** Partial update: any Draft field except the immutable `id` and `created_at`. */
export type DraftUpdate = Partial<Omit<Draft, 'id' | 'created_at'>>;

const insertStmt = db.prepare(`
  INSERT INTO drafts (
    id, source_post_id, status, revision_count, reviewer_note,
    extracted_idea, raw_draft, critique, revised_draft, cms_url, eval_scores,
    created_at, updated_at
  ) VALUES (
    @id, @source_post_id, @status, @revision_count, @reviewer_note,
    @extracted_idea, @raw_draft, @critique, @revised_draft, @cms_url, @eval_scores,
    @created_at, @updated_at
  )
`);

export function insertDraft(input: DraftInsert): Draft {
  const now = new Date().toISOString();
  insertStmt.run({
    id: input.id,
    source_post_id: toBind('source_post_id', input.source_post_id),
    status: toBind('status', input.status),
    revision_count: toBind('revision_count', input.revision_count ?? 0),
    reviewer_note: toBind('reviewer_note', input.reviewer_note),
    extracted_idea: toBind('extracted_idea', input.extracted_idea),
    raw_draft: toBind('raw_draft', input.raw_draft),
    critique: toBind('critique', input.critique),
    revised_draft: toBind('revised_draft', input.revised_draft),
    cms_url: toBind('cms_url', input.cms_url),
    eval_scores: toBind('eval_scores', input.eval_scores),
    created_at: input.created_at ?? now,
    updated_at: input.updated_at ?? now,
  });

  const created = getDraft(input.id);
  if (!created) throw new Error(`insertDraft: row ${input.id} missing immediately after insert`);
  return created;
}

const getStmt = db.prepare(`SELECT * FROM drafts WHERE id = ?`);

export function getDraft(id: string): Draft | undefined {
  const row = getStmt.get(id) as DraftRow | undefined;
  return row ? rowToDraft(row) : undefined;
}

/** Columns updateDraft accepts — every writable column except the auto-managed timestamps. */
type UpdatableColumn = Exclude<WritableColumn, 'created_at' | 'updated_at'>;

const UPDATABLE_COLUMNS: UpdatableColumn[] = [
  'source_post_id',
  'status',
  'revision_count',
  'reviewer_note',
  'extracted_idea',
  'raw_draft',
  'critique',
  'revised_draft',
  'cms_url',
  'eval_scores',
];

/**
 * Apply a partial update and return the FRESH row. Callers must use the return
 * value (or re-getDraft) — `updateDraft` does not mutate any object they hold.
 * `updated_at` is always bumped.
 */
export function updateDraft(id: string, fields: DraftUpdate): Draft {
  const keys = (Object.keys(fields) as (keyof DraftUpdate)[]).filter(
    (k): k is UpdatableColumn => UPDATABLE_COLUMNS.includes(k as UpdatableColumn),
  );

  const setClauses = keys.map((k) => `${k} = @${k}`);
  setClauses.push(`updated_at = @updated_at`);

  const params: Record<string, string | number | null> = {
    id,
    updated_at: new Date().toISOString(),
  };
  for (const k of keys) params[k] = toBind(k, fields[k]);

  const info = db.prepare(`UPDATE drafts SET ${setClauses.join(', ')} WHERE id = @id`).run(params);
  if (info.changes === 0) throw new Error(`updateDraft: no draft with id ${id}`);

  const updated = getDraft(id);
  if (!updated) throw new Error(`updateDraft: row ${id} missing immediately after update`);
  return updated;
}

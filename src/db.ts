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
import type {
  Draft,
  DraftStatus,
  ExtractedIdea,
  EvalScores,
  VerificationResult,
  Post,
  PublishedRef,
} from './types';
import { groupFingerprint } from './lib/fingerprint';
import { splitTitleAndBody } from './lib/text';

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
    id               TEXT PRIMARY KEY,
    source_post_id   TEXT,             -- LEGACY: kept to avoid a table rebuild; see migration
    source_post_ids  TEXT NOT NULL,    -- JSON array of post ids
    group_fingerprint TEXT NOT NULL,   -- sha256 of sorted source_post_ids (dedup key)
    theme            TEXT,
    status           TEXT NOT NULL CHECK (status IN (${STATUSES.map((s) => `'${s}'`).join(', ')})),
    revision_count   INTEGER NOT NULL DEFAULT 0,
    reviewer_note    TEXT,
    extracted_idea   TEXT,   -- JSON(ExtractedIdea)
    raw_draft        TEXT,
    critique         TEXT,   -- JSON string of CritiqueOutput (already stringified by caller)
    revised_draft    TEXT,
    cms_url          TEXT,   -- NULL is the publish() idempotency guard
    eval_scores      TEXT,   -- JSON(EvalScores)
    verification     TEXT,   -- JSON(VerificationResult)
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
  );
`);

// posts table — the canonical post store. ingest upserts every post it sees
// (seed file or live LinkdAPI). loadPosts and the judge's existing-group member
// summaries read from this table, NOT the seed file.
//   status='active'    → in the candidate pool for grouping/generation
//   status='discarded' → triaged out (prefilter or judge skip); kept so it is never
//                        re-judged, and still resolvable for roll-ups. discard_reason logs why.
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id             TEXT PRIMARY KEY,
    url            TEXT NOT NULL,
    author         TEXT NOT NULL,
    text           TEXT NOT NULL,
    posted_at      TEXT,
    status         TEXT NOT NULL DEFAULT 'active',
    discard_reason TEXT,
    ingested_at    TEXT NOT NULL
  );
`);

// meta — tiny key/value store. Used so the always-on server (Run B) can read the
// watcher's (separate process) last-poll status for GET /status.
db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

// Migrations for existing db/pipeline.sqlite: CREATE TABLE IF NOT EXISTS is a no-op
// on an existing table, so new columns must be added separately. SQLite does not
// support ALTER TABLE ADD COLUMN IF NOT EXISTS — swallow the "duplicate column name"
// error that fires when a migration has already run.
for (const ddl of [
  `ALTER TABLE drafts ADD COLUMN verification TEXT`,
  `ALTER TABLE drafts ADD COLUMN source_post_ids TEXT`,
  `ALTER TABLE drafts ADD COLUMN group_fingerprint TEXT`,
  `ALTER TABLE drafts ADD COLUMN theme TEXT`,
  `ALTER TABLE posts ADD COLUMN status TEXT NOT NULL DEFAULT 'active'`,
  `ALTER TABLE posts ADD COLUMN discard_reason TEXT`,
]) {
  try {
    db.exec(ddl);
  } catch {
    // Column already exists — migration already applied.
  }
}

// JS backfill for rows that predate the source_post_ids column (runs once; no-op
// afterwards). ALTER TABLE cannot add NOT NULL columns to an existing table without a
// default, so the new columns land nullable on old DBs — this closes that gap at startup.
// A full table rebuild is the clean production migration (documented in the decision log,
// not built — acceptable for SQLite at this scale).
const legacyRows = db
  .prepare(`SELECT id, source_post_id FROM drafts WHERE source_post_ids IS NULL`)
  .all() as { id: string; source_post_id: string | null }[];
for (const r of legacyRows) {
  const ids = r.source_post_id ? [r.source_post_id] : [];
  db.prepare(`UPDATE drafts SET source_post_ids = ?, group_fingerprint = ? WHERE id = ?`)
    .run(JSON.stringify(ids), groupFingerprint(ids), r.id);
}

// Dedup now keys on group_fingerprint — index that lookup. The old source_post_id index
// is kept (harmless) so legacy queries against the legacy column stay fast.
db.exec(`CREATE INDEX IF NOT EXISTS idx_drafts_source_post_id ON drafts (source_post_id);`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_drafts_group_fingerprint ON drafts (group_fingerprint);`);

// ---------------------------------------------------------------------------
// Row <-> Draft mapping
// ---------------------------------------------------------------------------

/** Raw shape as stored in SQLite: absent optionals are NULL, object columns are JSON text. */
interface DraftRow {
  id: string;
  source_post_id: string | null;       // legacy column, never read into Draft
  source_post_ids: string | null;      // JSON array
  group_fingerprint: string | null;
  theme: string | null;
  status: string;
  revision_count: number;
  reviewer_note: string | null;
  extracted_idea: string | null;
  raw_draft: string | null;
  critique: string | null;
  revised_draft: string | null;
  cms_url: string | null;
  eval_scores: string | null;
  verification: string | null;
  created_at: string;
  updated_at: string;
}

/** Columns a caller may write (everything except the `id` primary key). */
type WritableColumn =
  | 'source_post_id'
  | 'source_post_ids'
  | 'group_fingerprint'
  | 'theme'
  | 'status'
  | 'revision_count'
  | 'reviewer_note'
  | 'extracted_idea'
  | 'raw_draft'
  | 'critique'
  | 'revised_draft'
  | 'cms_url'
  | 'eval_scores'
  | 'verification'
  | 'created_at'
  | 'updated_at';

/** Object columns serialized to JSON on write and parsed on read. */
const JSON_COLUMNS = new Set<WritableColumn>([
  'source_post_ids',
  'extracted_idea',
  'eval_scores',
  'verification',
]);

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
    source_post_ids: row.source_post_ids ? (JSON.parse(row.source_post_ids) as string[]) : [],
    group_fingerprint: row.group_fingerprint ?? '',
    ...(row.theme != null ? { theme: row.theme } : {}),
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
    ...(row.verification != null
      ? { verification: JSON.parse(row.verification) as VerificationResult }
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
    id, source_post_id, source_post_ids, group_fingerprint, theme,
    status, revision_count, reviewer_note,
    extracted_idea, raw_draft, critique, revised_draft, cms_url, eval_scores,
    verification,
    created_at, updated_at
  ) VALUES (
    @id, @source_post_id, @source_post_ids, @group_fingerprint, @theme,
    @status, @revision_count, @reviewer_note,
    @extracted_idea, @raw_draft, @critique, @revised_draft, @cms_url, @eval_scores,
    @verification,
    @created_at, @updated_at
  )
`);

export function insertDraft(input: DraftInsert): Draft {
  const now = new Date().toISOString();
  insertStmt.run({
    id: input.id,
    // Compat write: the legacy NOT-NULL column on old DBs needs a value. Nothing reads it.
    source_post_id: toBind('source_post_id', input.source_post_ids[0] ?? null),
    source_post_ids: toBind('source_post_ids', input.source_post_ids),
    group_fingerprint: toBind('group_fingerprint', input.group_fingerprint),
    theme: toBind('theme', input.theme),
    status: toBind('status', input.status),
    revision_count: toBind('revision_count', input.revision_count ?? 0),
    reviewer_note: toBind('reviewer_note', input.reviewer_note),
    extracted_idea: toBind('extracted_idea', input.extracted_idea),
    raw_draft: toBind('raw_draft', input.raw_draft),
    critique: toBind('critique', input.critique),
    revised_draft: toBind('revised_draft', input.revised_draft),
    cms_url: toBind('cms_url', input.cms_url),
    eval_scores: toBind('eval_scores', input.eval_scores),
    verification: toBind('verification', input.verification),
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

const getByFingerprintStmt = db.prepare(
  `SELECT * FROM drafts WHERE group_fingerprint = ? ORDER BY created_at DESC LIMIT 1`,
);

/** The dedup lookup: does a draft already exist for this exact group membership? */
export function getDraftByFingerprint(fp: string): Draft | undefined {
  const row = getByFingerprintStmt.get(fp) as DraftRow | undefined;
  return row ? rowToDraft(row) : undefined;
}

/** Every post id referenced by any draft — the "known posts" set for ingest dedup. */
export function getAllSourcePostIds(): Set<string> {
  const rows = db.prepare(`SELECT source_post_ids FROM drafts`).all() as {
    source_post_ids: string | null;
  }[];
  const out = new Set<string>();
  for (const r of rows) {
    if (!r.source_post_ids) continue;
    for (const id of JSON.parse(r.source_post_ids) as string[]) out.add(id);
  }
  return out;
}

/**
 * One record per distinct group (most recent draft per fingerprint), any status.
 * The judge receives these as EXISTING THEMES so it can attach new posts (roll-up).
 */
export function getGroupRecords(): {
  theme: string | null;
  source_post_ids: string[];
  group_fingerprint: string;
}[] {
  const rows = db
    .prepare(
      `SELECT theme, source_post_ids, group_fingerprint FROM drafts ORDER BY created_at DESC`,
    )
    .all() as { theme: string | null; source_post_ids: string | null; group_fingerprint: string | null }[];
  const seen = new Set<string>();
  const out: { theme: string | null; source_post_ids: string[]; group_fingerprint: string }[] = [];
  for (const r of rows) {
    if (!r.group_fingerprint || seen.has(r.group_fingerprint)) continue;
    seen.add(r.group_fingerprint);
    out.push({
      theme: r.theme,
      source_post_ids: r.source_post_ids ? (JSON.parse(r.source_post_ids) as string[]) : [],
      group_fingerprint: r.group_fingerprint,
    });
  }
  return out;
}

/** Published pieces for topic-cluster linking in pillar drafts. */
export function getPublishedRefs(): PublishedRef[] {
  const rows = db
    .prepare(
      `SELECT revised_draft, cms_url, source_post_ids FROM drafts
       WHERE status = 'published' AND cms_url IS NOT NULL`,
    )
    .all() as { revised_draft: string | null; cms_url: string; source_post_ids: string | null }[];
  return rows.map((r) => ({
    title: splitTitleAndBody(r.revised_draft ?? '').title,
    cms_url: r.cms_url,
    source_post_ids: r.source_post_ids ? (JSON.parse(r.source_post_ids) as string[]) : [],
  }));
}

// ---------------------------------------------------------------------------
// posts table — canonical post store (seed feeds it; live ingestion lands here)
// ---------------------------------------------------------------------------

interface PostRow {
  id: string;
  url: string;
  author: string;
  text: string;
  posted_at: string | null;
}

function rowToPost(row: PostRow): Post {
  return {
    id: row.id,
    url: row.url,
    author: row.author,
    text: row.text,
    ...(row.posted_at != null ? { posted_at: row.posted_at } : {}),
  };
}

const upsertPostStmt = db.prepare(`
  INSERT INTO posts (id, url, author, text, posted_at, status, discard_reason, ingested_at)
  VALUES (@id, @url, @author, @text, @posted_at, @status, @discard_reason, @ingested_at)
  ON CONFLICT(id) DO UPDATE SET
    url = excluded.url, author = excluded.author, text = excluded.text,
    posted_at = excluded.posted_at, status = excluded.status,
    discard_reason = excluded.discard_reason
`);

/**
 * Insert or update a post. ingested_at is set once (preserved on conflict).
 * Defaults to status='active'; pass { status, discardReason } to triage a post out.
 */
export function upsertPost(
  post: Post,
  opts: { status?: 'active' | 'discarded'; discardReason?: string } = {},
): void {
  upsertPostStmt.run({
    id: post.id,
    url: post.url,
    author: post.author,
    text: post.text,
    posted_at: post.posted_at ?? null,
    status: opts.status ?? 'active',
    discard_reason: opts.discardReason ?? null,
    ingested_at: new Date().toISOString(),
  });
}

/** Triage a post out of the candidate pool (prefilter or judge skip). */
export function discardPost(post: Post, reason: string): void {
  upsertPost(post, { status: 'discarded', discardReason: reason });
}

const getPostByIdStmt = db.prepare(`SELECT id, url, author, text, posted_at FROM posts WHERE id = ?`);

export function getPostById(id: string): Post | undefined {
  const row = getPostByIdStmt.get(id) as PostRow | undefined;
  return row ? rowToPost(row) : undefined;
}

export function getAllPosts(): Post[] {
  const rows = db.prepare(`SELECT id, url, author, text, posted_at FROM posts`).all() as PostRow[];
  return rows.map(rowToPost);
}

/** Posts in the candidate pool (status='active') — the input to grouping/generation. */
export function getActivePosts(): Post[] {
  const rows = db
    .prepare(`SELECT id, url, author, text, posted_at FROM posts WHERE status = 'active'`)
    .all() as PostRow[];
  return rows.map(rowToPost);
}

/** Ids of triaged-out posts — folded into the dedup set so they are never re-judged. */
export function getDiscardedPostIds(): Set<string> {
  const rows = db.prepare(`SELECT id FROM posts WHERE status = 'discarded'`).all() as { id: string }[];
  return new Set(rows.map((r) => r.id));
}

// ── meta key/value (cross-process status) ──────────────────────────────────────

const setMetaStmt = db.prepare(
  `INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
);

export function setMeta(key: string, value: string): void {
  setMetaStmt.run(key, value);
}

export function getMeta(key: string): string | undefined {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

/** Resolve post ids to full Post objects from the DB. Throws if any id is missing. */
export function loadPosts(ids: string[]): Post[] {
  return ids.map((id) => {
    const post = getPostById(id);
    if (!post) throw new Error(`loadPosts: post ${id} not found in posts table`);
    return post;
  });
}

/**
 * Columns updateDraft accepts — every writable column except the auto-managed timestamps
 * and the legacy `source_post_id` (write-once at insert; not a Draft field, never updated).
 */
type UpdatableColumn = Exclude<WritableColumn, 'created_at' | 'updated_at' | 'source_post_id'>;

const UPDATABLE_COLUMNS: UpdatableColumn[] = [
  'source_post_ids',
  'group_fingerprint',
  'theme',
  'status',
  'revision_count',
  'reviewer_note',
  'extracted_idea',
  'raw_draft',
  'critique',
  'revised_draft',
  'cms_url',
  'eval_scores',
  'verification',
];

/** Truncate DRAFT rows + meta — test isolation only. Posts persist (seed-synced once). */
export function _resetDbForTesting(): void {
  db.exec('DELETE FROM drafts');
  db.exec('DELETE FROM meta');
}

/** Truncate posts + meta — for live-ingestion tests that drive the posts table directly. */
export function _resetPostsForTesting(): void {
  db.exec('DELETE FROM posts');
  db.exec('DELETE FROM meta');
}

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

# SPEC-BATCH.md — Batch Many:1 Synthesis with Automated Grouping

> Implementation spec. Smallest viable change to the existing codebase.
> Read CLAUDE.md (Build Gotchas) first. All Non-Negotiables still apply.
> 1:1 generation is the n=1 case of this design — nothing existing breaks.

---

## 0. Concept

Ingestion delivers a batch of new posts. One LLM-judge call partitions the batch into
theme groups and singletons (and may attach new posts to previously-seen themes). The
pipeline then generates ONE draft per partition: a pillar draft for groups (n≥2), a
normal 1:1 draft for singletons (n=1). Dedup moves from per-post to per-group-fingerprint.

```
seed batch ─► dedup (known post ids) ─► manual groups.json override
                                              │ remaining posts
                                        LLM judge (1 call)
                                              │ partitions
                            ┌─────────────────┴───────────────┐
                      group (n≥2)                       singleton (n=1)
                            │                                  │
                    fingerprint exists? ──yes── skip   (same check)
                            │ no
                    generate ONE draft per partition ─► same gate/publish path
```

---

## 1. `src/types.ts`

**Change `Draft`:**

```typescript
// REMOVE:
  source_post_id: string;

// ADD (in its place):
  /** All source posts synthesized into this draft. n=1 for singletons. */
  source_post_ids: string[];
  /** sha256 of sorted source_post_ids — the dedup key. See src/lib/fingerprint.ts */
  group_fingerprint: string;
  /** Theme name assigned by the grouping judge (or groups.json override). */
  theme?: string;
```

**Add two interfaces:**

```typescript
/** One partition produced by the grouping judge (or seed/groups.json). */
export interface GroupPartition {
  theme: string;
  post_ids: string[];
  /** Judge's confidence this is a coherent group, 0–1. Overrides are 1.0. */
  confidence: number;
}

/** A published piece, passed to pillar drafts for topic-cluster linking. */
export interface PublishedRef {
  title: string;
  cms_url: string;
  source_post_ids: string[];
}
```

No other type changes. `ExtractedIdea`, `CritiqueOutput`, `VerificationResult` unchanged.

---

## 2. `src/lib/fingerprint.ts` (new file, ~10 lines)

```typescript
import { createHash } from 'node:crypto';

/** Deterministic group identity: same membership = same fingerprint, any order. */
export function groupFingerprint(postIds: string[]): string {
  return createHash('sha256').update([...postIds].sort().join('\n')).digest('hex');
}
```

A later batch attaching a new post to a prior theme produces a partition with changed
membership → new fingerprint → a new roll-up pillar draft. **This is intentional** (the
old draft, possibly published, remains — the roll-up complements it, see §6).

---

## 3. `src/db.ts`

**Schema (CREATE TABLE for fresh DBs):** replace `source_post_id TEXT NOT NULL` with:

```sql
source_post_id   TEXT,             -- LEGACY, kept to avoid a table rebuild; see migration
source_post_ids  TEXT NOT NULL,    -- JSON array of post ids
group_fingerprint TEXT NOT NULL,
theme            TEXT,
```

**Migration block** (same try/catch pattern as the existing `verification` migration):

```typescript
for (const ddl of [
  `ALTER TABLE drafts ADD COLUMN source_post_ids TEXT`,
  `ALTER TABLE drafts ADD COLUMN group_fingerprint TEXT`,
  `ALTER TABLE drafts ADD COLUMN theme TEXT`,
]) {
  try { db.exec(ddl); } catch { /* column exists */ }
}

// JS backfill for existing rows (runs once; no-op afterwards).
// Lazy-require fingerprint to avoid import cycles if any.
const legacyRows = db
  .prepare(`SELECT id, source_post_id FROM drafts WHERE source_post_ids IS NULL`)
  .all() as { id: string; source_post_id: string }[];
for (const r of legacyRows) {
  db.prepare(`UPDATE drafts SET source_post_ids = ?, group_fingerprint = ? WHERE id = ?`)
    .run(JSON.stringify([r.source_post_id]), groupFingerprint([r.source_post_id]), r.id);
}
```

Note: fresh-DB CREATE TABLE declares the new columns NOT NULL, but ALTER TABLE on an
existing DB cannot add NOT NULL columns without defaults — the backfill closes that gap
immediately at startup. Acceptable for SQLite at this scale; a full table rebuild is the
clean production migration (document in decision log, don't build).

**Row mapping / helpers:**

- `DraftRow`: add `source_post_ids: string | null`, `group_fingerprint: string | null`,
  `theme: string | null`. Keep `source_post_id` in the row type (legacy column).
- `JSON_COLUMNS`: add `'source_post_ids'`.
- `WritableColumn` / `UPDATABLE_COLUMNS` / insert statement + bind params: add the three
  new columns. **Compat write:** on insert, also write `source_post_id = input.source_post_ids[0]`
  into the legacy column (it may be NOT NULL on old DBs). Nothing reads it anymore.
- `rowToDraft`: parse `source_post_ids` with JSON.parse; map `group_fingerprint` and `theme`.
- **Replace** `getDraftBySourcePostId` with:

```typescript
const getByFingerprintStmt = db.prepare(
  `SELECT * FROM drafts WHERE group_fingerprint = ? ORDER BY created_at DESC LIMIT 1`,
);
export function getDraftByFingerprint(fp: string): Draft | undefined { ... }

/** Every post id referenced by any draft — the "known posts" set for ingest dedup. */
export function getAllSourcePostIds(): Set<string> {
  const rows = db.prepare(`SELECT source_post_ids FROM drafts`).all() as
    { source_post_ids: string | null }[];
  const out = new Set<string>();
  for (const r of rows) if (r.source_post_ids)
    for (const id of JSON.parse(r.source_post_ids) as string[]) out.add(id);
  return out;
}

/** Published pieces for topic-cluster linking in pillar drafts. */
export function getPublishedRefs(): PublishedRef[] {
  // SELECT revised_draft, cms_url, source_post_ids WHERE status='published' AND cms_url IS NOT NULL
  // title via splitTitleAndBody(revised_draft) — import from publish.ts (see §8)
}
```

- Index: `CREATE INDEX IF NOT EXISTS idx_drafts_group_fingerprint ON drafts (group_fingerprint);`
  (keep the old source_post_id index; it's harmless).

---

## 4. `prompts/group.ts` (new file) + `src/pipeline/group.ts` (new file)

### `prompts/group.ts`

```typescript
// prompts/group.ts
// Grouping judge — partitions a batch of posts into theme groups + singletons.
// Call with response_format: { type: "json_object" }, strong model.

import type { Post } from '../src/types';

export interface ExistingGroupSummary {
  theme: string;
  member_post_ids: string[];
  /** First line of each member post, for the judge's context. */
  member_summaries: string[];
}

const SYSTEM = `\
You are an editorial planner for a B2B revenue-intelligence blog. You receive a batch of
LinkedIn posts and must partition them into groups that should each become ONE blog post.

Group posts together ONLY when they argue the same underlying thesis or attack the same
problem from angles that belong in one piece. Surface-level keyword overlap ("both mention
AI") is NOT grounds for grouping. A reader of the resulting blog post must experience the
sources as one coherent argument, not a stapled-together digest.

Posts that stand alone stay alone — singletons are the normal case, groups are the
exception that must earn itself.

You also receive EXISTING THEMES with their member posts. If a new post clearly belongs
to an existing theme, output a partition containing the existing members' ids PLUS the
new post's id — this triggers an intentional roll-up piece. Only do this when the new
post genuinely extends the theme; do not force attachment.

Return JSON only, exactly this shape:
{
  "partitions": [
    {
      "theme": "Short editorial theme name, e.g. 'Fragmented data breaks revenue AI'",
      "post_ids": ["id1", "id2"],
      "confidence": 0.85
    }
  ]
}

Rules:
- EVERY new post id appears in EXACTLY ONE partition. No omissions, no duplicates.
- Singletons are partitions with one post_id. Give them a theme too.
- confidence is your belief (0–1) that the group is editorially coherent. Singletons: 1.0.
- Existing-member ids may ONLY appear in a partition that also contains at least one new id.`;

export function buildGroupingMessages(
  newPosts: Post[],
  existingGroups: ExistingGroupSummary[],
) {
  const postsBlock = newPosts
    .map((p) => `<post id="${p.id}">\n${p.text}\n</post>`)
    .join('\n\n');
  const groupsBlock = existingGroups.length
    ? existingGroups
        .map(
          (g) =>
            `<existing_theme name="${g.theme}" member_ids="${g.member_post_ids.join(',')}">\n` +
            g.member_summaries.map((s) => `- ${s}`).join('\n') +
            `\n</existing_theme>`,
        )
        .join('\n\n')
    : '(none yet)';

  const user = `\
NEW POSTS (partition all of these):

${postsBlock}

EXISTING THEMES (attach new posts only if they genuinely extend one):

${groupsBlock}

Return JSON only.`;

  return [
    { role: 'system' as const, content: SYSTEM },
    { role: 'user' as const, content: user },
  ];
}
```

### `src/pipeline/group.ts`

```typescript
// One judge call + deterministic validation. Fail-open to singletons.
export async function partitionPosts(
  newPosts: Post[],
  existingGroups: ExistingGroupSummary[],
): Promise<GroupPartition[]>
```

Implementation requirements:

1. Call OpenAI: `model: process.env.OPENAI_MODEL ?? 'gpt-5.5'`, `response_format: json_object`,
   `buildGroupingMessages(newPosts, existingGroups)`.
2. **Validate deterministically** (the judge is untrusted input):
   - Every partition `post_ids` must be non-empty, ids must exist in
     `newPosts ∪ existingGroups members`, no id in two partitions.
   - Every NEW post id must be covered. Any new id missing → append as a singleton
     partition `{ theme: first line of the post (≤60 chars), post_ids: [id], confidence: 1 }`.
   - Any partition containing an unknown id, a duplicated id, or ONLY existing-member ids
     → drop the partition; re-cover its new ids as singletons.
3. **Confidence floor:** partitions with `post_ids.length ≥ 2` and
   `confidence < GROUP_CONFIDENCE_MIN` (env, default `0.6`) → split into singletons.
4. On ANY judge failure (API error, unparseable JSON): return all new posts as singletons
   and log `[group] judge failed — falling back to singletons`. Generation must never be
   blocked by grouping.
5. Log one line per final partition: `[group] theme="..." n=2 confidence=0.85`.

Existing-group summaries for the judge: build from the DB — every draft (any status)
contributes `{ theme: draft.theme ?? '(untitled)', member_post_ids: draft.source_post_ids,
member_summaries: first line of each member post from seed }`. Dedup identical themes
(same fingerprint) — use the most recent draft per fingerprint.

---

## 5. `src/pipeline/ingest.ts` — rewrite

New contract: ingest returns partitions ready for generation, not posts.

```typescript
export interface IngestPartition {
  theme: string;
  posts: Post[];          // full Post objects, including rolled-up existing members
  fingerprint: string;
}

export async function ingestPartitions(): Promise<IngestPartition[]>
```

Flow:

1. Read `seed/posts.json` → all posts. Build `byId` map.
2. `known = getAllSourcePostIds()`; `newPosts = posts.filter(p => !known.has(p.id))`.
   If empty → return `[]`.
3. **Manual override:** if `seed/groups.json` exists, parse as
   `{ theme: string; post_ids: string[] }[]`. Each entry whose post_ids are all present in
   the seed becomes a forced partition (confidence 1.0). Posts covered by groups.json are
   removed from the judge's input. Invalid entries (unknown ids) → log warn, skip entry.
4. Judge: `partitionPosts(remainingNewPosts, existingGroupSummaries)`.
5. For every partition (override + judged): `fingerprint = groupFingerprint(post_ids)`;
   if `getDraftByFingerprint(fingerprint)` exists → skip (idempotency — re-running the same
   batch is a no-op, exactly like today's per-post dedup).
6. Resolve `post_ids → Post[]` via `byId` (roll-up partitions include existing members'
   posts — they're in the seed). Missing id → log error, skip partition (do not throw).
7. Return surviving partitions.

`seed/groups.json` is gitignored-optional: absent = fully automatic grouping.

---

## 6. `prompts/extract.ts` — N-post synthesis

Signature: `buildExtractionMessages(posts: Post[])`. n=1 must behave exactly as today.

**System prompt — replace the first two paragraphs with:**

```
You are a content strategist. You receive ONE OR MORE LinkedIn posts by the same author
and must extract ONE unified idea to inspire a single original blog post.

With multiple posts: find the through-line — the single thesis the posts are
collectively arguing. Repetition across posts is EMPHASIS (that point is the core, weight
it accordingly). Differences between posts are NUANCE (facets of the thesis, candidates
for supporting_points — not separate theses). Choose the strongest evidence and the
sharpest tension across ALL posts; discard weaker duplicates of the same point. Do NOT
produce a list-of-topics summary — the output is one argument, not a digest.

The blog post will be written for Terret, an AI revenue platform. Your extraction must
identify what is genuinely interesting and worth building on, separate from the author's
specific wording or examples.
```

**Rules list — add one rule:**

```
- With multiple posts, do_not_reuse must cover ALL input posts — collect each post's
  signature phrases, named examples, and framings.
```

JSON shape unchanged (no type changes). **User message:**

```typescript
const postsBlock = posts
  .map((p) => `<post url="${p.url}">\n${p.text}\n</post>`)
  .join('\n\n');

const user = `\
Extract the unified core idea from ${posts.length === 1 ? 'this LinkedIn post' : `these ${posts.length} LinkedIn posts`} by ${posts[0].author}.

${postsBlock}

Return JSON only. No preamble, no explanation, no markdown.`;
```

---

## 7. `prompts/draft.ts` — plumbing only (prompt design unchanged)

Signature: `buildDraftMessages(posts: Post[], extracted: ExtractedIdea, productContext: string, publishedRefs: PublishedRef[] = [])`.

Changes to the **user message only** (system prompt untouched):

1. Source block renders N posts:

```typescript
const sourceBlock = posts
  .map((p) => `<source_post author="${p.author}" url="${p.url}">\n${p.text}\n</source_post>`)
  .join('\n');
```

2. **Topic-cluster context** — insert after `<product_context>`, only when
   `publishedRefs.length > 0`:

```
<published_pieces>
These pieces are ALREADY PUBLISHED on the blog from some of the same source material:
${publishedRefs.map((r) => `- "${r.title}" — ${r.cms_url}`).join('\n')}
</published_pieces>

This piece must COMPLEMENT the published pieces, not duplicate them: write the broader
theme essay that stands above them, and where it is natural — at most once per published
piece — link to one with a markdown link as the deeper dive on that sub-point. Do not
re-argue a published piece's specific argument; reference and build on it.
```

Caller passes only refs whose `source_post_ids` intersect the partition's post ids.
Canonical/linking note (document in SPEC §7, no code): every piece stays self-canonical
(dev.to default). The cluster signal is the internal links themselves — pillar links down
to spokes; spoke→pillar links are a future edit, mapped not built.

`critique.ts` and `revise.ts`: **no changes.**

---

## 8. `src/pipeline/generate.ts`, `publish.ts`, `notify.ts`, `regenerate.ts`

**generate.ts:**
- Signature: `generate(posts: Post[], publishedRefs: PublishedRef[] = []): Promise<GenerateResult>`.
- Extract call: `buildExtractionMessages(posts)`.
- Draft call: `buildDraftMessages(posts, extracted, PRODUCT_CONTEXT_BLOCK, publishedRefs)`.
- Both `verifyDraft` calls: `verifyDraft(text, posts.map((p) => p.text))` — figures cited
  by ANY source post are grounded.
- Rescore-artifact filename: keep `post.id` → use `posts[0].id` plus partition size, e.g.
  `${posts[0].id}-n${posts.length}-iter-${i}.md`.
- Log lines: `post=${posts.map(p => p.id).join('+')}` (or first id + `+n`).

**publish.ts:** export `splitTitleAndBody` (db.ts §3 needs it for `getPublishedRefs`).
No other change.

**notify.ts:** signature `notify(draft: Draft, posts: Post[])`. Title line:
`posts[0]` first line + (n>1 ? ` (+${n-1} more sources)` : ''). Source line: first post's
URL + same suffix. Include `draft.theme` in the message when set.

**regenerate.ts:** `loadPost(sourcePostId)` → `loadPosts(ids: string[]): Post[]` (same
seed-file lookup, returns all; throw if any missing). Use
`verifyDraft(content, posts.map(p => p.text))` and `notify(fresh, posts)`.
(Optional cleanup: move `loadPosts` to `src/lib/seed.ts` and reuse from ingest — fine either way.)

**run.ts** (orchestrator): loop partitions instead of posts:

```typescript
const partitions = await ingestPartitions();
const publishedRefs = getPublishedRefs();
for (const part of partitions) {
  const refs = publishedRefs.filter((r) =>
    r.source_post_ids.some((id) => part.posts.some((p) => p.id === id)));
  const result = await generate(part.posts, refs);
  insertDraft({
    id: randomUUID(),
    source_post_ids: part.posts.map((p) => p.id),
    group_fingerprint: part.fingerprint,
    theme: part.theme,
    status: 'pending',
    revision_count: 0,
    ...result,  // critique already JSON-stringified by generate
  });
  await notify(draft, part.posts);
}
```

---

## 9. Tests to update / add

- db tests: insert/read round-trip with `source_post_ids` array, fingerprint lookup,
  `getAllSourcePostIds`, migration backfill (insert legacy-shaped row, reopen, assert backfill).
- ingest: same batch twice → second run yields zero partitions (fingerprint dedup).
- group.ts validation: mock judge output with a missing id / duplicated id / unknown id /
  low-confidence pair → assert singleton fallbacks. Mock judge throw → all singletons.
- fingerprint: order-insensitivity (`['a','b']` === `['b','a']`).
- generate/notify/regenerate signatures: fix existing call sites in tests.

---

## 10. Documented, NOT built (add to SPEC.md §13 stretch/mapped notes)

- **Judge batch limits:** one judge call must fit the batch + existing-theme summaries in
  context. Cap `JUDGE_BATCH_MAX` ≈ 30–40 posts per call at typical LinkedIn-post length;
  larger batches: chunk into sequential judge calls, carrying themes forward as
  existing-group context.
- **Production grouping:** embedding prefilter (cluster by cosine similarity) → LLM judge
  confirms/labels only the candidate clusters. Cuts judge tokens by ~10x and scales past
  context limits.
- **Continuous ingestion evolution:** streaming posts get a sliding window — each new post
  is judged against the theme registry (attach / new singleton); periodic batch pass
  consolidates singletons into emergent groups. The fingerprint model already supports
  this (attachment = new fingerprint = roll-up).

---

## Decision log entries (append to docs/decision-log.md)

- Group identity = hash of sorted member ids; membership change = new draft (roll-up) — chosen over mutable groups to keep drafts immutable and the gate simple.
- Judge is untrusted: deterministic validation, fail-open to singletons — generation is never blocked by grouping.
- Legacy `source_post_id` column kept + compat-written (avoids SQLite table rebuild); reads go through `source_post_ids` only.
- `seed/groups.json` = manual override path; absent = fully automatic.

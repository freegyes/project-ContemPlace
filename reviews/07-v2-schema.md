# Schema Review — Implementation Plan v2

Review of the v2 migration SQL in `reviews/06-implementation-plan-v2.md`, cross-referenced against the Phase 1 schema review (`reviews/04-schema.md`), the production migration (`supabase/migrations/20260101000000_initial_schema.sql`), and the recommendation document (`planning-inputs/note_taking_recommendations.md`).

---

## 1. SQL Correctness

### 1a. [Critical] `content_tsv` generated column will fail on `NOT NULL` column `body`

The generated column expression is:

```sql
content_tsv tsvector generated always as (
  to_tsvector('english', coalesce(title, '') || ' ' || coalesce(body, '') || ' ' || raw_input)
) stored
```

`body` is declared `text not null`, so `coalesce(body, '')` is harmless but misleading. However, the real problem is that `raw_input` is not wrapped in `coalesce`. If `raw_input` is ever null — which the constraint prevents today — the expression would fail. That is fine for now. But there is a deeper issue: **including `raw_input` in the tsvector means full-text search will match against the user's raw dictation including garbled words, typos, and filler that the capture agent deliberately cleaned up.** A search for "cattle stitch" would match even though the note says "kettle stitch." This is probably unintentional. The Phase 1 schema and the recommendation doc's `content_tsv` example only include `title` and `raw_content` (the recommendation doc's equivalent of `body`).

**Fix:** Remove `raw_input` from the generated column unless matching against raw dictation is a deliberate feature. Replace with:

```sql
content_tsv tsvector generated always as (
  to_tsvector('english', coalesce(title, '') || ' ' || body)
) stored
```

Or, if you want full-text search across cleaned content only: `title || ' ' || body`. Both `title` and `body` are `NOT NULL`, so `coalesce` is unnecessary for either.

### 1b. [Important] `create extension if not exists vector schema extensions` — schema clause behavior

The v1 production migration uses `create extension if not exists vector` (no schema clause), which installs the extension in the `public` schema. The v2 migration uses `create extension if not exists vector schema extensions`, which installs it in the `extensions` schema. On Supabase, pgvector is typically pre-installed in the `extensions` schema. This is fine.

However, the v2 RPC functions reference `extensions.match_notes` and `extensions.match_chunks` as their qualified names (via `create or replace function extensions.match_notes(...)`), but the function bodies reference `public.notes` and `public.note_chunks`. The functions are created in the `extensions` schema.

**The issue:** Supabase's PostgREST (which backs the `.rpc()` client call) exposes functions from schemas listed in `db_extra_search_path` or the default `public` schema. Functions in the `extensions` schema are **not** exposed to PostgREST by default. This means `db.rpc('match_notes', {...})` from the Supabase JS client will return a 404 or "function not found" error unless `extensions` is added to `db_extra_search_path` in the Supabase dashboard.

The v1 production schema creates `match_notes` in the `public` schema (no schema prefix). It works today. Moving the function to `extensions` will break the existing RPC call.

**Fix:** Create the functions in the `public` schema (drop the `extensions.` prefix), or keep them in `extensions` and add `extensions` to `db_extra_search_path` in the Supabase project settings. The simpler fix:

```sql
create or replace function match_notes(...)
-- not extensions.match_notes(...)
```

The `set search_path = ''` clause on the function is correct and good practice — it forces fully qualified table references inside the body, preventing search_path injection attacks. Keep that. Just don't create the function in the `extensions` schema.

### 1c. [Important] `vector_cosine_ops` requires the vector extension's operators to be in `search_path` when `search_path = ''`

With `set search_path = ''`, the `<=>` operator (cosine distance) must be resolvable. Postgres resolves operators via the search_path, but operators installed by extensions are in whichever schema the extension was installed in. If the extension is in `extensions` schema and the function's search_path is empty, `<=>` may not resolve.

On Supabase, the default `search_path` includes `public, extensions`, which is why this works for ad-hoc queries. But a function with `set search_path = ''` explicitly strips this. The `<=>` operator is defined by pgvector and lives in whatever schema the extension occupies.

**Fix:** Set the function's search_path to include the extension schema:

```sql
set search_path = 'extensions'
```

Or, if the extension is installed in `public`:

```sql
set search_path = 'public'
```

This needs to match where the vector extension is actually installed. On most Supabase instances, that is `extensions`. The safest option:

```sql
set search_path = 'public, extensions'
```

This restores operator resolution while still preventing unqualified table access (since table references in the function body are already `public.notes`, `public.note_chunks`).

### 1d. [Advisory] `GENERATED ALWAYS AS` with `coalesce` on Supabase

Supabase uses Postgres 15+ (recently upgraded from 14). Generated columns with `coalesce` and string concatenation work correctly on Postgres 12+. The `GENERATED ALWAYS AS (...) STORED` syntax is valid. No issue here.

### 1e. [Advisory] `float` vs `double precision` vs `real`

The `confidence` and `importance_score` columns use `float`, which Postgres interprets as `double precision` (8 bytes). The `match_threshold` function parameter also uses `float`. This is consistent and fine. Just noting that `float` in Postgres is `float8` (double precision), not `float4` (real). At this scale the storage difference is irrelevant.

---

## 2. Index Strategy

### 2a. [Advisory] Dual HNSW indexes (`notes_embedding_idx` and `note_chunks_embedding_idx`) at small scale

Both `notes` and `note_chunks` get HNSW indexes with `m=16, ef_construction=128`. At small scale (hundreds to low thousands of rows), Postgres will ignore both indexes in favor of sequential scans. The indexes cost nothing at insert time for small tables and will become useful as the collection grows. No issue — creating them now avoids a disruptive migration later.

### 2b. [Advisory] GIN index on `entities` JSONB — useful but with caveats

```sql
create index notes_entities_idx on notes using gin (entities);
```

The default GIN operator class for JSONB is `jsonb_ops`, which supports `@>`, `?`, `?|`, `?&` operators. For the expected query pattern ("find notes mentioning person X"), the query would be:

```sql
WHERE entities @> '[{"name": "John"}]'::jsonb
```

This works with the GIN index. However, it requires the caller to construct the exact JSON containment structure. A query like `WHERE entities::text ILIKE '%John%'` would not use the index.

**If queries will primarily search by entity name as a string, consider `jsonb_path_ops` instead** (smaller index, faster `@>` queries, but does not support `?` key-existence checks):

```sql
create index notes_entities_idx on notes using gin (entities jsonb_path_ops);
```

This is advisory. The current index works. Revisit if entity queries become a hot path.

### 2c. [Advisory] `links_type_idx` on `link_type` — low cardinality

```sql
create index links_type_idx on links (link_type);
```

With only 8 possible values, the selectivity of this index is poor. Postgres will almost always prefer a sequential scan for `WHERE link_type = 'extends'` unless the table is very large and one type is very rare. This index is harmless but unlikely to be used. Consider removing it to reduce write overhead, or accept it as documentation of a supported query pattern.

### 2d. [Advisory] Missing index on `enrichment_log(note_id, enrichment_type)`

The `enrichment_log` table has `create index enrichment_log_note_idx on enrichment_log (note_id)`. If the gardening pipeline checks "has this enrichment already been run for this note?" (a likely query), a composite index on `(note_id, enrichment_type)` would be more useful:

```sql
create index enrichment_log_note_type_idx on enrichment_log (note_id, enrichment_type);
```

---

## 3. Schema Design

### 3a. [Important] CHECK constraints vs. enums vs. reference tables

The v2 schema uses CHECK constraints on `type`, `intent`, `modality`, `maturity`, `link_type`, and `created_by`. The Phase 1 schema review (04-schema.md) explicitly endorses this approach:

> Dropping and re-adding a check constraint is fast (no table rewrite) and safe on a live table. This is preferable to a Postgres ENUM type, which requires ALTER TYPE ... ADD VALUE and has restrictions on rollback. Plain text with a check constraint is easier to evolve.

This reasoning is sound. CHECK constraints are the right choice for this system. No issue.

### 3b. [Advisory] `corrections text[]` — sufficient for current use

The `corrections` column stores voice dictation fixes as `text[]` (e.g., `["cattle stitch → kettle stitch"]`). The recommendation doc and the current production system both use this format. A JSONB alternative (`[{"from": "cattle stitch", "to": "kettle stitch"}]`) would enable richer querying (e.g., "show me all corrections involving word X"), but this adds complexity with no current consumer. `text[]` is the right choice for now. If correction analytics become a feature, migrate to JSONB then.

### 3c. [Advisory] `note_concepts` missing `ON DELETE CASCADE` on `concept_id`

```sql
create table note_concepts (
  note_id     uuid references notes(id) on delete cascade,
  concept_id  uuid references concepts(id) on delete cascade,
  primary key (note_id, concept_id)
);
```

This is correctly specified — both FKs have `ON DELETE CASCADE`. If a concept is deleted, its junction rows are cleaned up. If a note is deleted, its concept associations are cleaned up. No issue.

### 3d. [Advisory] `concepts.broader_id` self-referencing FK — correct but needs ON DELETE consideration

```sql
broader_id uuid references concepts(id)
```

No `ON DELETE` clause means the default is `NO ACTION` — deleting a parent concept while children reference it will fail with a foreign key violation. This is the safest behavior: it prevents orphaning child concepts. However, it means you cannot delete a concept without first reassigning or deleting its children. This is correct for a controlled vocabulary where hierarchy matters.

---

## 4. Generated Column

### 4a. [Critical] `raw_input` in `content_tsv` — see issue 1a above

Including `raw_input` in the full-text search vector means uncorrected dictation artifacts are searchable. This is the same issue as 1a.

### 4b. [Advisory] Performance of `content_tsv` generated column

The `STORED` generated column recomputes on every `INSERT` and `UPDATE` of any column in the expression (`title`, `body`, `raw_input`). For this system — where notes are inserted once and rarely updated — the cost is negligible. The GIN index on `content_tsv` updates on each write, which is more expensive than the tsvector computation itself, but still trivial at this scale. No issue.

---

## 5. Migration Safety

### 5a. [Important] Drop sequence is correct but includes tables not in the current production schema

The proposed drop sequence:

```sql
DROP TABLE IF EXISTS trail_steps CASCADE;
DROP TABLE IF EXISTS trails CASCADE;
DROP TABLE IF EXISTS enrichment_log CASCADE;
DROP TABLE IF EXISTS note_chunks CASCADE;
DROP TABLE IF EXISTS note_concepts CASCADE;
DROP TABLE IF EXISTS concepts CASCADE;
DROP TABLE IF EXISTS links CASCADE;
DROP TABLE IF EXISTS notes CASCADE;
DROP TABLE IF EXISTS note_types CASCADE;
DROP TABLE IF EXISTS processed_updates CASCADE;
```

`trail_steps`, `trails`, `note_chunks`, `note_concepts`, `concepts`, `enrichment_log`, and `note_types` do not exist in the current production schema. The `IF EXISTS` clause handles this correctly — the statements are no-ops for missing tables. The `CASCADE` is also correct: it drops dependent objects (foreign keys, policies, indexes) automatically.

The FK dependency order is respected: child tables (`links`, `note_concepts`, etc.) are dropped before parent tables (`notes`, `concepts`). With `CASCADE` this order is technically unnecessary, but it is good practice. No issue.

### 5b. [Important] `DELETE FROM supabase_migrations.schema_migrations` — works but with a caveat

This clears Supabase's migration tracking table, so `supabase db push` treats the new migration file as unapplied. This is correct for a full drop-and-recreate scenario.

**Caveat:** On some Supabase instances, the `supabase_migrations` schema may have RLS enabled or the table may require superuser access. The service role key (used in the SQL Editor) should have sufficient privileges. If it does not, run this as the `postgres` user in the SQL Editor (which has superuser privileges by default on Supabase).

Also, if there are other migration files in `supabase/migrations/` that should remain tracked, deleting all rows is too aggressive. Since the plan says to delete the old migration file, this is fine — there is only one migration, and it is being replaced.

### 5c. [Advisory] `DROP FUNCTION` not included in the drop sequence

The existing `match_notes` function and `update_updated_at` trigger function are not explicitly dropped. The `CREATE OR REPLACE FUNCTION` statements in the new migration will overwrite them. However, if the function signature changes (e.g., new parameters), `CREATE OR REPLACE` will fail because Postgres does not allow replacing a function with a different signature — it requires `DROP FUNCTION` first.

The v2 `match_notes` has a different signature than v1 (two new parameters: `filter_intent` and `search_text`). **`CREATE OR REPLACE` will not work here — it will create a new overloaded function with the expanded signature, leaving the old one in place.**

**Fix:** Add explicit `DROP FUNCTION` statements to the drop sequence:

```sql
DROP FUNCTION IF EXISTS match_notes;
DROP FUNCTION IF EXISTS update_updated_at;
```

Or, if you want to be precise about which overload to drop:

```sql
DROP FUNCTION IF EXISTS match_notes(vector(1536), float, int, text, text, text[]);
```

Since this is a full drop-and-recreate, the simpler form (no argument list) is fine. Add it before the table drops.

---

## 6. RPC Functions

### 6a. [Critical] `extensions.match_notes` — PostgREST cannot find functions in `extensions` schema

See issue 1b. The function must be in a schema that PostgREST exposes. Use `public` or configure `db_extra_search_path`.

### 6b. [Critical] `search_path = ''` breaks the `<=>` operator resolution

See issue 1c. The `<=>` operator from pgvector must be resolvable on the function's search_path.

### 6c. [Important] Hybrid search — vector + full-text in a single query

The `match_notes` function applies both `embedding <=> query_embedding` (vector distance) and `content_tsv @@ plainto_tsquery(...)` (full-text match) in the same `WHERE` clause, then orders by vector distance only.

This is a conjunctive filter: results must match **both** vector similarity **and** full-text keywords. The ordering is by vector distance alone. This means:

1. Full-text search narrows the candidate set, then vector similarity ranks within it.
2. If a note is semantically similar but does not contain the exact search keywords, it is excluded.
3. If `search_text` is null, the full-text filter is skipped entirely (correct).

This design is intentional and matches the recommendation doc's "metadata pre-filtering" pattern. The performance concern is whether Postgres can use both the HNSW index and the GIN index in a single query plan. In practice, Postgres will likely use the GIN index to pre-filter, then evaluate vector distance on the reduced set. This is efficient. At small scale, a sequential scan over the GIN-filtered set is fine.

**One performance note:** The `WHERE 1 - (n.embedding <=> query_embedding) > match_threshold` clause prevents the HNSW index from being used for an index-only scan with a `LIMIT`. The HNSW index supports `ORDER BY embedding <=> query_embedding LIMIT N` as a single indexed operation, but adding a `WHERE` clause on the same expression forces Postgres to evaluate every candidate, not just the top-N nearest. At small scale this does not matter. At large scale, consider using a subquery:

```sql
-- More index-friendly pattern (for future optimization):
SELECT * FROM (
  SELECT *, 1 - (embedding <=> query_embedding) as similarity
  FROM notes
  WHERE embedding IS NOT NULL AND archived_at IS NULL
  ORDER BY embedding <=> query_embedding
  LIMIT match_count * 3  -- over-fetch, then filter
) sub
WHERE similarity > match_threshold
  AND (filter_type IS NULL OR type = filter_type)
  -- ...other filters
LIMIT match_count;
```

This is advisory for now. The current approach works.

### 6d. [Advisory] `match_chunks` does not filter by note-level metadata

The `match_chunks` function joins `note_chunks` to `notes` but only uses notes for `archived_at` and `title`. It does not accept `filter_type`, `filter_intent`, or `search_text` parameters. For Phase 2 MCP use, chunk retrieval filtered by note metadata (e.g., "find chunks from reflection-type notes") would be useful. Consider adding these parameters to `match_chunks` when the MCP server is built, not now.

---

## 7. SKOS Concepts Design

### 7a. [Advisory] `alt_labels text[]` — array vs. separate table

The recommendation doc uses `alt_labels TEXT[] DEFAULT '{}'` for synonyms. The v2 schema faithfully implements this.

A separate `concept_labels` table (`concept_id, label, label_type`) would enable:
- Querying all concepts matching a given synonym efficiently (with an index on `label`)
- Distinguishing `altLabel` from `hiddenLabel` (SKOS distinction)
- Adding language tags per label

However, for a personal system with tens of concepts, querying `WHERE alt_labels @> ARRAY['bike']` against the `text[]` column is fast enough. The array approach is simpler and sufficient. This decision is correct.

### 7b. [Advisory] `concepts.embedding` — good addition, not in seed data

The concepts table has an `embedding vector(1536)` column. The seed SQL does not populate it. The plan states embeddings are populated later by the gardening pipeline. This is consistent with the capture-then-enrich philosophy. No issue, but note that until concept embeddings are populated, SKOS-based tag normalization via cosine similarity (the intended use case) will not work — it requires both note embeddings and concept embeddings to exist.

### 7c. [Advisory] No index on `concepts.embedding`

There is no HNSW index on `concepts.embedding`. With tens of concepts, a sequential scan is faster than an index lookup. An HNSW index would be wasteful here. Correct omission.

---

## 8. Comparison to Recommendation Doc

The recommendation doc proposes a four-primitive hybrid:

| Primitive | Recommendation doc | v2 schema | Status |
|---|---|---|---|
| Type system (Tana/Anytype) | `note_types` table with inheritance and JSON Schema | Deferred to Phase 3 | **Intentional deferral** — the 4-type CHECK constraint is sufficient until diverse content strains it. Justified. |
| Relational graph (org-roam) | 9 link types in `note_links` | 8 link types in `links` | **`relates_to` dropped** — the recommendation doc's catch-all default type is not in the v2 schema. The v2 capture agent only assigns 4 types; the gardening pipeline adds 4 more. `relates_to` was the recommendation doc's default; v2 instead has no explicit default — unclassified relationships simply aren't linked. This is a deliberate choice: better no link than a vague one. Justified. |
| SKOS vocabulary | `concepts` + `note_concepts` | Present | **Faithful implementation.** |
| LATCH+IM facets | 7 facet columns on notes | `intent`, `modality`, `importance_score`, `maturity` present; `location_name` and `event_date` deferred | **Partial.** `location_name` deferred to Phase 3 (no geotag source in Telegram). `event_date` not in v2 schema at all — the recommendation doc's "what the note is about temporally" column is missing. This is a minor gap; it can be added as an `ALTER TABLE` when temporal extraction is implemented. |
| Associative trails (Memex) | `trails` + `trail_steps` tables | Deferred to Phase 3 | **Intentional deferral.** The schema is forward-compatible. |
| Note chunks (RAG) | `note_chunks` table | Present | **Faithful implementation.** |
| Enrichment audit | `enrichment_log` table | Present | **Not in the recommendation doc** — this is a v2 addition. Good operational practice. |
| Metadata-augmented embeddings | Described in pipeline section | Implemented in code, not schema | **Faithful implementation.** The schema does not need changes for this; it is a code-level concern. |

**Key omissions from the recommendation doc:**

1. **`event_date timestamptz`** — the "about" date column. Not critical for Phase 1.5, but straightforward to add later.
2. **`relates_to` link type** — intentionally dropped. See above.
3. **`note_types` table** — deferred to Phase 3 with clear criteria for when it becomes necessary.
4. **`location_name`** — deferred with rationale (no geotag source).
5. **`executive_summary`** — the recommendation doc proposed a second, shorter summary. Not in v2. Justified: the `body` field already serves as a short summary (2-5 sentences).
6. **`capture_context JSONB`** — the recommendation doc proposed storing device, app, and location at capture time. Not in v2. Could be added as a nullable JSONB column when multi-channel capture launches.

All omissions are justified by the guiding constraint: ship what the current pipeline can populate, defer what it cannot.

---

## 9. Regressions from Phase 1 Schema Review

The Phase 1 schema review (`04-schema.md`) flagged 11 issues. Here is their status in v2:

| # | Phase 1 issue | v2 status |
|---|---|---|
| 1 | `match_notes` crashes on null embeddings | **Fixed.** `WHERE n.embedding IS NOT NULL` present. |
| 2 | No `processed_updates` table | **Fixed.** Table present, unchanged from v1. |
| 3 | `unique(from_id, to_id, link_type)` semantics | **Preserved correctly.** |
| 4 | No `updated_at` trigger on `links` | **Preserved correctly.** Links remain immutable by design. |
| 5 | `ef_construction=64` too low | **Fixed.** Raised to 128. |
| 6 | No partial index for null embeddings | **Fixed.** `notes_null_embedding_idx` present. |
| 7 | No `archived_at` column | **Fixed.** Column present, filtered in `match_notes`. |
| 8 | `match_notes` does not filter archived notes | **Fixed.** `WHERE n.archived_at IS NULL` present. |
| 9 | No `pending_captures` table | **Still deferred.** Correct — not needed until clarification loop. |
| 10 | `assets.note_id` orphan risk with `ON DELETE SET NULL` | **Still deferred.** Assets table not yet created. The v2 plan does not mention assets. When the assets table is added, use `ON DELETE CASCADE` per the Phase 1 review recommendation. |
| 11 | Embedding dimension 1536 vs model | **Preserved correctly.** Still 1536 for `text-embedding-3-small`. |

**No regressions.** All Phase 1 fixes are preserved or correctly deferred.

One new gap relative to v1: the v1 `match_notes` returns `raw_input` in the v2 plan, which is good for the MCP server (agents can see the original text). But the v1 production function does not return `raw_input`. The v2 function adds it. This is a forward improvement, not a regression.

---

## Summary of Issues

| Severity | # | Issue | Section |
|---|---|---|---|
| Critical | 1a | `raw_input` in `content_tsv` includes uncorrected dictation | 1a, 4a |
| Critical | 1b | Functions in `extensions` schema not visible to PostgREST | 1b, 6a |
| Critical | 1c | `set search_path = ''` breaks `<=>` operator resolution | 1c, 6b |
| Important | 5c | `CREATE OR REPLACE` will not overwrite v1 `match_notes` (different signature) | 5c |
| Important | 3a | CHECK constraints are correct (confirming, not flagging) | 3a |
| Advisory | 1d | `GENERATED ALWAYS AS` with `coalesce` works on Supabase | 1d |
| Advisory | 1e | `float` = `double precision` in Postgres | 1e |
| Advisory | 2a | Dual HNSW indexes fine at small scale | 2a |
| Advisory | 2b | GIN on `entities` JSONB — consider `jsonb_path_ops` | 2b |
| Advisory | 2c | `links_type_idx` low cardinality | 2c |
| Advisory | 2d | Missing composite index on `enrichment_log` | 2d |
| Advisory | 3b | `corrections text[]` sufficient for now | 3b |
| Advisory | 3d | `concepts.broader_id` default `NO ACTION` is correct | 3d |
| Advisory | 6c | Hybrid search WHERE clause prevents HNSW index-only scan | 6c |
| Advisory | 6d | `match_chunks` lacks note-level metadata filters | 6d |
| Advisory | 7a | `alt_labels text[]` vs separate table — array is fine | 7a |
| Advisory | 7b | Concept embeddings not seeded — expected | 7b |

---

## Corrected SQL

The following corrected snippets address all Critical and Important issues. Only the changed portions are shown; the rest of the migration is unchanged.

### Fix 1: `content_tsv` — remove `raw_input`

```sql
  -- Full-text search (hybrid with vector)
  content_tsv     tsvector generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || body)
  ) stored
```

### Fix 2: Drop sequence — add function drops

Add these lines at the top of the drop sequence, before the table drops:

```sql
DROP FUNCTION IF EXISTS match_notes;
DROP FUNCTION IF EXISTS match_chunks;
DROP FUNCTION IF EXISTS update_updated_at CASCADE;
```

### Fix 3: `match_notes` — move to `public` schema, fix search_path

```sql
create or replace function match_notes(
  query_embedding  vector(1536),
  match_threshold  float   default 0.5,
  match_count      int     default 10,
  filter_type      text    default null,
  filter_source    text    default null,
  filter_tags      text[]  default null,
  filter_intent    text    default null,
  search_text      text    default null
)
returns table (
  id          uuid,
  title       text,
  body        text,
  raw_input   text,
  type        text,
  tags        text[],
  source_ref  text,
  source      text,
  intent      text,
  modality    text,
  entities    jsonb,
  created_at  timestamptz,
  similarity  float
)
language sql stable
set search_path = 'public, extensions'
as $$
  select
    n.id,
    n.title,
    n.body,
    n.raw_input,
    n.type,
    n.tags,
    n.source_ref,
    n.source,
    n.intent,
    n.modality,
    n.entities,
    n.created_at,
    1 - (n.embedding <=> query_embedding) as similarity
  from notes n
  where
    n.embedding is not null
    and n.archived_at is null
    and 1 - (n.embedding <=> query_embedding) > match_threshold
    and (filter_type   is null or n.type   = filter_type)
    and (filter_source is null or n.source = filter_source)
    and (filter_tags   is null or n.tags   @> filter_tags)
    and (filter_intent is null or n.intent = filter_intent)
    and (search_text   is null or n.content_tsv @@ plainto_tsquery('english', search_text))
  order by n.embedding <=> query_embedding
  limit match_count;
$$;
```

### Fix 4: `match_chunks` — move to `public` schema, fix search_path

```sql
create or replace function match_chunks(
  query_embedding  vector(1536),
  match_threshold  float   default 0.5,
  match_count      int     default 20
)
returns table (
  chunk_id    uuid,
  note_id     uuid,
  chunk_index integer,
  content     text,
  note_title  text,
  similarity  float
)
language sql stable
set search_path = 'public, extensions'
as $$
  select
    c.id as chunk_id,
    c.note_id,
    c.chunk_index,
    c.content,
    n.title as note_title,
    1 - (c.embedding <=> query_embedding) as similarity
  from note_chunks c
  join notes n on n.id = c.note_id
  where
    c.embedding is not null
    and n.archived_at is null
    and 1 - (c.embedding <=> query_embedding) > match_threshold
  order by c.embedding <=> query_embedding
  limit match_count;
$$;
```

Note: With `search_path = 'public, extensions'`, the `public.` prefix on table names in the function body is optional but harmless. Keeping it makes the intent explicit.

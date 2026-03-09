# Implementation Plan v2 — Schema Evolution + Enriched Capture

> **Context:** Phase 1 is complete and deployed. This plan extends the system based on findings from `planning-inputs/note_taking_recommendations.md`, which analyzed 13 knowledge organization systems and recommended a hybrid of Tana/Anytype's type system, org-roam's relational schema, SKOS's controlled vocabulary, and LATCH's metadata facets.
>
> **Guiding constraint:** The user sends raw text and nothing else. 100% of enrichment happens automatically. Zero additional friction at capture time.
>
> **Data policy:** The production database contains no irreplaceable data. A full drop-and-recreate is acceptable where it simplifies implementation.
>
> **Review status:** This plan incorporates all critical and important fixes from six specialist reviews (07–12). Each fix is annotated with its review source.

**Product intent (unchanged from v1):**
An always-on place to capture unedited thoughts via low-friction interfaces. Store fast, structure automatically, never ask the user to edit. The stored notes become a semantic context layer for downstream AI agents. Raw input is the irreplaceable source of truth. The capture pipeline is channel-agnostic.

Read this plan top to bottom before starting. Cross-reference the recommendation document at `planning-inputs/note_taking_recommendations.md` for rationale behind each design decision. Cross-reference `reviews/07-v2-schema.md` through `reviews/12-v2-testing.md` for the full review trail.

**Key architecture (unchanged):** Cloudflare Workers (V8/TypeScript/npm), NOT Supabase Edge Functions. Supabase is database only. The Worker returns 200 immediately and processes in `ctx.waitUntil()`. Embedding model: `openai/text-embedding-3-small` at 1536 dimensions.

---

## What changes from Phase 1

### Schema: drop and recreate

The `notes` table gains 9 new columns for gardening-time enrichment. The `links` table gets expanded link types, plus `context`, `confidence`, and `created_by` columns. Four new tables are added: `concepts` + `note_concepts` (SKOS vocabulary), `note_chunks` (RAG), `enrichment_log` (audit), and `capture_profiles` (user-configurable capture voice). The `match_notes` function is rewritten for hybrid search (vector + full-text). The `processed_updates` table is unchanged.

Because the existing data is expendable, we drop all tables and recreate from a single new migration file rather than stacking ALTER TABLE migrations.

### Code: every source file changes

| File | What changes |
|---|---|
| `src/types.ts` | New types: `Intent`, `Modality`, expanded `LinkType`, new `CaptureResult` fields (`intent`, `modality`, `entities`, `corrections`), new `Entity` interface |
| `src/config.ts` | No changes needed yet |
| `src/embed.ts` | New `buildEmbeddingInput()` utility for metadata-augmented embeddings |
| `src/capture.ts` | System prompt updated to output `intent`, `modality`, and `entities` with independence instruction. Parser updated with fallback logging. `parseCaptureResponse` exported for unit testing |
| `src/db.ts` | `insertNote` writes new columns. New function: `logEnrichments` (batched). `match_notes` RPC call updated for new return columns |
| `src/index.ts` | `processCapture` does two-pass embedding with fallback, batches enrichment logging, sends generic error messages |
| `src/telegram.ts` | No changes |
| `tests/smoke.test.ts` | Assertions for new fields with value validation, enrichment_log checks, increased wait time |
| `tests/parser.test.ts` | **New file.** Unit tests for `parseCaptureResponse` covering all 5 fallback behaviors |

### Capture agent: expanded output

The LLM now returns three additional fields. These add zero user friction — the LLM classifies from the text alone:

```json
{
  "title": "...",
  "body": "...",
  "type": "idea|reflection|source|lookup",
  "tags": ["...", "..."],
  "source_ref": null,
  "corrections": ["garbled → corrected"] | null,
  "intent": "reflect|plan|create|remember|reference|log",
  "modality": "text|link|list|mixed",
  "entities": [{"name": "...", "type": "person|place|tool|project|concept"}],
  "links": [
    { "to_id": "<uuid>", "link_type": "extends|contradicts|supports|is-example-of" }
  ]
}
```

> **Review fix [10-§2]:** `intent` reduced from 7 to 6 values. `wish` merged into `plan` — every wish is a future action at low commitment, and the boundary was too vague for consistent LLM classification. `remember` and `reference` kept separate with a tiebreaker rule (see Task 5).

### Embeddings: metadata-augmented

Before embedding, prepend structured metadata to the text. This bakes organizational context into the vector space so topically different notes occupy distinct regions.

Format: `[Type: idea] [Intent: reflect] [Tags: spirituality, gratitude] actual text`

This is a one-line change in the embedding call site, not in `embedText` itself — the caller constructs the augmented string and passes it in.

**Why the augmentation happens after the LLM call, not before:** The first embedding (used to find related notes) must use raw text — we don't have metadata yet. After the LLM returns structured output, we re-embed with metadata augmentation. This costs one extra embedding call (~$0.000005 per note) but produces a significantly better stored vector.

**v1 flow:** embed raw text → find related → LLM → store (with the raw-text embedding)
**v2 flow:** embed raw text → find related → LLM → re-embed with metadata → store (with the augmented embedding)

> **Review fix [12-§5d]:** If the second embedding call fails, fall back to the raw embedding rather than losing the note entirely. The LLM call has already succeeded and burned tokens — discarding the result is worse than storing a slightly less optimal embedding.

---

## Deploy order — critical dependency

> **Review fix [09-§7, 12-§8a]:** The v2 Worker calls `match_notes` with new parameters (`filter_intent`, `search_text`) that do not exist in the v1 function. Deploying the Worker before the migration is a guaranteed runtime failure on every capture. The sequence is:
>
> 1. Run DROP statements in Supabase SQL Editor
> 2. `supabase db push` (applies new migration)
> 3. Verify tables and functions in Supabase dashboard
> 4. Seed concepts
> 5. `wrangler deploy` (deploys new Worker)
> 6. Run smoke tests
>
> If `db push` fails after the DROPs, the database is empty but recoverable — fix the SQL and re-push. If the Worker deploy fails, the old Worker is still running against an empty database — redeploy after fixing.

---

## Task 1 — New Migration: Drop and Recreate

**File to create:** `supabase/migrations/20260309000000_v2_schema.sql`

**Pre-step:** Delete the old migration file. Supabase tracks applied migrations by filename in `supabase_migrations.schema_migrations`. To force a clean slate, run in the Supabase SQL Editor:

```sql
-- Drop functions FIRST (v2 has different signatures — CREATE OR REPLACE won't overwrite) [Review fix 07-§5c]
DROP FUNCTION IF EXISTS match_notes;
DROP FUNCTION IF EXISTS match_chunks;
DROP FUNCTION IF EXISTS update_updated_at CASCADE;

-- Drop tables (IF EXISTS handles tables that don't exist yet)
DROP TABLE IF EXISTS trail_steps CASCADE;
DROP TABLE IF EXISTS trails CASCADE;
DROP TABLE IF EXISTS capture_profiles CASCADE;
DROP TABLE IF EXISTS enrichment_log CASCADE;
DROP TABLE IF EXISTS note_chunks CASCADE;
DROP TABLE IF EXISTS note_concepts CASCADE;
DROP TABLE IF EXISTS concepts CASCADE;
DROP TABLE IF EXISTS links CASCADE;
DROP TABLE IF EXISTS notes CASCADE;
DROP TABLE IF EXISTS note_types CASCADE;
DROP TABLE IF EXISTS processed_updates CASCADE;

-- Clear migration tracking so db push treats the new file as unapplied
DELETE FROM supabase_migrations.schema_migrations;
```

Then remove the old migration file from the repo:

```bash
rm supabase/migrations/20260101000000_initial_schema.sql
```

Create the new migration:

```sql
-- ============================================================
-- SEARCH PATH — ensure vector type resolves correctly [Review fix 09-§9b]
-- ============================================================
SET search_path = public, extensions;

-- ============================================================
-- EXTENSIONS
-- ============================================================
create extension if not exists vector schema extensions;

-- ============================================================
-- NOTES
-- ============================================================
create table notes (
  id              uuid        primary key default gen_random_uuid(),

  -- CAPTURE-TIME (required: only raw_input + timestamp)
  raw_input       text        not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  -- CAPTURE-TIME (from LLM, single-pass)
  title           text        not null,
  body            text        not null,
  type            text        not null check (type in ('idea', 'reflection', 'source', 'lookup')),
  tags            text[]      not null default '{}',
  source_ref      text,
  source          text        not null default 'telegram',
  corrections     text[],

  -- CAPTURE-TIME (LLM-classified, zero user friction)
  intent          text        check (intent in ('reflect', 'plan', 'create', 'remember', 'reference', 'log')),
  modality        text        check (modality in ('text', 'link', 'list', 'mixed')),
  entities        jsonb       default '[]',

  -- GARDENING-TIME (auto-populated by enrichment pipeline)
  summary         text,
  refined_tags    text[]      default '{}',
  categories      text[]      default '{}',
  metadata        jsonb       default '{}',
  importance_score float,
  maturity        text        default 'seedling' check (maturity in ('seedling', 'budding', 'evergreen')),

  -- Soft delete
  archived_at     timestamptz,

  -- Embeddings
  embedding       vector(1536),
  embedded_at     timestamptz,

  -- Full-text search (hybrid with vector)
  -- NOTE: raw_input intentionally excluded — it contains uncorrected dictation
  -- artifacts that the capture agent already cleaned up. [Review fix 07-§1a]
  content_tsv     tsvector generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || body)
  ) stored
);

-- Semantic search (cosine distance, partial: excludes unembedded rows)
create index notes_embedding_idx on notes
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 128)
  where embedding is not null;

-- Full-text search
create index notes_content_tsv_idx on notes using gin (content_tsv);

-- Tag filtering
create index notes_tags_idx on notes using gin (tags);

-- Recency ordering
create index notes_created_idx on notes (created_at desc);

-- Active notes only
create index notes_active_idx on notes (created_at desc)
  where archived_at is null;

-- Orphaned embeddings (for retry jobs)
create index notes_null_embedding_idx on notes (id)
  where embedding is null and archived_at is null;

-- Intent filtering (for MCP queries like "show me all my plans")
create index notes_intent_idx on notes (intent)
  where intent is not null;

-- Entities — jsonb_path_ops for smaller index and faster @> queries [Review fix 11-§6]
create index notes_entities_idx on notes using gin (entities jsonb_path_ops);

-- ============================================================
-- LINKS
-- Expanded from 4 types to 8. Added context, confidence, created_by
-- for gardening-time auto-generated links.
-- ============================================================
create table links (
  id          uuid        primary key default gen_random_uuid(),
  from_id     uuid        not null references notes(id) on delete cascade,
  to_id       uuid        not null references notes(id) on delete cascade,
  link_type   text        not null check (link_type in (
    -- Capture-time (LLM-assigned)
    'extends', 'contradicts', 'supports', 'is-example-of',
    -- Gardening-time (auto-generated)
    'is-similar-to', 'is-part-of', 'follows', 'is-derived-from'
  )),
  context     text,                           -- surrounding text or reason for the link
  confidence  float       default 1.0,        -- 1.0 for human/LLM links, <1.0 for auto-similarity
  created_by  text        default 'capture' check (created_by in ('capture', 'gardener', 'user')),
  created_at  timestamptz not null default now(),
  unique(from_id, to_id, link_type)
);

create index links_to_id_idx on links (to_id);
create index links_from_id_idx on links (from_id);

-- ============================================================
-- SKOS-INSPIRED CONTROLLED VOCABULARY
-- Solves tag drift: "bike" vs "bicycle" vs "cycling"
-- ============================================================
create table concepts (
  id          uuid        primary key default gen_random_uuid(),
  scheme      text        not null,           -- 'domains', 'intents', 'modalities', etc.
  pref_label  text        not null,           -- canonical name
  alt_labels  text[]      default '{}',       -- synonyms
  broader_id  uuid        references concepts(id),
  definition  text,
  embedding   vector(1536),
  unique(scheme, pref_label)
);

create table note_concepts (
  note_id     uuid        references notes(id) on delete cascade,
  concept_id  uuid        references concepts(id) on delete cascade,
  primary key (note_id, concept_id)
);

-- ============================================================
-- NOTE CHUNKS (for RAG — long notes split for precise retrieval)
-- ============================================================
create table note_chunks (
  id          uuid        primary key default gen_random_uuid(),
  note_id     uuid        not null references notes(id) on delete cascade,
  chunk_index integer     not null,
  content     text        not null,
  embedding   vector(1536),
  unique(note_id, chunk_index)
);

create index note_chunks_embedding_idx on note_chunks
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 128)
  where embedding is not null;

-- ============================================================
-- ENRICHMENT AUDIT LOG
-- Tracks what enrichment ran on which note, for retry and debugging.
-- ============================================================
create table enrichment_log (
  id              uuid        primary key default gen_random_uuid(),
  note_id         uuid        not null references notes(id) on delete cascade,
  enrichment_type text        not null,
  model_used      text,
  completed_at    timestamptz default now()
);

-- Composite index for idempotency checks ("has this enrichment run?") [Review fix 07-§2d]
create index enrichment_log_note_type_idx on enrichment_log (note_id, enrichment_type);

-- ============================================================
-- CAPTURE PROFILES
-- The capture voice (stylistic prompt rules for title/body) lives here,
-- not in code. Any capture interface (Telegram, MCP, Slack, CLI) fetches
-- the same profile, ensuring uniform note style regardless of entry point.
-- ============================================================
create table capture_profiles (
  id            uuid        primary key default gen_random_uuid(),
  name          text        not null unique,
  capture_voice text        not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create trigger capture_profiles_updated_at
  before update on capture_profiles
  for each row execute function update_updated_at();

-- Seed the default capture voice
insert into capture_profiles (name, capture_voice) values ('default', '## Your capture style

**Title**: A claim or insight when one is present. If the input doesn''t contain a claim, use a descriptive phrase that captures what the note is about — still specific, not a generic topic label.
- Good: "Constraints make creative work stronger" (claim)
- Good: "Painting pebbles with Aztec-inspired patterns" (descriptive, no claim in input)
- Bad: "Creativity" or "Note about constraints" (vague topic labels)

**Body**: 1–5 sentences. Atomic — one idea, standing alone.

**Traceability rule (bright line):** Every sentence in the body must be traceable to something the user actually said. You may clean up grammar, remove filler, and lightly restructure — but you must not add information, conclusions, elaborations, or descriptions that the user did not express. If the input is short, the body is short. One sentence is fine.

Wrong:
- Input: "i like to paint pebbles in various colors maybe use aztec patterns for inspiration"
- Body: "Likes painting pebbles in various colors. The geometric and symbolic motifs from Aztec design could translate well onto the curved surfaces of stones."
- Why wrong: the user never described the patterns as "geometric and symbolic motifs" or mentioned "curved surfaces" — the second sentence is fabricated.

Right:
- Input: "i like to paint pebbles in various colors maybe use aztec patterns for inspiration"
- Body: "Likes painting pebbles in various colors. Aztec patterns could be good inspiration."

Use the user''s own words and phrasing wherever possible — rewrite only enough to fix grammar and remove filler. Do not paraphrase their metaphors into neutral descriptions. Do not add a concluding sentence that synthesizes or names what their words already showed. Do not add benefits, follow-ons, or observations the user did not make. Shorter is better than padded.');

-- ============================================================
-- TELEGRAM DEDUPLICATION (unchanged from v1)
-- ============================================================
create table processed_updates (
  update_id    bigint      primary key,
  processed_at timestamptz not null default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table notes             enable row level security;
alter table links             enable row level security;
alter table concepts          enable row level security;
alter table note_concepts     enable row level security;
alter table note_chunks       enable row level security;
alter table enrichment_log    enable row level security;
alter table capture_profiles  enable row level security;
alter table processed_updates enable row level security;

create policy "deny all" on notes             for all using (false);
create policy "deny all" on links             for all using (false);
create policy "deny all" on concepts          for all using (false);
create policy "deny all" on note_concepts     for all using (false);
create policy "deny all" on note_chunks       for all using (false);
create policy "deny all" on enrichment_log    for all using (false);
create policy "deny all" on capture_profiles  for all using (false);
create policy "deny all" on processed_updates for all using (false);

-- ============================================================
-- UPDATED_AT TRIGGER
-- search_path pinned for consistency with RPC functions [Review fix 08-§6.4]
-- ============================================================
create or replace function update_updated_at()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger notes_updated_at
  before update on notes
  for each row execute function update_updated_at();

-- ============================================================
-- SEMANTIC SEARCH FUNCTION (v2 — hybrid vector + full-text)
--
-- Created in PUBLIC schema so Supabase PostgREST can find it via .rpc()
-- [Review fix 07-§1b, 09-§3b]
--
-- search_path includes 'extensions' so the <=> operator resolves
-- [Review fix 07-§1c]
-- ============================================================
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

-- ============================================================
-- CHUNK SEARCH FUNCTION (for RAG retrieval in Phase 2)
-- ============================================================
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

**Deploy:**

```bash
supabase db push
```

**Verify:** Supabase dashboard → Table Editor shows all 8 tables (including `capture_profiles` with one seeded row). Database → Functions shows `match_notes`, `match_chunks`, and `update_updated_at`. Confirm `match_notes` is in the `public` schema, not `extensions`.

---

## Task 2 — Seed SKOS Concepts

The concepts table needs initial vocabulary. This runs once after the migration.

**File to create:** `supabase/seed/seed_concepts.sql`

Execute manually in the Supabase SQL Editor (not via migrations — seed data is separate from schema).

```sql
insert into concepts (scheme, pref_label, alt_labels, definition) values
  ('domains', 'creativity', '{"creative process", "making"}', 'Creative thinking, artistic practice, and the act of making'),
  ('domains', 'technology', '{"tech", "software", "programming", "code"}', 'Software, hardware, tools, and digital systems'),
  ('domains', 'spirituality', '{"inner life", "mindfulness", "contemplation"}', 'Inner life, contemplative practice, meaning-making'),
  ('domains', 'design', '{"visual design", "UX", "UI"}', 'Visual, interaction, and systems design'),
  ('domains', 'bookbinding', '{"book arts", "binding"}', 'Book arts, binding techniques, paper craft'),
  ('domains', 'music', '{"audio", "sound", "instruments"}', 'Music creation, instruments, audio production'),
  ('domains', 'cooking', '{"food", "recipes", "kitchen"}', 'Food preparation, recipes, kitchen projects'),
  ('domains', 'reading', '{"books", "literature"}', 'Books, articles, reading notes'),
  ('domains', 'productivity', '{"workflow", "tools", "systems"}', 'Personal systems, workflows, and tools'),
  ('domains', 'relationships', '{"people", "family", "friends"}', 'People, social connections, gifts');
```

This seed data is intentionally small. It grows organically as the gardening pipeline encounters unmatched tags. The `embedding` column on concepts is populated later by the gardening pipeline.

---

## Task 3 — Update `src/types.ts`

Changes:
- Add `Intent` (6 values — `wish` merged into `plan`) and `Modality` union types
- Separate `CaptureLinkType` from full `LinkType`
- Add `Entity` interface
- Add `corrections`, `intent`, `modality`, `entities` to `CaptureResult`
- Update `MatchedNote` with new return columns

```typescript
// ── Cloudflare Worker Env ───────────────────────────────────────────────────

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OPENROUTER_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ALLOWED_CHAT_IDS: string;
  CAPTURE_MODEL: string;
  EMBED_MODEL: string;
  MATCH_THRESHOLD: string;
}

// ── Telegram Types ──────────────────────────────────────────────────────────

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  sticker?: unknown;
  photo?: unknown[];
  audio?: unknown;
  voice?: unknown;
  document?: unknown;
  forward_origin?: unknown;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: unknown;
  callback_query?: unknown;
}

// ── Note Types ──────────────────────────────────────────────────────────────

export type NoteType = 'idea' | 'reflection' | 'source' | 'lookup';

// Capture-time link types (LLM-assigned)
export type CaptureLinkType = 'extends' | 'contradicts' | 'supports' | 'is-example-of';

// All link types (capture + gardening)
export type LinkType = CaptureLinkType
  | 'is-similar-to' | 'is-part-of' | 'follows' | 'is-derived-from';

// 6 values — 'wish' merged into 'plan' [Review fix 10-§2]
export type Intent = 'reflect' | 'plan' | 'create' | 'remember' | 'reference' | 'log';

export type Modality = 'text' | 'link' | 'list' | 'mixed';

export interface Entity {
  name: string;
  type: 'person' | 'place' | 'tool' | 'project' | 'concept';
}

export interface CaptureLink {
  to_id: string;
  link_type: CaptureLinkType;
}

export interface CaptureResult {
  title: string;
  body: string;
  type: NoteType;
  tags: string[];
  source_ref: string | null;
  links: CaptureLink[];
  corrections: string[] | null;
  intent: Intent;
  modality: Modality;
  entities: Entity[];
}

export interface MatchedNote {
  id: string;
  title: string;
  body: string;
  raw_input: string;
  type: string;
  tags: string[];
  source_ref: string | null;
  source: string;
  intent: string | null;
  modality: string | null;
  entities: unknown;
  created_at: string;
  similarity: number;
}
```

---

## Task 4 — Update `src/embed.ts`

The `embedText` function stays unchanged. Add a utility to construct the metadata-augmented string:

```typescript
import OpenAI from 'openai';
import type { Config } from './config';
import type { CaptureResult } from './types';

export function createOpenAIClient(config: Config): OpenAI {
  return new OpenAI({
    apiKey: config.openrouterApiKey,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/freegyes/project-ContemPlace',
      'X-Title': 'ContemPlace',
    },
  });
}

export async function embedText(
  client: OpenAI,
  config: Config,
  text: string,
): Promise<number[]> {
  const response = await client.embeddings.create({
    model: config.embedModel,
    input: text,
  });
  const embedding = response.data[0]?.embedding;
  if (!embedding) {
    throw new Error('Embedding API returned no data');
  }
  return embedding;
}

/**
 * Build a metadata-augmented string for embedding.
 * Prepending structured metadata bakes organizational context into the vector space.
 */
export function buildEmbeddingInput(text: string, capture: CaptureResult): string {
  const parts: string[] = [];
  parts.push(`[Type: ${capture.type}]`);
  if (capture.intent) parts.push(`[Intent: ${capture.intent}]`);
  if (capture.tags.length > 0) parts.push(`[Tags: ${capture.tags.join(', ')}]`);
  parts.push(text);
  return parts.join(' ');
}
```

> **Review fix [12-§8d]:** `capture` parameter is required, not optional. The caller uses `embedText` directly for the raw embedding (first pass) and `buildEmbeddingInput` + `embedText` for the augmented embedding (second pass). No ambiguity about which path is which.

---

## Task 5 — Update `src/capture.ts`

The system prompt expands to request `intent`, `modality`, and `entities`. Critical review fixes incorporated:

- **[10-§4]** Explicit instruction that `type` and `intent` are independent facets
- **[10-§2]** `intent` reduced to 6 values; tiebreaker rules for `remember` vs `reference`
- **[10-§2]** Entity extraction requires proper nouns only, not from related notes or training data
- **[10-§6]** Corrected voice names flow into entities
- **[10-§5]** `max_tokens` bumped to 1536
- **[10-§3, 12-§5c]** Parser logs when fallback defaults are applied
- **[08-§1.2]** Entity names truncated at 200 chars
- **[12-§4a]** `parseCaptureResponse` exported for unit testing
- **[voice-fidelity]** Body sentence floor dropped from 2 to 1; bright-line traceability rule added (every sentence must trace to user's actual words); concrete wrong/right example embedded in prompt
- **[voice-fidelity]** Title rule relaxed: descriptive titles allowed when input contains no claim
- **[capture-profiles]** System prompt split into `SYSTEM_FRAME` (code — structural contract) and capture voice (DB — stylistic rules). Any capture interface fetches the same profile, ensuring uniform behavior regardless of entry point.

```typescript
import OpenAI from 'openai';
import type { Config } from './config';
import type { CaptureResult, CaptureLink, MatchedNote, NoteType, CaptureLinkType, Intent, Modality, Entity } from './types';

// ── System frame: structural contract between LLM and parser ──────────────────
// This part stays in code. It defines the JSON schema, field enums,
// entity/link rules — everything the parser depends on. Users don't touch it.
const SYSTEM_FRAME = `You are a knowledge capture agent. Transform raw input into a single structured note and identify relationships to existing notes.

## Voice recognition correction

Input often comes from voice dictation. Before anything else:
1. Scan for out-of-place words — phonetically plausible but wrong in context.
2. Cross-reference related notes for proper nouns, tool names, project names.
3. Silently correct in the output. Report in the \`corrections\` field (e.g., \`["cattle stitch → kettle stitch"]\`). Use null if nothing was corrected.

## Classification rules

**Type**: one of \`idea | reflection | source | lookup\`
- \`reflection\` — first-person, personal insight. Only when the user's words **explicitly** signal personal resonance ("this resonates with me", "I've always felt this"). Never infer from topic alone. When in doubt, use \`idea\`.
- \`lookup\` — primarily a research or investigation prompt ("look into X", "check out Y"). Not for things to make or build.
- \`source\` — from an external source with a URL.
- \`idea\` — everything else. Default. Neutral voice.

**Tags**: 2–5 lowercase strings, no \`#\` prefix.

**source_ref**: URL if the user included one, otherwise null.

**Intent**: what the user is doing with this note. One of:
- \`reflect\` — processing an experience or feeling
- \`plan\` — thinking about future action, aspirations, or wishes ("I should", "next step", "want to", "would be nice", "someday")
- \`create\` — capturing something to make or build (the thing to build is specific, not hypothetical)
- \`remember\` — storing a fact, name, detail, or personal observation for later recall
- \`reference\` — saving external content: articles, links, quotes, or bookmarks. Use when a URL is present or the user is explicitly saving someone else's work.
- \`log\` — recording what happened (events, completions, milestones)
If the input could be \`remember\` or \`reference\`, use \`remember\` when no URL is present, \`reference\` when a URL is present.

**Type and intent are independent.** Type describes the *form* of the note (is it an idea, a reflection, a source reference, or a research prompt?). Intent describes *what the user is doing* (planning, reflecting, creating, remembering, etc.). A \`source\` type note can have \`plan\` intent (saving a link to act on later). A \`reflection\` type note can have \`remember\` intent (recording a personal realization for future reference). Do not assume they must match.

**Modality**: what form the content takes. One of:
- \`text\` — prose, sentences, paragraphs with no enumeration
- \`link\` — primarily a URL with optional commentary
- \`list\` — bullet points, numbered items, comma-separated items, or a sentence that enumerates items ("I need eggs, milk, and bread")
- \`mixed\` — combination of the above

**Entities**: extract named entities **explicitly mentioned in the input text** — not from related notes, not from your training data, not inferred from context. Only extract proper nouns (capitalized in standard writing) or specific named things. Generic abstract nouns like "creativity", "constraints", "productivity" are NOT entities even if they match a type below. If a name is ambiguous or only implied, do not extract it. If you corrected a name in the \`corrections\` field, use the corrected version in entities. Entity extraction is separate from the body rule — extract entities based on meaning, even though the body preserves the user's exact words.
Each entity has a name and type:
- \`person\` — people (real names, nicknames, public figures)
- \`place\` — locations, cities, venues
- \`tool\` — software, apps, instruments, physical tools
- \`project\` — named projects, initiatives, creative works
- \`concept\` — named frameworks, methodologies, movements (e.g., "Zettelkasten", "GTD", "Wabi-sabi")
Return an empty array if no clear named entities appear in the input.

**Links**: for each related note provided, decide if a typed relationship applies.
Types: \`extends | contradicts | supports | is-example-of\`
- \`extends\` — builds on, deepens, or expands the other note's idea
- \`contradicts\` — challenges or is in tension with it
- \`supports\` — provides evidence, reinforces, or is a parallel/sibling idea toward the same goal
- \`is-example-of\` — a concrete instance of the other note's concept
Prefer more links over fewer. It is fine to link to zero notes.

If the input is too short to form a full note, do your best. Do not ask for clarification.

Return valid JSON only. No text outside the JSON object.
{
  "title": "...",
  "body": "...",
  "type": "idea|reflection|source|lookup",
  "tags": ["...", "..."],
  "source_ref": null,
  "corrections": ["garbled → corrected"] | null,
  "intent": "reflect|plan|create|remember|reference|log",
  "modality": "text|link|list|mixed",
  "entities": [{"name": "...", "type": "person|place|tool|project|concept"}],
  "links": [
    { "to_id": "<uuid>", "link_type": "extends|contradicts|supports|is-example-of" }
  ]
}`;

// ── Assemble full prompt ─────────────────────────────────────────────────────
// The capture voice (title/body style rules) is fetched from the DB at runtime.
// This keeps the stylistic part user-configurable while the structural contract
// stays in code. Any capture interface — Telegram, MCP, CLI — calls the same
// function and gets the same prompt.
function buildSystemPrompt(captureVoice: string): string {
  return SYSTEM_FRAME + '\n\n' + captureVoice;
}

const VALID_NOTE_TYPES: readonly NoteType[] = ['idea', 'reflection', 'source', 'lookup'];
const VALID_LINK_TYPES: readonly CaptureLinkType[] = ['extends', 'contradicts', 'supports', 'is-example-of'];
const VALID_INTENTS: readonly Intent[] = ['reflect', 'plan', 'create', 'remember', 'reference', 'log'];
const VALID_MODALITIES: readonly Modality[] = ['text', 'link', 'list', 'mixed'];
const VALID_ENTITY_TYPES = ['person', 'place', 'tool', 'project', 'concept'] as const;

export async function runCaptureAgent(
  client: OpenAI,
  config: Config,
  text: string,
  relatedNotes: MatchedNote[],
  captureVoice: string,
): Promise<CaptureResult> {
  const today = new Date().toISOString().split('T')[0];
  const systemPrompt = buildSystemPrompt(captureVoice);

  // Include type/intent metadata in related notes for better linking decisions [Review fix 10-§7]
  const relatedSection = relatedNotes.length > 0
    ? '\n\nRelated notes for context:\n' +
      relatedNotes.map(n => {
        const meta = [n.type, n.intent].filter(Boolean).join(' · ');
        const metaSuffix = meta ? ` (${meta})` : '';
        return `[${n.id}] "${n.title}"${metaSuffix}\n${n.body}`;
      }).join('\n\n')
    : '';

  const userMessage = `Today's date: ${today}\n\nCapture this:\n${text}${relatedSection}`;

  const completion = await client.chat.completions.create({
    model: config.captureModel,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    temperature: 0.3,
    max_tokens: 1536, // bumped from 1024 for 10-field output headroom [Review fix 10-§5]
  });

  const rawContent = completion.choices[0]?.message?.content;
  if (!rawContent) {
    throw new Error('LLM returned empty content');
  }

  return parseCaptureResponse(rawContent);
}

// Exported for unit testing [Review fix 12-§4a]
export function parseCaptureResponse(raw: string): CaptureResult {
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/, '')
    .trim();

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`LLM returned invalid JSON: ${cleaned.slice(0, 200)}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`LLM response is not an object: ${cleaned.slice(0, 200)}`);
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj['title'] !== 'string') throw new Error('LLM response missing title');
  if (typeof obj['body'] !== 'string') throw new Error('LLM response missing body');
  if (typeof obj['type'] !== 'string') throw new Error('LLM response missing type');
  if (!Array.isArray(obj['tags'])) throw new Error('LLM response missing tags array');

  const noteType: NoteType = VALID_NOTE_TYPES.includes(obj['type'] as NoteType)
    ? (obj['type'] as NoteType)
    : (() => {
        console.warn(JSON.stringify({ event: 'field_defaulted', field: 'type', raw_value: obj['type'], default: 'idea' }));
        return 'idea' as NoteType;
      })();

  // Log when fallback defaults are applied [Review fix 10-§3]
  const intent: Intent = VALID_INTENTS.includes(obj['intent'] as Intent)
    ? (obj['intent'] as Intent)
    : (() => {
        console.warn(JSON.stringify({ event: 'field_defaulted', field: 'intent', raw_value: obj['intent'], default: 'remember' }));
        return 'remember' as Intent;
      })();

  const modality: Modality = VALID_MODALITIES.includes(obj['modality'] as Modality)
    ? (obj['modality'] as Modality)
    : (() => {
        console.warn(JSON.stringify({ event: 'field_defaulted', field: 'modality', raw_value: obj['modality'], default: 'text' }));
        return 'text' as Modality;
      })();

  // Truncate entity names at 200 chars, filter invalid types [Review fix 08-§1.2]
  const entities: Entity[] = Array.isArray(obj['entities'])
    ? (obj['entities'] as unknown[]).filter((e): e is Entity => {
        if (typeof e !== 'object' || e === null) return false;
        const ent = e as Record<string, unknown>;
        return (
          typeof ent['name'] === 'string' &&
          ent['name'].length <= 200 &&
          typeof ent['type'] === 'string' &&
          (VALID_ENTITY_TYPES as readonly string[]).includes(ent['type'] as string)
        );
      })
    : [];

  // Log dropped entities for prompt tuning [Review fix 12-§5b]
  if (Array.isArray(obj['entities'])) {
    const totalCount = (obj['entities'] as unknown[]).length;
    if (totalCount > entities.length) {
      console.warn(JSON.stringify({
        event: 'entities_filtered',
        kept: entities.length,
        dropped: totalCount - entities.length,
      }));
    }
  }

  const links: CaptureLink[] = Array.isArray(obj['links'])
    ? (obj['links'] as unknown[]).filter((l): l is CaptureLink => {
        if (typeof l !== 'object' || l === null) return false;
        const link = l as Record<string, unknown>;
        return (
          typeof link['to_id'] === 'string' &&
          VALID_LINK_TYPES.includes(link['link_type'] as CaptureLinkType)
        );
      })
    : [];

  const corrections: string[] | null = Array.isArray(obj['corrections'])
    ? (obj['corrections'] as unknown[]).filter((v): v is string => typeof v === 'string')
    : null;

  return {
    title: obj['title'] as string,
    body: obj['body'] as string,
    type: noteType,
    tags: (obj['tags'] as unknown[]).filter((t): t is string => typeof t === 'string'),
    source_ref: typeof obj['source_ref'] === 'string' ? obj['source_ref'] : null,
    links,
    corrections: corrections?.length ? corrections : null,
    intent,
    modality,
    entities,
  };
}
```

---

## Task 6 — Update `src/db.ts`

New columns in `insertNote`. Batched enrichment logging. Updated `MatchedNote` return shape. New `getCaptureVoice` function fetches the user's stylistic prompt rules from the `capture_profiles` table.

```typescript
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './config';
import type { CaptureLink, CaptureResult, MatchedNote } from './types';

export type SupabaseClientType = SupabaseClient;

export function createSupabaseClient(config: Config): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
}

// ── Capture voice ────────────────────────────────────────────────────────────
// Fetches the stylistic prompt section from capture_profiles.
// Any capture interface (Telegram, MCP, CLI) calls this to get the same
// title/body rules, ensuring uniform note style regardless of entry point.
const DEFAULT_CAPTURE_VOICE = `## Your capture style

**Title**: A claim or insight when one is present. If the input doesn't contain a claim, use a descriptive phrase.

**Body**: 1–5 sentences. Use the user's own words. Every sentence must be traceable to the input. Shorter is better than padded.`;

export async function getCaptureVoice(
  db: SupabaseClient,
  profileName = 'default',
): Promise<string> {
  const { data, error } = await db
    .from('capture_profiles')
    .select('capture_voice')
    .eq('name', profileName)
    .single();

  if (error || !data) {
    console.warn(JSON.stringify({
      event: 'capture_voice_fallback',
      error: error?.message ?? 'no profile found',
      profileName,
    }));
    return DEFAULT_CAPTURE_VOICE;
  }

  return (data as { capture_voice: string }).capture_voice;
}

export async function tryClaimUpdate(
  db: SupabaseClient,
  updateId: number,
): Promise<boolean> {
  const { error } = await db
    .from('processed_updates')
    .insert({ update_id: updateId });

  if (!error) return true;

  if (error.code === '23505') {
    return false;
  }

  console.error(JSON.stringify({
    event: 'dedup_insert_error',
    error: error.message,
    code: error.code,
    update_id: updateId,
  }));
  return true;
}

export async function findRelatedNotes(
  db: SupabaseClient,
  embedding: number[],
  threshold: number,
): Promise<MatchedNote[]> {
  const { data, error } = await db.rpc('match_notes', {
    query_embedding: embedding,
    match_threshold: threshold,
    match_count: 5,
    filter_type: null,
    filter_source: null,
    filter_tags: null,
    filter_intent: null,
    search_text: null,
  });

  if (error) {
    console.error(JSON.stringify({
      event: 'match_notes_error',
      error: error.message,
    }));
    return [];
  }

  return (data as MatchedNote[]) ?? [];
}

export async function insertNote(
  db: SupabaseClient,
  capture: CaptureResult,
  embedding: number[],
  rawInput: string,
): Promise<string> {
  const { data, error } = await db
    .from('notes')
    .insert({
      title: capture.title,
      body: capture.body,
      raw_input: rawInput,
      type: capture.type,
      tags: capture.tags,
      source_ref: capture.source_ref,
      source: 'telegram',
      corrections: capture.corrections,
      intent: capture.intent,
      modality: capture.modality,
      entities: capture.entities,
      embedding,
      embedded_at: new Date().toISOString(),
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`Note insert failed: ${error?.message ?? 'no data returned'}`);
  }

  return (data as { id: string }).id;
}

export async function insertLinks(
  db: SupabaseClient,
  noteId: string,
  links: CaptureLink[],
): Promise<void> {
  if (links.length === 0) return;

  const rows = links.map(l => ({
    from_id: noteId,
    to_id: l.to_id,
    link_type: l.link_type,
    created_by: 'capture',
  }));

  const { error } = await db.from('links').insert(rows);
  if (error) {
    console.error(JSON.stringify({
      event: 'links_insert_error',
      error: error.message,
      noteId,
      links: rows,
    }));
  }
}

// Batched insert — one round-trip instead of two [Review fix 11-§8]
export async function logEnrichments(
  db: SupabaseClient,
  noteId: string,
  entries: Array<{ enrichment_type: string; model_used: string | null }>,
): Promise<void> {
  const rows = entries.map(e => ({
    note_id: noteId,
    enrichment_type: e.enrichment_type,
    model_used: e.model_used,
  }));

  const { error } = await db.from('enrichment_log').insert(rows);
  if (error) {
    console.error(JSON.stringify({
      event: 'enrichment_log_error',
      error: error.message,
      noteId,
    }));
  }
}
```

---

## Task 7 — Update `src/index.ts`

Key review fixes incorporated:
- **[12-§5d]** Augmented embed failure falls back to raw embedding
- **[08-§6.1]** Error messages send generic text to user, log details to console
- **[08-§3.1]** Tags escaped in Telegram HTML
- **[11-§1]** Enrichment log batched and parallelized with Telegram reply
- **[08-§1.2]** Telegram message capped at 4096 chars
- **[capture-profiles]** Capture voice fetched from DB in parallel with embedding; passed to `runCaptureAgent`

```typescript
import type { Env, TelegramUpdate } from './types';
import { loadConfig, type Config } from './config';
import { sendTelegramMessage, sendTypingAction } from './telegram';
import { createOpenAIClient, embedText, buildEmbeddingInput } from './embed';
import { createSupabaseClient, tryClaimUpdate, findRelatedNotes, insertNote, insertLinks, logEnrichments, getCaptureVoice, type SupabaseClientType } from './db';
import { runCaptureAgent } from './capture';

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const config = loadConfig(env);

    // ── 1. Verify webhook secret ─────────────────────────────────────────────
    const incomingSecret = request.headers.get('x-telegram-bot-api-secret-token');
    if (!incomingSecret || incomingSecret !== config.telegramWebhookSecret) {
      return new Response('Forbidden', { status: 403 });
    }

    // ── 2. Parse body ────────────────────────────────────────────────────────
    let update: TelegramUpdate;
    try {
      const raw: unknown = await request.json();
      update = raw as TelegramUpdate;
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    // ── 3. Guard non-message updates ─────────────────────────────────────────
    if (!update.message) {
      return new Response('ok', { status: 200 });
    }

    const message = update.message;
    const chatId = message.chat.id;

    // ── 4. Chat ID whitelist ─────────────────────────────────────────────────
    if (config.allowedChatIds.length > 0 && !config.allowedChatIds.includes(chatId)) {
      console.warn(JSON.stringify({ event: 'unauthorized_chat', chatId }));
      return new Response('ok', { status: 200 });
    }

    // ── 5. Guard non-text messages ───────────────────────────────────────────
    const text = message.text ?? message.caption;
    if (!text) {
      ctx.waitUntil(
        sendTelegramMessage(config, chatId, 'I can only process text for now. Send a text message.')
      );
      return new Response('ok', { status: 200 });
    }

    // ── 6. /start command ────────────────────────────────────────────────────
    if (text.trim() === '/start') {
      ctx.waitUntil(
        sendTelegramMessage(config, chatId, 'ContemPlace is running. Send me any text to capture it as a note.')
      );
      return new Response('ok', { status: 200 });
    }

    // ── 7. Dedup check ───────────────────────────────────────────────────────
    const db = createSupabaseClient(config);
    const isNew = await tryClaimUpdate(db, update.update_id);
    if (!isNew) {
      return new Response('ok', { status: 200 });
    }

    // ── 8. Return 200, process in background ─────────────────────────────────
    ctx.waitUntil(processCapture(config, chatId, text, db));
    return new Response('ok', { status: 200 });
  },
} satisfies ExportedHandler<Env>;

async function processCapture(
  config: Config,
  chatId: number,
  text: string,
  db: SupabaseClientType,
): Promise<void> {
  try {
    const openai = createOpenAIClient(config);

    // Step 1: Embed raw text + fetch capture voice + send typing (all independent)
    const [rawEmbedding, captureVoice] = await Promise.all([
      embedText(openai, config, text),
      getCaptureVoice(db),
      sendTypingAction(config, chatId),
    ]);

    // Step 2: Find related notes using raw embedding
    const relatedNotes = await findRelatedNotes(db, rawEmbedding, config.matchThreshold);

    // Step 3: Run capture LLM (capture voice from DB, not hardcoded)
    const capture = await runCaptureAgent(openai, config, text, relatedNotes, captureVoice);

    if (capture.corrections?.length) {
      console.log(JSON.stringify({ event: 'corrections', corrections: capture.corrections, chatId }));
    }

    // Step 4: Re-embed with metadata augmentation, fall back to raw on failure [Review fix 12-§5d]
    let storedEmbedding: number[];
    let embeddingType = 'augmented';
    try {
      const augmentedInput = buildEmbeddingInput(text, capture);
      storedEmbedding = await embedText(openai, config, augmentedInput);
    } catch (embedErr) {
      console.warn(JSON.stringify({
        event: 'augmented_embed_fallback',
        error: embedErr instanceof Error ? embedErr.message : String(embedErr),
        chatId,
      }));
      storedEmbedding = rawEmbedding;
      embeddingType = 'raw_fallback';
    }

    // Step 5: Insert note and links
    const noteId = await insertNote(db, capture, storedEmbedding, text);
    await insertLinks(db, noteId, capture.links);

    // Step 6: Build HTML confirmation reply
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const sep = '──────────────────────';

    const lines: string[] = [
      `<b>${esc(capture.title)}</b>`,
      sep,
      esc(capture.body),
      '',
      `<i>${capture.type} · ${capture.intent} · ${capture.tags.map(esc).join(', ')}</i>`, // tags escaped [Review fix 08-§3.1]
    ];

    const linkedTitles = capture.links
      .map(l => {
        const matched = relatedNotes.find(n => n.id === l.to_id);
        return matched ? `[[${esc(matched.title)}]]` : null;
      })
      .filter((t): t is string => t !== null);

    if (linkedTitles.length > 0) {
      lines.push(`Linked: ${linkedTitles.join(', ')}`);
    }

    if (capture.corrections?.length) {
      lines.push(`Corrections: ${capture.corrections.map(esc).join(', ')}`);
    }

    if (capture.source_ref) {
      lines.push(`Source: ${esc(capture.source_ref)}`);
    }

    if (capture.entities.length > 0) {
      const entityNames = capture.entities.map(e => esc(e.name)).join(', ');
      lines.push(`Entities: ${entityNames}`);
    }

    const reply = lines.join('\n').slice(0, 4096); // cap at Telegram limit [Review fix 08-§1.2]

    // Step 7: Log enrichment and send reply in parallel [Review fix 11-§1]
    await Promise.all([
      logEnrichments(db, noteId, [
        { enrichment_type: 'capture', model_used: config.captureModel },
        { enrichment_type: `embedding_${embeddingType}`, model_used: config.embedModel },
      ]),
      sendTelegramMessage(config, chatId, reply, 'HTML'),
    ]);
  } catch (err: unknown) {
    // Generic error to user, detailed log to console [Review fix 08-§6.1]
    const errorMessage = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({
      event: 'capture_error',
      error: errorMessage,
      chatId,
      textPreview: text.slice(0, 100),
    }));
    await sendTelegramMessage(
      config,
      chatId,
      'Something went wrong capturing your note. Check the Worker logs for details.',
    );
  }
}
```

---

## Task 8 — Create `tests/parser.test.ts`

> **Review fix [12-§4a]:** The parser validates 10 fields with 5 fallback behaviors. All pure logic, no dependencies. Must be tested in isolation.

```typescript
import { describe, it, expect } from 'vitest';
import { parseCaptureResponse } from '../src/capture';

const VALID_BASE = {
  title: 'Test title',
  body: 'Test body.',
  type: 'idea',
  tags: ['test'],
  source_ref: null,
  corrections: null,
  intent: 'remember',
  modality: 'text',
  entities: [],
  links: [],
};

function make(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...VALID_BASE, ...overrides });
}

describe('parseCaptureResponse', () => {
  it('parses valid complete JSON', () => {
    const result = parseCaptureResponse(make());
    expect(result.title).toBe('Test title');
    expect(result.type).toBe('idea');
    expect(result.intent).toBe('remember');
    expect(result.modality).toBe('text');
    expect(result.entities).toEqual([]);
  });

  it('strips markdown code fences', () => {
    const result = parseCaptureResponse('```json\n' + make() + '\n```');
    expect(result.title).toBe('Test title');
  });

  it('defaults invalid type to idea', () => {
    const result = parseCaptureResponse(make({ type: 'bogus' }));
    expect(result.type).toBe('idea');
  });

  it('defaults missing intent to remember', () => {
    const json = { ...VALID_BASE };
    delete (json as Record<string, unknown>)['intent'];
    const result = parseCaptureResponse(JSON.stringify(json));
    expect(result.intent).toBe('remember');
  });

  it('defaults invalid intent to remember', () => {
    const result = parseCaptureResponse(make({ intent: 'wish' }));
    expect(result.intent).toBe('remember');
  });

  it('defaults missing modality to text', () => {
    const json = { ...VALID_BASE };
    delete (json as Record<string, unknown>)['modality'];
    const result = parseCaptureResponse(JSON.stringify(json));
    expect(result.modality).toBe('text');
  });

  it('defaults invalid modality to text', () => {
    const result = parseCaptureResponse(make({ modality: 'video' }));
    expect(result.modality).toBe('text');
  });

  it('filters entities with invalid types', () => {
    const result = parseCaptureResponse(make({
      entities: [
        { name: 'Claude', type: 'tool' },
        { name: 'Acme', type: 'organization' },
      ],
    }));
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]!.name).toBe('Claude');
  });

  it('filters entities with names exceeding 200 chars', () => {
    const result = parseCaptureResponse(make({
      entities: [{ name: 'x'.repeat(201), type: 'tool' }],
    }));
    expect(result.entities).toHaveLength(0);
  });

  it('filters entities missing name field', () => {
    const result = parseCaptureResponse(make({
      entities: [{ type: 'tool' }],
    }));
    expect(result.entities).toHaveLength(0);
  });

  it('handles empty entities array', () => {
    const result = parseCaptureResponse(make({ entities: [] }));
    expect(result.entities).toEqual([]);
  });

  it('converts empty corrections array to null', () => {
    const result = parseCaptureResponse(make({ corrections: [] }));
    expect(result.corrections).toBeNull();
  });

  it('converts non-array corrections to null', () => {
    const result = parseCaptureResponse(make({ corrections: 'not an array' }));
    expect(result.corrections).toBeNull();
  });

  it('preserves valid corrections', () => {
    const result = parseCaptureResponse(make({ corrections: ['cattle → kettle'] }));
    expect(result.corrections).toEqual(['cattle → kettle']);
  });

  it('filters links with invalid link_type', () => {
    const result = parseCaptureResponse(make({
      links: [
        { to_id: '123', link_type: 'extends' },
        { to_id: '456', link_type: 'is-similar-to' },
      ],
    }));
    expect(result.links).toHaveLength(1);
    expect(result.links[0]!.link_type).toBe('extends');
  });

  it('throws on non-JSON string', () => {
    expect(() => parseCaptureResponse('not json')).toThrow('invalid JSON');
  });

  it('throws on missing required fields', () => {
    expect(() => parseCaptureResponse(JSON.stringify({ body: 'x' }))).toThrow('missing title');
  });
});
```

---

## Task 9 — Update `tests/smoke.test.ts`

Review fixes incorporated:
- **[12-§1a]** Assert field values against allowed sets, not just non-null
- **[12-§1b]** Assert enrichment_log entries
- **[12-§6a]** Wait time increased to 15 seconds
- **[12-§8e]** Dedup test asserts single-insertion

```typescript
import { describe, it, expect, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const WORKER_URL = process.env.WORKER_URL ?? '';
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET ?? '';
const CHAT_ID = Number(process.env.TELEGRAM_CHAT_ID ?? '0');
const UPDATE_ID_BASE = Date.now();

const VALID_INTENTS = ['reflect', 'plan', 'create', 'remember', 'reference', 'log'];
const VALID_MODALITIES = ['text', 'link', 'list', 'mixed'];

const TEST_RAW_INPUTS = [
  '[SMOKE-TEST] Constraints make creative work stronger.',
  '[SMOKE-TEST] Dedup test note.',
];

function makeUpdate(updateId: number, text: string) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: CHAT_ID, type: 'private' },
      text,
    },
  };
}

async function post(body: unknown, secret = WEBHOOK_SECRET): Promise<Response> {
  return fetch(WORKER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-bot-api-secret-token': secret,
    },
    body: JSON.stringify(body),
  });
}

function supabase() {
  return createClient(
    process.env.SUPABASE_URL ?? '',
    process.env.SUPABASE_SERVICE_ROLE_KEY ?? '',
  );
}

afterAll(async () => {
  const db = supabase();
  const { error } = await db
    .from('notes')
    .delete()
    .in('raw_input', TEST_RAW_INPUTS);
  if (error) {
    console.warn('Cleanup failed:', error.message);
  }
});

describe('Worker security', () => {
  it('rejects GET requests', async () => {
    const res = await fetch(WORKER_URL, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('rejects missing secret', async () => {
    const res = await fetch(WORKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(403);
  });

  it('rejects wrong secret', async () => {
    const res = await post({}, 'wrong-secret');
    expect(res.status).toBe(403);
  });
});

describe('Worker happy path', () => {
  it('returns 200 for /start command', async () => {
    const res = await post(makeUpdate(UPDATE_ID_BASE + 1, '/start'));
    expect(res.status).toBe(200);
  });

  it('captures a note with v2 fields and enrichment log', async () => {
    const res = await post(makeUpdate(UPDATE_ID_BASE + 2, '[SMOKE-TEST] Constraints make creative work stronger.'));
    expect(res.status).toBe(200);

    // Wait for background processing (two-pass embedding) [Review fix 12-§6a]
    await new Promise(r => setTimeout(r, 15000));

    const db = supabase();
    const { data, error } = await db
      .from('notes')
      .select('id, title, embedding, intent, modality, entities, embedded_at')
      .eq('raw_input', '[SMOKE-TEST] Constraints make creative work stronger.')
      .order('created_at', { ascending: false })
      .limit(1);

    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect(data!.length).toBeGreaterThan(0);

    const note = data![0]!;
    expect(note.embedding).not.toBeNull();
    expect(note.embedded_at).not.toBeNull();
    // Validate against allowed sets, not just non-null [Review fix 12-§1a]
    expect(VALID_INTENTS).toContain(note.intent);
    expect(VALID_MODALITIES).toContain(note.modality);
    expect(note.entities).not.toBeNull();

    // Verify enrichment log entries [Review fix 12-§1b]
    const { data: logs } = await db
      .from('enrichment_log')
      .select('enrichment_type, model_used')
      .eq('note_id', note.id);

    expect(logs).not.toBeNull();
    expect(logs!.length).toBeGreaterThanOrEqual(2);
    expect(logs!.every((l: { model_used: string | null }) => l.model_used !== null)).toBe(true);
  }, 30000);

  it('returns 200 for non-message updates', async () => {
    const res = await post({
      update_id: UPDATE_ID_BASE + 3,
      edited_message: { message_id: 1, chat: { id: CHAT_ID, type: 'private' }, text: 'edited' },
    });
    expect(res.status).toBe(200);
  });

  it('deduplicates identical update_id and produces exactly one note', async () => {
    const update = makeUpdate(UPDATE_ID_BASE + 4, '[SMOKE-TEST] Dedup test note.');
    const first = await post(update);
    const second = await post(update);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    // Wait for background processing [Review fix 12-§8e]
    await new Promise(r => setTimeout(r, 15000));

    const db = supabase();
    const { data } = await db
      .from('notes')
      .select('id')
      .eq('raw_input', '[SMOKE-TEST] Dedup test note.');
    expect(data).toHaveLength(1);
  }, 30000);
});
```

---

## Task 10 — Deploy and Verify

### 10a — Schema (follow deploy order strictly)

Run the DROP statements in the Supabase SQL Editor (from Task 1 pre-step), then:

```bash
supabase db push
```

**Verify:** Supabase dashboard → Table Editor shows all 8 tables (notes, links, concepts, note_concepts, note_chunks, enrichment_log, capture_profiles, processed_updates). Database → Functions shows `match_notes` (in `public` schema), `match_chunks`, and `update_updated_at`. Confirm all 8 tables show "RLS Enabled" with one policy each.

### 10b — Seed concepts

Run `supabase/seed/seed_concepts.sql` in the Supabase SQL Editor. Verify 10 rows in the `concepts` table.

### 10c — Typecheck

```bash
npx tsc --noEmit
```

Must pass with zero errors.

### 10d — Parser unit tests

```bash
npx vitest run tests/parser.test.ts
```

All parser tests must pass. These run locally, no external dependencies.

### 10e — Deploy Worker (only after schema is verified)

```bash
wrangler deploy
```

### 10f — Register BotFather commands [Review fix 09-§8b]

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{"commands": [{"command": "start", "description": "Show welcome message"}]}'
```

### 10g — Manual verification

Send a message to the bot. Verify:
- Telegram reply shows `type · intent · tags` line (e.g., `idea · remember · creativity, constraints`)
- Telegram reply shows `Entities:` line if entities were extracted
- Supabase Table Editor → `notes` row has valid `intent`, `modality`, non-null `embedded_at`
- `enrichment_log` has entries for the note

### 10h — Smoke tests

```bash
npx vitest run tests/smoke.test.ts
```

All tests must pass.

---

## Task 11 — Update CLAUDE.md

Update the project CLAUDE.md to reflect the v2 schema and behavior. Key sections to update:

- **Project Layout**: add `supabase/seed/` directory, `tests/parser.test.ts`
- **Capture Agent Output Format**: add `intent`, `modality`, `entities` fields; note 6 intent values
- **Capture Logic**: add step for re-embedding with metadata augmentation and fallback; note that capture voice is fetched from `capture_profiles` table, not hardcoded
- **Schema**: note the expanded tables (concepts, note_concepts, note_chunks, enrichment_log, capture_profiles)
- **Architecture**: document the system frame / capture voice split. System frame (structural contract: JSON schema, field enums, entity/link rules) lives in code. Capture voice (title style, body rules, traceability, tone) lives in `capture_profiles` table and is fetched at runtime by any capture interface.
- **Hard Constraints**: add constraint about metadata-augmented embeddings; note functions must be in `public` schema with `search_path = 'public, extensions'`; add constraint that stylistic prompt rules must come from `capture_profiles`, never hardcoded
- **Phase Scope**: update Phase 1.5 as current, revise Phase 2 scope
- **Key Commands**: add `npx vitest run tests/parser.test.ts` for parser unit tests

---

## Deferred: Phase 2 — Gardening Pipeline + MCP Server

These features use the schema built in this plan but are not part of the current sprint.

### Nightly similarity link generation

A scheduled job queries all notes, computes pairwise cosine similarity, and inserts `is-similar-to` links for pairs above 0.80. These links have `created_by = 'gardener'` and `confidence` set to the similarity score.

### Tag normalization via SKOS concepts

Embed each concept's `pref_label || ' ' || definition`. For each note's tags, find the nearest concept by cosine similarity. Insert into `note_concepts`. Populate `refined_tags`.

### Chunk generation

For notes with `raw_input` longer than ~500 tokens: split into overlapping chunks of ~300 tokens, embed each chunk, insert into `note_chunks`. The `match_chunks` function enables fine-grained RAG retrieval in the MCP server.

### MCP server

Exposes semantic search to AI agents via the Model Context Protocol. Uses both `match_notes` and `match_chunks`. Can filter by `intent`, `type`, `tags`, and full-text search.

### Maturity scoring

Weekly job computes `importance_score` from inbound link count, recency, and type weighting. Updates `maturity` based on score thresholds.

## Deferred: Phase 3

### Associative trails

`trails` and `trail_steps` tables. Auto-generated by finding chains of `extends` links, or curated by the user.

### Type inheritance

`note_types` table with `parent_type_id` and `field_schema`. Only when the 4 note types strain under diverse content.

### Location extraction

`location_name` column on notes. NLP extraction from text. Deferred until a channel with geotag support is added.

---

## Completion Criteria

This plan is done when:

1. The v2 schema is deployed with all 8 tables (including `capture_profiles`) and both RPC functions (in `public` schema).
2. Concepts table is seeded with initial vocabulary.
3. All source files compile with `tsc --noEmit`.
4. All parser unit tests pass.
5. A real Telegram message produces a note with valid `intent`, `modality`, non-null `embedded_at`.
6. The Telegram reply shows `type · intent · tags` and entities.
7. The `enrichment_log` has entries for each capture.
8. Error messages in Telegram are generic (no internal details).
9. All smoke tests pass.
10. CLAUDE.md is updated.

---

## Appendix A: File-by-file diff summary

| File | Action | What changes |
|---|---|---|
| `supabase/migrations/20260101000000_initial_schema.sql` | Delete | Replaced by v2 migration |
| `supabase/migrations/20260309000000_v2_schema.sql` | Create | Full schema: 8 tables (includes `capture_profiles` with seeded default), 2 RPC functions, RLS, indexes |
| `supabase/seed/seed_concepts.sql` | Create | Initial SKOS domain concepts |
| `src/types.ts` | Replace | New types: Intent (6 values), Modality, Entity, CaptureLinkType, expanded CaptureResult and MatchedNote |
| `src/embed.ts` | Edit | Add `buildEmbeddingInput()` function (capture param required) |
| `src/capture.ts` | Replace | Prompt split into `SYSTEM_FRAME` (structural contract, in code) + capture voice (stylistic rules, from DB). `runCaptureAgent` accepts `captureVoice` param. Parser exported, fallback logging, entity name length limit |
| `src/db.ts` | Replace | insertNote writes new columns, batched `logEnrichments`, new `getCaptureVoice` fetches stylistic prompt from `capture_profiles` table, findRelatedNotes passes new params |
| `src/index.ts` | Replace | Two-pass embedding with fallback, capture voice fetched in parallel with embedding, generic error messages, tag escaping, batched+parallelized enrichment log + Telegram reply, message length cap |
| `src/config.ts` | No change | — |
| `src/telegram.ts` | No change | — |
| `tests/parser.test.ts` | Create | Unit tests for all 5 fallback behaviors in parseCaptureResponse |
| `tests/smoke.test.ts` | Replace | Value validation against allowed sets, enrichment_log assertions, 15s wait, dedup single-insertion assertion |
| `CLAUDE.md` | Edit | Updated schema docs, capture format, phase scope, new constraints |

## Appendix B: Review fixes incorporated

Every critical and important finding from reviews 07–12 is addressed in this plan. Each fix is annotated inline with its source (e.g., `[Review fix 07-§1a]`). Advisory items are noted but deferred where appropriate. The full review trail lives in `reviews/07-v2-schema.md` through `reviews/12-v2-testing.md`.

| Review | Critical fixes | Important fixes |
|---|---|---|
| 07 Schema | `content_tsv` excludes `raw_input`; functions in `public` schema; `search_path = 'public, extensions'` | Drop old functions before recreate; enrichment_log composite index |
| 08 Security | Generic error messages to Telegram | Entity name length limit; tags escaped; trigger search_path pinned; entity prompt tightened |
| 09 Integrations | Functions in `public` schema (confirms 07); migration SET search_path | BotFather command registration |
| 10 Prompt | Type/intent independence instruction | Intent reduced to 6; tiebreaker rules; entity proper-noun guardrail; corrected names → entities; max_tokens bumped to 1536 |
| 11 Performance | — | Batch enrichment log inserts; parallelize with Telegram reply; `jsonb_path_ops` for entities index |
| 12 Testing | Parser unit tests; augmented embed fallback; deploy order documented | Field value assertions; enrichment_log assertions; 15s wait; dedup assertion |

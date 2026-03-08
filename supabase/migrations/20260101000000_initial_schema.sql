-- Enable pgvector
create extension if not exists vector;

-- ============================================================
-- NOTES
-- ============================================================
create table notes (
  id          uuid        primary key default gen_random_uuid(),
  title       text        not null,
  body        text        not null,
  raw_input   text        not null,              -- user's original message, never discarded
  type        text        not null check (type in ('idea', 'reflection', 'source', 'lookup')),
  tags        text[]      not null default '{}',
  source_ref  text,
  source      text        not null default 'telegram',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz,                       -- soft delete; null = active
  embedding   vector(1536)                       -- null until embedding succeeds
);

-- Semantic search index (cosine distance)
-- Partial: excludes unembedded rows so the index only covers searchable notes.
-- ef_construction=128 for better recall on a memory system.
create index notes_embedding_idx on notes
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 128)
  where embedding is not null;

-- Tag filtering
create index notes_tags_idx on notes using gin (tags);

-- Recency ordering
create index notes_created_idx on notes (created_at desc);

-- Active notes only (used by most application queries)
create index notes_active_idx on notes (created_at desc)
  where archived_at is null;

-- Diagnostic: find notes that failed embedding (for cleanup / retry jobs)
create index notes_null_embedding_idx on notes (id)
  where embedding is null and archived_at is null;

-- ============================================================
-- LINKS
-- Treated as immutable: create and delete only, no in-place updates.
-- The unique constraint allows (A→B, 'extends') and (A→B, 'supports')
-- to coexist — two distinct typed relationships between the same pair
-- of notes are semantically valid in the Evergreen Notes model.
-- ============================================================
create table links (
  id         uuid        primary key default gen_random_uuid(),
  from_id    uuid        not null references notes(id) on delete cascade,
  to_id      uuid        not null references notes(id) on delete cascade,
  link_type  text        not null check (link_type in ('extends', 'contradicts', 'supports', 'is-example-of')),
  created_at timestamptz not null default now(),
  unique(from_id, to_id, link_type)
);

-- Lookup links by target (for "what links to this note?" queries)
create index links_to_id_idx on links (to_id);

-- ============================================================
-- ASSETS — deferred to Phase 2 (image handling).
-- Add via standalone migration when needed.
-- ============================================================

-- ============================================================
-- TELEGRAM DEDUPLICATION
-- Unique constraint on update_id is the deduplication guarantee.
-- Two concurrent retry deliveries race to insert; only one wins
-- (23505 unique_violation). The loser returns 200 immediately.
-- ============================================================
create table processed_updates (
  update_id    bigint      primary key,
  processed_at timestamptz not null default now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- Policies use using(false) to deny all non-service-role access.
-- The service role key bypasses RLS entirely at the Postgres level,
-- so using(false) is the unambiguous way to block anon/authenticated
-- access without relying on JWT role matching.
-- ============================================================
alter table notes             enable row level security;
alter table links             enable row level security;
alter table processed_updates enable row level security;

create policy "deny all non-service access" on notes             for all using (false);
create policy "deny all non-service access" on links             for all using (false);
create policy "deny all non-service access" on processed_updates for all using (false);

-- ============================================================
-- UPDATED_AT TRIGGER (notes only — links are immutable)
-- ============================================================
create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger notes_updated_at
  before update on notes
  for each row execute function update_updated_at();

-- ============================================================
-- SEMANTIC SEARCH FUNCTION
-- ============================================================
create or replace function match_notes(
  query_embedding  vector(1536),
  match_threshold  float   default 0.5,
  match_count      int     default 10,
  filter_type      text    default null,
  filter_source    text    default null,
  filter_tags      text[]  default null
)
returns table (
  id          uuid,
  title       text,
  body        text,
  type        text,
  tags        text[],
  source_ref  text,
  source      text,
  created_at  timestamptz,
  similarity  float
)
language sql stable as $$
  select
    n.id,
    n.title,
    n.body,
    n.type,
    n.tags,
    n.source_ref,
    n.source,
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
  order by n.embedding <=> query_embedding
  limit match_count;
$$;

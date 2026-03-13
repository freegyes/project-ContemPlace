-- ============================================================
-- V3 SCHEMA — Clean-slate rebuild
--
-- Removes type, intent, and modality from the notes table and
-- all RPC functions. Consolidates 10 prior migrations into one.
-- refs #110
-- ============================================================

-- PRE-STEP: DROP all existing objects
DROP FUNCTION IF EXISTS match_notes CASCADE;
DROP FUNCTION IF EXISTS match_chunks CASCADE;
DROP FUNCTION IF EXISTS batch_update_refined_tags CASCADE;
DROP FUNCTION IF EXISTS find_similar_pairs CASCADE;
DROP FUNCTION IF EXISTS update_updated_at CASCADE;

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

-- ============================================================
-- EXTENSIONS
-- ============================================================
CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions;

-- ============================================================
-- NOTES
-- ============================================================
CREATE TABLE notes (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),

  -- CAPTURE-TIME (required: only raw_input + timestamp)
  raw_input       text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  -- CAPTURE-TIME (from LLM, single-pass)
  title           text        NOT NULL,
  body            text        NOT NULL,
  tags            text[]      NOT NULL DEFAULT '{}',
  source_ref      text,
  source          text        NOT NULL DEFAULT 'telegram',
  corrections     text[],
  entities        jsonb       DEFAULT '[]',

  -- GARDENING-TIME (auto-populated by enrichment pipeline)
  summary         text,
  refined_tags    text[]      DEFAULT '{}',
  categories      text[]      DEFAULT '{}',
  metadata        jsonb       DEFAULT '{}',
  importance_score float,
  maturity        text        DEFAULT 'seedling' CHECK (maturity IN ('seedling', 'budding', 'evergreen')),

  -- Soft delete
  archived_at     timestamptz,

  -- Embeddings
  embedding       extensions.vector(1536),
  embedded_at     timestamptz,

  -- Full-text search (hybrid with vector)
  content_tsv     tsvector GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(title, '') || ' ' || body)
  ) STORED
);

-- Semantic search (cosine distance, partial: excludes unembedded rows)
CREATE INDEX notes_embedding_idx ON notes
  USING hnsw (embedding extensions.vector_cosine_ops)
  WITH (m = 16, ef_construction = 128)
  WHERE embedding IS NOT NULL;

-- Full-text search
CREATE INDEX notes_content_tsv_idx ON notes USING gin (content_tsv);

-- Tag filtering
CREATE INDEX notes_tags_idx ON notes USING gin (tags);

-- Recency ordering
CREATE INDEX notes_created_idx ON notes (created_at DESC);

-- Active notes only
CREATE INDEX notes_active_idx ON notes (created_at DESC)
  WHERE archived_at IS NULL;

-- Orphaned embeddings (for retry jobs)
CREATE INDEX notes_null_embedding_idx ON notes (id)
  WHERE embedding IS NULL AND archived_at IS NULL;

-- Entities — jsonb_path_ops for smaller index and faster @> queries
CREATE INDEX notes_entities_idx ON notes USING gin (entities jsonb_path_ops);

-- ============================================================
-- LINKS
-- ============================================================
CREATE TABLE links (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id     uuid        NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  to_id       uuid        NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  link_type   text        NOT NULL CHECK (link_type IN (
    -- Capture-time (LLM-assigned)
    'extends', 'contradicts', 'supports', 'is-example-of', 'duplicate-of',
    -- Gardening-time (auto-generated)
    'is-similar-to', 'is-part-of', 'follows', 'is-derived-from'
  )),
  context     text,
  confidence  float       DEFAULT 1.0,
  created_by  text        DEFAULT 'capture' CHECK (created_by IN ('capture', 'gardener', 'user')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(from_id, to_id, link_type)
);

CREATE INDEX links_to_id_idx ON links (to_id);
CREATE INDEX links_from_id_idx ON links (from_id);

-- ============================================================
-- SKOS-INSPIRED CONTROLLED VOCABULARY
-- ============================================================
CREATE TABLE concepts (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  scheme      text        NOT NULL,
  pref_label  text        NOT NULL,
  alt_labels  text[]      DEFAULT '{}',
  broader_id  uuid        REFERENCES concepts(id),
  definition  text,
  embedding   extensions.vector(1536),
  UNIQUE(scheme, pref_label)
);

CREATE TABLE note_concepts (
  note_id     uuid        REFERENCES notes(id) ON DELETE CASCADE,
  concept_id  uuid        REFERENCES concepts(id) ON DELETE CASCADE,
  created_by  text        NOT NULL DEFAULT 'gardener',
  PRIMARY KEY (note_id, concept_id)
);

-- ============================================================
-- NOTE CHUNKS (for RAG — long notes split for precise retrieval)
-- ============================================================
CREATE TABLE note_chunks (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id     uuid        NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  chunk_index integer     NOT NULL,
  content     text        NOT NULL,
  embedding   extensions.vector(1536),
  UNIQUE(note_id, chunk_index)
);

CREATE INDEX note_chunks_embedding_idx ON note_chunks
  USING hnsw (embedding extensions.vector_cosine_ops)
  WITH (m = 16, ef_construction = 128)
  WHERE embedding IS NOT NULL;

-- ============================================================
-- ENRICHMENT AUDIT LOG
-- ============================================================
CREATE TABLE enrichment_log (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  note_id         uuid        NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  enrichment_type text        NOT NULL,
  model_used      text,
  metadata        jsonb       DEFAULT '{}',
  completed_at    timestamptz DEFAULT now()
);

CREATE INDEX enrichment_log_note_type_idx ON enrichment_log (note_id, enrichment_type);

-- ============================================================
-- CAPTURE PROFILES
-- ============================================================
CREATE TABLE capture_profiles (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text        NOT NULL UNIQUE,
  capture_voice text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- UPDATED_AT TRIGGER
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  new.updated_at = now();
  RETURN new;
END;
$$;

CREATE TRIGGER notes_updated_at
  BEFORE UPDATE ON notes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER capture_profiles_updated_at
  BEFORE UPDATE ON capture_profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Seed the default capture voice (updated version from 20260312000001)
INSERT INTO capture_profiles (name, capture_voice) VALUES ('default', '## Your capture style

**Title**: A claim or insight when one is present. If the input doesn''t contain a claim, use a descriptive phrase.

**Body**: Use the user''s own words. Every sentence must be traceable to the input. 1–3 sentences for short inputs. For longer inputs, use as many sentences as needed to preserve all actionable content — up to 8. Shorter is still better than padded.');

-- ============================================================
-- TELEGRAM DEDUPLICATION
-- ============================================================
CREATE TABLE processed_updates (
  update_id    bigint      PRIMARY KEY,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE notes             ENABLE ROW LEVEL SECURITY;
ALTER TABLE links             ENABLE ROW LEVEL SECURITY;
ALTER TABLE concepts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_concepts     ENABLE ROW LEVEL SECURITY;
ALTER TABLE note_chunks       ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_log    ENABLE ROW LEVEL SECURITY;
ALTER TABLE capture_profiles  ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_updates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "deny all" ON notes             FOR ALL USING (false);
CREATE POLICY "deny all" ON links             FOR ALL USING (false);
CREATE POLICY "deny all" ON concepts          FOR ALL USING (false);
CREATE POLICY "deny all" ON note_concepts     FOR ALL USING (false);
CREATE POLICY "deny all" ON note_chunks       FOR ALL USING (false);
CREATE POLICY "deny all" ON enrichment_log    FOR ALL USING (false);
CREATE POLICY "deny all" ON capture_profiles  FOR ALL USING (false);
CREATE POLICY "deny all" ON processed_updates FOR ALL USING (false);

-- ============================================================
-- SEMANTIC SEARCH FUNCTION (v3 — no type/intent/modality)
-- ============================================================
CREATE FUNCTION match_notes(
  query_embedding  extensions.vector(1536),
  match_threshold  float   DEFAULT 0.5,
  match_count      int     DEFAULT 10,
  filter_source    text    DEFAULT NULL,
  filter_tags      text[]  DEFAULT NULL,
  search_text      text    DEFAULT NULL
)
RETURNS TABLE (
  id          uuid,
  title       text,
  body        text,
  raw_input   text,
  tags        text[],
  source_ref  text,
  source      text,
  entities    jsonb,
  created_at  timestamptz,
  similarity  float
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    n.id,
    n.title,
    n.body,
    n.raw_input,
    n.tags,
    n.source_ref,
    n.source,
    n.entities,
    n.created_at,
    (1 - (n.embedding OPERATOR(extensions.<=>) query_embedding))::float AS similarity
  FROM public.notes n
  WHERE
    n.embedding IS NOT NULL
    AND n.archived_at IS NULL
    AND 1 - (n.embedding OPERATOR(extensions.<=>) query_embedding) > match_threshold
    AND (filter_source IS NULL OR n.source = filter_source)
    AND (filter_tags   IS NULL OR n.tags   @> filter_tags)
    AND (search_text   IS NULL OR n.content_tsv @@ plainto_tsquery('english', search_text))
  ORDER BY n.embedding OPERATOR(extensions.<=>) query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================================
-- CHUNK SEARCH FUNCTION (v3 — no type/intent)
-- ============================================================
CREATE FUNCTION match_chunks(
  query_embedding  extensions.vector(1536),
  match_threshold  float   DEFAULT 0.5,
  match_count      int     DEFAULT 20
)
RETURNS TABLE (
  chunk_id    uuid,
  note_id     uuid,
  chunk_index integer,
  content     text,
  note_title  text,
  note_tags   text[],
  similarity  float
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id AS chunk_id,
    c.note_id,
    c.chunk_index,
    c.content,
    n.title AS note_title,
    n.tags AS note_tags,
    (1 - (c.embedding OPERATOR(extensions.<=>) query_embedding))::float AS similarity
  FROM public.note_chunks c
  JOIN public.notes n ON n.id = c.note_id
  WHERE
    c.embedding IS NOT NULL
    AND n.archived_at IS NULL
    AND 1 - (c.embedding OPERATOR(extensions.<=>) query_embedding) > match_threshold
  ORDER BY c.embedding OPERATOR(extensions.<=>) query_embedding
  LIMIT match_count;
END;
$$;

-- ============================================================
-- BATCH UPDATE REFINED TAGS
-- ============================================================
CREATE FUNCTION batch_update_refined_tags(updates jsonb)
RETURNS void
LANGUAGE plpgsql
SET search_path = 'public'
AS $$
BEGIN
  UPDATE notes n
  SET refined_tags = ARRAY(SELECT jsonb_array_elements_text(u.value->'refined_tags'))
  FROM jsonb_array_elements(updates) AS u(value)
  WHERE n.id = (u.value->>'id')::uuid;
END;
$$;

-- ============================================================
-- FIND SIMILAR PAIRS (for gardener similarity linker)
-- ============================================================
CREATE FUNCTION find_similar_pairs(
  similarity_threshold float DEFAULT 0.70,
  max_pairs int DEFAULT 10000
)
RETURNS TABLE (
  note_a uuid,
  note_b uuid,
  similarity float
)
LANGUAGE plpgsql STABLE
SET search_path = public, extensions
AS $$
BEGIN
  RETURN QUERY
  SELECT
    a.id AS note_a,
    b.id AS note_b,
    (1 - (a.embedding OPERATOR(extensions.<=>) b.embedding))::float AS similarity
  FROM public.notes a
  JOIN public.notes b ON a.id < b.id
  WHERE
    a.embedding IS NOT NULL
    AND b.embedding IS NOT NULL
    AND a.archived_at IS NULL
    AND b.archived_at IS NULL
    AND 1 - (a.embedding OPERATOR(extensions.<=>) b.embedding) > similarity_threshold
  ORDER BY similarity DESC
  LIMIT max_pairs;
END;
$$;

-- ============================================================
-- SEED: SKOS DOMAIN CONCEPTS
-- ============================================================
INSERT INTO concepts (scheme, pref_label, alt_labels, definition) VALUES
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

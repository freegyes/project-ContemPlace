-- Fix match_notes and match_chunks: schema-qualify table references and
-- correct the search_path syntax (unquoted, no comma-in-string ambiguity).
--
-- Root cause: set search_path = 'public, extensions' (quoted form) was not
-- applying the search_path correctly inside the function body, causing
-- "relation notes does not exist" at runtime. The fix uses schema-qualified
-- table names (public.notes, public.note_chunks) as the primary fix, and
-- corrects the SET clause to the unquoted form as belt-and-suspenders.
-- The extensions search_path entry is still needed for the <=> operator.

CREATE OR REPLACE FUNCTION match_notes(
  query_embedding  extensions.vector(1536),
  match_threshold  float   DEFAULT 0.5,
  match_count      int     DEFAULT 10,
  filter_type      text    DEFAULT NULL,
  filter_source    text    DEFAULT NULL,
  filter_tags      text[]  DEFAULT NULL,
  filter_intent    text    DEFAULT NULL,
  search_text      text    DEFAULT NULL
)
RETURNS TABLE (
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
    n.type,
    n.tags,
    n.source_ref,
    n.source,
    n.intent,
    n.modality,
    n.entities,
    n.created_at,
    (1 - (n.embedding <=> query_embedding))::float AS similarity
  FROM public.notes n
  WHERE
    n.embedding IS NOT NULL
    AND n.archived_at IS NULL
    AND 1 - (n.embedding <=> query_embedding) > match_threshold
    AND (filter_type   IS NULL OR n.type   = filter_type)
    AND (filter_source IS NULL OR n.source = filter_source)
    AND (filter_tags   IS NULL OR n.tags   @> filter_tags)
    AND (filter_intent IS NULL OR n.intent = filter_intent)
    AND (search_text   IS NULL OR n.content_tsv @@ plainto_tsquery('english', search_text))
  ORDER BY n.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

CREATE OR REPLACE FUNCTION match_chunks(
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
    (1 - (c.embedding <=> query_embedding))::float AS similarity
  FROM public.note_chunks c
  JOIN public.notes n ON n.id = c.note_id
  WHERE
    c.embedding IS NOT NULL
    AND n.archived_at IS NULL
    AND 1 - (c.embedding <=> query_embedding) > match_threshold
  ORDER BY c.embedding <=> query_embedding
  LIMIT match_count;
END;
$$;

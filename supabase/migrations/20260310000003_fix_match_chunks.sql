-- Fix match_chunks: use OPERATOR(extensions.<=>) and extend return columns
-- for the search_chunks MCP tool (refs #43).
--
-- The original match_chunks used bare <=> which may fail through PostgREST's
-- connection pooler context. Also adds note_type, note_intent, note_tags to
-- the return set so the MCP tool can display note metadata alongside chunks.

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
  note_type   text,
  note_intent text,
  note_tags   text[],
  similarity  float
)
LANGUAGE plpgsql STABLE
SET search_path = 'public, extensions'
AS $$
BEGIN
  RETURN QUERY
  SELECT
    c.id AS chunk_id,
    c.note_id,
    c.chunk_index,
    c.content,
    n.title AS note_title,
    n.type AS note_type,
    n.intent AS note_intent,
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

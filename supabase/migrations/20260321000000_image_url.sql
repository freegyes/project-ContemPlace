-- ============================================================
-- ADD IMAGE_URL COLUMN TO NOTES
-- ============================================================
-- Stores the public URL of an image attached to a note.
-- Nullable — most notes have no image. Added for #209 (visual reference capture).

ALTER TABLE notes ADD COLUMN image_url text;

-- ============================================================
-- RECREATE match_notes WITH image_url IN RETURN TYPE
-- ============================================================
-- Adding a column to the RETURNS TABLE requires DROP + CREATE (not CREATE OR REPLACE).

DROP FUNCTION IF EXISTS match_notes;

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
  image_url   text,
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
    n.image_url,
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

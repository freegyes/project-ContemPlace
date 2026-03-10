-- Batch-update refined_tags for multiple notes in a single round-trip.
-- Replaces per-note UPDATE calls in the gardener tag normalization step,
-- reducing Supabase subrequest count from N (one per note) to 1.
--
-- Input: JSONB array of objects: [{"id": "<uuid>", "refined_tags": ["tag1", "tag2"]}, ...]
-- Uses a single UPDATE ... FROM join — one statement, not a loop.

CREATE OR REPLACE FUNCTION batch_update_refined_tags(updates jsonb)
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

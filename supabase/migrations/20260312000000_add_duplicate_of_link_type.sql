-- Add 'duplicate-of' to links.link_type CHECK constraint.
-- This type was already in the SYSTEM_FRAME and parser VALID_LINK_TYPES
-- but was never added to the DB constraint (schema bug found in #75).
-- Any capture-time duplicate-of links were silently dropped on insert.

DO $$
DECLARE cname text;
BEGIN
  SELECT conname INTO cname FROM pg_constraint
  WHERE conrelid = 'public.links'::regclass AND contype = 'c'
  AND pg_get_constraintdef(oid) ILIKE '%link_type%';
  IF cname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE public.links DROP CONSTRAINT %I', cname);
  END IF;
END $$;

ALTER TABLE public.links ADD CONSTRAINT links_link_type_check CHECK (link_type IN (
    -- Capture-time (LLM-assigned)
    'extends', 'contradicts', 'supports', 'is-example-of', 'duplicate-of',
    -- Gardening-time (auto-generated)
    'is-similar-to', 'is-part-of', 'follows', 'is-derived-from'
));

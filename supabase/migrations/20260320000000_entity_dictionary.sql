-- ============================================================
-- ENTITY DICTIONARY TABLE
-- Gardener-maintained corpus-level proper noun tracking (#125).
-- Canonical entries with aliases, note counts, and temporal metadata.
-- Clean-slate rebuilt on each gardener run from enrichment_log extractions.
-- ============================================================

CREATE TABLE entity_dictionary (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text        NOT NULL,
  type        text        NOT NULL CHECK (type IN ('person', 'place', 'tool', 'project')),
  aliases     text[]      NOT NULL DEFAULT '{}',
  note_count  int         NOT NULL DEFAULT 0,
  note_ids    uuid[]      NOT NULL DEFAULT '{}',
  first_seen  timestamptz NOT NULL DEFAULT now(),
  last_seen   timestamptz NOT NULL DEFAULT now(),
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE(name, type)
);

-- Indexes
CREATE INDEX entity_dictionary_type_idx ON entity_dictionary (type);
CREATE INDEX entity_dictionary_aliases_idx ON entity_dictionary USING gin (aliases);

-- RLS: deny all (same pattern as all other tables)
ALTER TABLE entity_dictionary ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Deny all access to entity_dictionary" ON entity_dictionary
  FOR ALL USING (false);

-- Reuse the existing update_updated_at() trigger function
CREATE TRIGGER entity_dictionary_updated_at
  BEFORE UPDATE ON entity_dictionary
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

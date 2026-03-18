-- ============================================================
-- CLUSTERS TABLE
-- Stores pre-computed Louvain community detection results.
-- Clean-slate per gardener run: all rows deleted and re-inserted.
-- ============================================================

CREATE TABLE clusters (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  resolution  float       NOT NULL,
  label       text        NOT NULL,
  note_ids    uuid[]      NOT NULL,
  top_tags    text[]      NOT NULL DEFAULT '{}',
  gravity     float       NOT NULL,
  modularity  float,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX clusters_resolution_idx ON clusters (resolution);

ALTER TABLE clusters ENABLE ROW LEVEL SECURITY;
CREATE POLICY "deny all" ON clusters FOR ALL USING (false);

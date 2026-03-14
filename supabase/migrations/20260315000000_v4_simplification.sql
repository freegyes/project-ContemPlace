-- ============================================================
-- V4 SCHEMA SIMPLIFICATION
--
-- Bundles four decided changes into one migration:
--   #117 — Drop maturity, importance_score from notes
--   #122 — Drop SKOS (concepts, note_concepts, refined_tags)
--   #124 — Simplify link types: 9 → 3 (contradicts, related, is-similar-to)
--   #127 — Drop chunking (note_chunks, match_chunks)
--
-- refs #128
-- ============================================================

-- ── 1. Drop old CHECK constraint so we can reclassify link types ─────────────
ALTER TABLE links DROP CONSTRAINT IF EXISTS links_link_type_check;

-- ── 2. Reclassify link types ─────────────────────────────────────────────────
-- Handle potential UNIQUE(from_id, to_id, link_type) collisions:
-- If note A→B has both extends and supports, merging both to 'related' would
-- violate the unique constraint. Delete duplicates first (keep earliest).

DELETE FROM links
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY from_id, to_id
      ORDER BY created_at ASC
    ) AS rn
    FROM links
    WHERE link_type IN ('extends', 'supports', 'is-example-of', 'duplicate-of')
  ) sub
  WHERE rn > 1
);

-- Reclassify remaining old capture types to 'related'
UPDATE links SET link_type = 'related'
WHERE link_type IN ('extends', 'supports', 'is-example-of', 'duplicate-of');

-- Drop planned-but-unused gardening link types
DELETE FROM links WHERE link_type IN ('is-part-of', 'follows', 'is-derived-from');

-- Add new CHECK constraint
ALTER TABLE links ADD CONSTRAINT links_link_type_check
  CHECK (link_type IN ('contradicts', 'related', 'is-similar-to'));

-- ── 3. Drop RPC functions that reference dropped tables/columns ─────────────
DROP FUNCTION IF EXISTS match_chunks CASCADE;
DROP FUNCTION IF EXISTS batch_update_refined_tags CASCADE;

-- ── 4. Drop tables ──────────────────────────────────────────────────────────
DROP TABLE IF EXISTS note_chunks CASCADE;
DROP TABLE IF EXISTS note_concepts CASCADE;
DROP TABLE IF EXISTS concepts CASCADE;

-- ── 5. Drop columns from notes ──────────────────────────────────────────────
ALTER TABLE notes DROP COLUMN IF EXISTS refined_tags;
ALTER TABLE notes DROP COLUMN IF EXISTS maturity;
ALTER TABLE notes DROP COLUMN IF EXISTS importance_score;

-- ── 6. Clean up enrichment_log rows for removed phases ──────────────────────
DELETE FROM enrichment_log WHERE enrichment_type IN ('chunking', 'tag_normalization', 'unmatched_tag');

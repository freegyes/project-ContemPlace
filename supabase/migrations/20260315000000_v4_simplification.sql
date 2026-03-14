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

-- ── 1. Reclassify link types BEFORE changing the constraint ──────────────────
-- Handle potential UNIQUE(from_id, to_id, link_type) collisions:
-- If note A→B has both extends and supports, merging both to 'related' would
-- violate the unique constraint. Delete duplicates first (keep earliest).

-- Delete would-be duplicates: for each (from_id, to_id) pair that has multiple
-- old-type links, keep only the one with the earliest created_at.
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

-- Also handle case where a pair already has a 'contradicts' or 'is-similar-to'
-- link and would collide with the reclassified 'related'. Delete old-type links
-- where the same pair already has a link of the target type we'd create.
-- (Edge case: pair has both 'extends' AND 'contradicts' — the extends becomes
-- 'related', no collision. But if pair has 'extends' AND something that would
-- also become 'related', we already handled that above.)

-- Now reclassify remaining old capture types to 'related'
UPDATE links SET link_type = 'related'
WHERE link_type IN ('extends', 'supports', 'is-example-of', 'duplicate-of');

-- Drop planned-but-unused gardening link types
DELETE FROM links WHERE link_type IN ('is-part-of', 'follows', 'is-derived-from');

-- ── 2. Drop RPC functions that reference dropped tables/columns ─────────────
DROP FUNCTION IF EXISTS match_chunks CASCADE;
DROP FUNCTION IF EXISTS batch_update_refined_tags CASCADE;

-- ── 3. Drop tables ──────────────────────────────────────────────────────────
DROP TABLE IF EXISTS note_chunks CASCADE;
DROP TABLE IF EXISTS note_concepts CASCADE;
DROP TABLE IF EXISTS concepts CASCADE;

-- ── 4. Drop columns from notes ──────────────────────────────────────────────
ALTER TABLE notes DROP COLUMN IF EXISTS refined_tags;
ALTER TABLE notes DROP COLUMN IF EXISTS maturity;
ALTER TABLE notes DROP COLUMN IF EXISTS importance_score;

-- ── 5. Update links CHECK constraint ────────────────────────────────────────
ALTER TABLE links DROP CONSTRAINT IF EXISTS links_link_type_check;
ALTER TABLE links ADD CONSTRAINT links_link_type_check
  CHECK (link_type IN ('contradicts', 'related', 'is-similar-to'));

-- ── 6. Clean up enrichment_log rows for removed phases ──────────────────────
DELETE FROM enrichment_log WHERE enrichment_type IN ('chunking', 'tag_normalization', 'unmatched_tag');

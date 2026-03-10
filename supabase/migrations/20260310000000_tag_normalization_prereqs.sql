-- Prerequisites for SKOS tag normalization (refs #40)
--
-- 1. Add metadata JSONB column to enrichment_log — stores unmatched tag strings
--    and future enrichment payloads without repurposing model_used.
-- 2. Add created_by column to note_concepts — enables scoped deletes during
--    gardener recomputation without destroying future capture-time or user-created links.

-- ── enrichment_log: metadata column ─────────────────────────────────────────
alter table enrichment_log
  add column metadata jsonb default '{}';

-- ── note_concepts: created_by column ────────────────────────────────────────
alter table note_concepts
  add column created_by text not null default 'gardener';

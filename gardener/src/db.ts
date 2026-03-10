import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './config';
import type { Concept, Entity, NoteForSimilarity, NoteForTagNorm, SimilarNote, SimilarityLink } from './types';

export function createSupabaseClient(config: Config): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
}

// Delete all gardener-created is-similar-to links. Returns the count deleted.
// This is always the first operation of a gardener run — the clean-slate strategy
// ensures idempotency and keeps the link set consistent with the current threshold.
export async function deleteGardenerSimilarityLinks(db: SupabaseClient): Promise<number> {
  const { data, error } = await db
    .from('links')
    .delete()
    .eq('link_type', 'is-similar-to')
    .eq('created_by', 'gardener')
    .select('id');

  if (error) {
    throw new Error(`Failed to delete gardener similarity links: ${error.message}`);
  }

  return (data as Array<{ id: string }> | null)?.length ?? 0;
}

// Fetch all active notes with embeddings, tags, and entities.
// PostgREST returns pgvector columns as JSON arrays; parse defensively in case the
// response comes back as a string in some environments.
export async function fetchNotesForSimilarity(db: SupabaseClient): Promise<NoteForSimilarity[]> {
  const { data, error } = await db
    .from('notes')
    .select('id, tags, entities, embedding')
    .is('archived_at', null)
    .not('embedding', 'is', null);

  if (error) {
    throw new Error(`Failed to fetch notes for similarity: ${error.message}`);
  }

  const rows = (data as Array<{
    id: string;
    tags: string[] | null;
    entities: unknown;
    embedding: number[] | string;
  }> | null) ?? [];

  return rows.map(row => ({
    id: row.id,
    tags: row.tags ?? [],
    entities: Array.isArray(row.entities) ? (row.entities as Entity[]) : [],
    embedding: typeof row.embedding === 'string'
      ? (JSON.parse(row.embedding) as number[])
      : row.embedding,
  }));
}

// Find notes similar to the given embedding above the threshold via match_notes RPC.
// match_notes does not filter the query note itself — self-similarity (score 1.0)
// must be filtered by the caller.
// match_count=50 is generous; at threshold 0.70 a personal corpus is very unlikely
// to have more than 50 similar neighbors per note.
export async function findSimilarNotes(
  db: SupabaseClient,
  embedding: number[],
  threshold: number,
): Promise<SimilarNote[]> {
  const { data, error } = await db.rpc('match_notes', {
    query_embedding: embedding,
    match_threshold: threshold,
    match_count: 50,
    filter_type: null,
    filter_source: null,
    filter_tags: null,
    filter_intent: null,
    search_text: null,
  });

  if (error) {
    throw new Error(`match_notes RPC failed: ${error.message}`);
  }

  return ((data as Array<{
    id: string;
    tags: string[] | null;
    entities: unknown;
    similarity: number;
  }>) ?? []).map(row => ({
    id: row.id,
    tags: row.tags ?? [],
    entities: row.entities,
    similarity: row.similarity,
  }));
}

// Bulk insert similarity links.
// ON CONFLICT DO NOTHING is a safety net — the clean-slate DELETE at run start
// means conflicts should not occur in normal operation.
export async function insertSimilarityLinks(
  db: SupabaseClient,
  links: SimilarityLink[],
): Promise<void> {
  if (links.length === 0) return;

  const rows = links.map(l => ({
    from_id: l.fromId,
    to_id: l.toId,
    link_type: 'is-similar-to',
    confidence: l.confidence,
    context: l.context,
    created_by: 'gardener',
  }));

  const { error } = await db.from('links').insert(rows);
  if (error) {
    throw new Error(`Failed to insert similarity links: ${error.message}`);
  }
}

// ── Tag normalization DB functions ───────────────────────────────────────────

// Fetch all concepts with their full metadata.
export async function fetchConcepts(db: SupabaseClient): Promise<Concept[]> {
  const { data, error } = await db
    .from('concepts')
    .select('id, scheme, pref_label, alt_labels, definition, embedding');

  if (error) {
    throw new Error(`Failed to fetch concepts: ${error.message}`);
  }

  const rows = (data as Array<{
    id: string;
    scheme: string;
    pref_label: string;
    alt_labels: string[] | null;
    definition: string | null;
    embedding: number[] | string | null;
  }> | null) ?? [];

  return rows.map(row => ({
    id: row.id,
    scheme: row.scheme,
    pref_label: row.pref_label,
    alt_labels: row.alt_labels ?? [],
    definition: row.definition,
    embedding: row.embedding === null
      ? null
      : typeof row.embedding === 'string'
        ? (JSON.parse(row.embedding) as number[])
        : row.embedding,
  }));
}

// Update a concept's embedding.
export async function updateConceptEmbedding(
  db: SupabaseClient,
  conceptId: string,
  embedding: number[],
): Promise<void> {
  const { error } = await db
    .from('concepts')
    .update({ embedding })
    .eq('id', conceptId);

  if (error) {
    throw new Error(`Failed to update concept embedding ${conceptId}: ${error.message}`);
  }
}

// Fetch all active notes with tags for tag normalization.
export async function fetchNotesForTagNorm(db: SupabaseClient): Promise<NoteForTagNorm[]> {
  const { data, error } = await db
    .from('notes')
    .select('id, tags')
    .is('archived_at', null)
    .not('tags', 'eq', '{}');

  if (error) {
    throw new Error(`Failed to fetch notes for tag normalization: ${error.message}`);
  }

  return ((data as Array<{ id: string; tags: string[] | null }>) ?? [])
    .filter(row => row.tags && row.tags.length > 0)
    .map(row => ({ id: row.id, tags: row.tags! }));
}

// Delete all gardener-created note_concepts rows. Returns count deleted.
export async function deleteGardenerNoteConcepts(db: SupabaseClient): Promise<number> {
  const { data, error } = await db
    .from('note_concepts')
    .delete()
    .eq('created_by', 'gardener')
    .select('note_id');

  if (error) {
    throw new Error(`Failed to delete gardener note_concepts: ${error.message}`);
  }

  return (data as Array<{ note_id: string }> | null)?.length ?? 0;
}

// Bulk insert note_concepts rows.
export async function insertNoteConcepts(
  db: SupabaseClient,
  rows: Array<{ note_id: string; concept_id: string }>,
): Promise<void> {
  if (rows.length === 0) return;

  const withCreatedBy = rows.map(r => ({ ...r, created_by: 'gardener' }));

  const { error } = await db.from('note_concepts').insert(withCreatedBy);
  if (error) {
    throw new Error(`Failed to insert note_concepts: ${error.message}`);
  }
}

// Update refined_tags for a single note.
export async function updateRefinedTags(
  db: SupabaseClient,
  noteId: string,
  refinedTags: string[],
): Promise<void> {
  const { error } = await db
    .from('notes')
    .update({ refined_tags: refinedTags })
    .eq('id', noteId);

  if (error) {
    throw new Error(`Failed to update refined_tags for ${noteId}: ${error.message}`);
  }
}

// Clean-slate delete all unmatched_tag enrichment_log rows.
// Matches the similarity linker pattern: delete all, then re-insert for current run.
export async function deleteUnmatchedTagLogs(db: SupabaseClient): Promise<number> {
  const { data, error } = await db
    .from('enrichment_log')
    .delete()
    .eq('enrichment_type', 'unmatched_tag')
    .select('id');

  if (error) {
    throw new Error(`Failed to delete unmatched_tag logs: ${error.message}`);
  }

  return (data as Array<{ id: string }> | null)?.length ?? 0;
}

// Log unmatched tags to enrichment_log with metadata JSONB.
export async function logUnmatchedTags(
  db: SupabaseClient,
  entries: Array<{ note_id: string; tag: string }>,
): Promise<void> {
  if (entries.length === 0) return;

  const rows = entries.map(e => ({
    note_id: e.note_id,
    enrichment_type: 'unmatched_tag',
    model_used: null,
    metadata: { tag: e.tag },
  }));

  const { error } = await db.from('enrichment_log').insert(rows);
  if (error) {
    console.error(JSON.stringify({
      event: 'unmatched_tag_log_error',
      error: error.message,
      count: entries.length,
    }));
  }
}

// Log tag_normalization enrichment entries for processed notes.
export async function logTagNormEnrichments(
  db: SupabaseClient,
  noteIds: string[],
): Promise<void> {
  if (noteIds.length === 0) return;

  const rows = noteIds.map(id => ({
    note_id: id,
    enrichment_type: 'tag_normalization',
    model_used: null,
  }));

  const { error } = await db.from('enrichment_log').insert(rows);
  if (error) {
    console.error(JSON.stringify({
      event: 'tag_norm_enrichment_log_error',
      error: error.message,
      noteCount: noteIds.length,
    }));
  }
}

// Log one enrichment_log row per note that received at least one new outbound link.
// Non-fatal: a logging failure does not roll back the links already inserted.
export async function logEnrichments(
  db: SupabaseClient,
  noteIds: string[],
): Promise<void> {
  if (noteIds.length === 0) return;

  const rows = noteIds.map(id => ({
    note_id: id,
    enrichment_type: 'similarity_link',
    model_used: null,
  }));

  const { error } = await db.from('enrichment_log').insert(rows);
  if (error) {
    console.error(JSON.stringify({
      event: 'enrichment_log_error',
      error: error.message,
      noteCount: noteIds.length,
    }));
  }
}

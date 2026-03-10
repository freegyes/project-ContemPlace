import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './config';
import type { Concept, Entity, NoteForSimilarity, NoteForTagNorm, NoteForChunking, SimilarityLink } from './types';

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

// Find all note pairs above a similarity threshold in a single round-trip.
// Uses the find_similar_pairs RPC (self-join with a.id < b.id ordering).
// Replaces per-note findSimilarNotes calls — 1 subrequest instead of N.
export async function findSimilarPairs(
  db: SupabaseClient,
  threshold: number,
): Promise<Array<{ note_a: string; note_b: string; similarity: number }>> {
  const { data, error } = await db.rpc('find_similar_pairs', {
    similarity_threshold: threshold,
    max_pairs: 10000,
  });

  if (error) {
    throw new Error(`find_similar_pairs RPC failed: ${error.message}`);
  }

  return ((data as Array<{
    note_a: string;
    note_b: string;
    similarity: number;
  }>) ?? []);
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

// Batch-update concept embeddings via upsert (single round-trip).
// Each row must include the full concept data for the upsert to work.
export async function batchUpdateConceptEmbeddings(
  db: SupabaseClient,
  updates: Array<{ id: string; scheme: string; pref_label: string; embedding: number[] }>,
): Promise<void> {
  if (updates.length === 0) return;

  const rows = updates.map(u => ({
    id: u.id,
    scheme: u.scheme,
    pref_label: u.pref_label,
    embedding: u.embedding,
  }));

  const { error } = await db
    .from('concepts')
    .upsert(rows, { onConflict: 'id' });

  if (error) {
    throw new Error(`Failed to batch update concept embeddings: ${error.message}`);
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

// Batch-update refined_tags for multiple notes in a single round-trip.
// Uses the batch_update_refined_tags RPC function (single UPDATE ... FROM join).
export async function batchUpdateRefinedTags(
  db: SupabaseClient,
  updates: Array<{ id: string; refined_tags: string[] }>,
): Promise<void> {
  if (updates.length === 0) return;

  const { error } = await db.rpc('batch_update_refined_tags', {
    updates: updates.map(u => ({
      id: u.id,
      refined_tags: u.refined_tags,
    })),
  });

  if (error) {
    throw new Error(`Failed to batch update refined_tags: ${error.message}`);
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

// ── Chunk generation DB functions ─────────────────────────────────────────────

// Fetch all active notes with body length > minLength for chunk generation.
// Also fetches title and tags (needed for embedding prefix).
export async function fetchNotesForChunking(
  db: SupabaseClient,
  minLength: number,
): Promise<NoteForChunking[]> {
  const { data, error } = await db
    .from('notes')
    .select('id, title, body, tags, updated_at')
    .is('archived_at', null)
    .not('body', 'is', null);

  if (error) {
    throw new Error(`Failed to fetch notes for chunking: ${error.message}`);
  }

  // Filter by body length in JS — PostgREST doesn't support length filters
  return ((data as Array<{
    id: string;
    title: string;
    body: string;
    tags: string[] | null;
    updated_at: string;
  }>) ?? [])
    .filter(row => row.body.length > minLength)
    .map(row => ({
      id: row.id,
      title: row.title,
      body: row.body,
      tags: row.tags ?? [],
      updated_at: row.updated_at,
    }));
}

// Fetch existing chunking enrichment_log entries with body hashes.
// Returns a map of note_id → body_hash for idempotency checks.
export async function fetchChunkingHashes(
  db: SupabaseClient,
): Promise<Map<string, string>> {
  const { data, error } = await db
    .from('enrichment_log')
    .select('note_id, metadata')
    .eq('enrichment_type', 'chunking');

  if (error) {
    throw new Error(`Failed to fetch chunking hashes: ${error.message}`);
  }

  const result = new Map<string, string>();
  for (const row of (data ?? []) as Array<{ note_id: string; metadata: { body_hash?: string } | null }>) {
    const hash = row.metadata?.body_hash;
    if (hash) result.set(row.note_id, hash);
  }
  return result;
}

// Delete existing chunks for specific notes (before re-chunking).
export async function deleteChunksForNotes(
  db: SupabaseClient,
  noteIds: string[],
): Promise<void> {
  if (noteIds.length === 0) return;

  const { error } = await db
    .from('note_chunks')
    .delete()
    .in('note_id', noteIds);

  if (error) {
    throw new Error(`Failed to delete chunks: ${error.message}`);
  }
}

// Delete existing chunking enrichment_log entries for specific notes.
export async function deleteChunkingLogs(
  db: SupabaseClient,
  noteIds: string[],
): Promise<void> {
  if (noteIds.length === 0) return;

  const { error } = await db
    .from('enrichment_log')
    .delete()
    .eq('enrichment_type', 'chunking')
    .in('note_id', noteIds);

  if (error) {
    throw new Error(`Failed to delete chunking logs: ${error.message}`);
  }
}

// Batch insert chunks with embeddings.
export async function insertChunks(
  db: SupabaseClient,
  chunks: Array<{ note_id: string; chunk_index: number; content: string; embedding: number[] }>,
): Promise<void> {
  if (chunks.length === 0) return;

  const { error } = await db.from('note_chunks').insert(chunks);
  if (error) {
    throw new Error(`Failed to insert chunks: ${error.message}`);
  }
}

// Log chunking enrichment entries with body hashes for idempotency.
export async function logChunkingEnrichments(
  db: SupabaseClient,
  entries: Array<{ note_id: string; body_hash: string; model_used: string }>,
): Promise<void> {
  if (entries.length === 0) return;

  const rows = entries.map(e => ({
    note_id: e.note_id,
    enrichment_type: 'chunking',
    model_used: e.model_used,
    metadata: { body_hash: e.body_hash },
  }));

  const { error } = await db.from('enrichment_log').insert(rows);
  if (error) {
    console.error(JSON.stringify({
      event: 'chunking_enrichment_log_error',
      error: error.message,
      count: entries.length,
    }));
  }
}

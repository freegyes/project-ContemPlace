import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './config';
import type { Entity, NoteForSimilarity, SimilarNote, SimilarityLink } from './types';

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

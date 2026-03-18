import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './config';
import type { NoteForSimilarity, SimilarityLink } from './types';

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

// Fetch all active notes with tags and created_at.
// Embeddings are not fetched — similarity is computed by the find_similar_pairs RPC.
export async function fetchNotesForSimilarity(db: SupabaseClient): Promise<NoteForSimilarity[]> {
  const { data, error } = await db
    .from('notes')
    .select('id, tags, created_at')
    .is('archived_at', null)
    .not('embedding', 'is', null);

  if (error) {
    throw new Error(`Failed to fetch notes for similarity: ${error.message}`);
  }

  const rows = (data as Array<{
    id: string;
    tags: string[] | null;
    created_at: string;
  }> | null) ?? [];

  return rows.map(row => ({
    id: row.id,
    tags: row.tags ?? [],
    created_at: row.created_at,
  }));
}

// Find all note pairs above a similarity threshold in a single round-trip.
// Uses the find_similar_pairs RPC (self-join with a.id < b.id ordering).
// Replaces per-note findSimilarNotes calls — 1 subrequest instead of N.
export async function findSimilarPairs(
  db: SupabaseClient,
  threshold: number,
  maxPairs: number = 10000,
): Promise<Array<{ note_a: string; note_b: string; similarity: number }>> {
  const { data, error } = await db.rpc('find_similar_pairs', {
    similarity_threshold: threshold,
    max_pairs: maxPairs,
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

// Delete all cluster rows. Clean-slate before inserting fresh results.
// The .gte filter is a workaround — Supabase JS requires at least one filter on .delete().
// All rows have created_at >= 1970 (NOT NULL DEFAULT now()), so this matches everything.
export async function deleteAllClusters(db: SupabaseClient): Promise<number> {
  const { data, error } = await db
    .from('clusters')
    .delete()
    .gte('created_at', '1970-01-01')
    .select('id');

  if (error) {
    throw new Error(`Failed to delete clusters: ${error.message}`);
  }

  return (data as Array<{ id: string }> | null)?.length ?? 0;
}

// Insert cluster rows in bulk.
export async function insertClusters(
  db: SupabaseClient,
  clusters: Array<{
    resolution: number;
    label: string;
    note_ids: string[];
    top_tags: string[];
    gravity: number;
    modularity: number | null;
  }>,
): Promise<void> {
  if (clusters.length === 0) return;

  const { error } = await db.from('clusters').insert(clusters);
  if (error) {
    throw new Error(`Failed to insert clusters: ${error.message}`);
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

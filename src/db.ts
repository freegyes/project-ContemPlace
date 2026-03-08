import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './config';
import type { CaptureLink, CaptureResult, MatchedNote } from './types';

export type SupabaseClientType = SupabaseClient;

export function createSupabaseClient(config: Config): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
}

/**
 * Attempt to claim this update_id. Returns true if new, false if duplicate.
 * Throws on unexpected DB errors.
 */
export async function tryClaimUpdate(
  db: SupabaseClient,
  updateId: number,
): Promise<boolean> {
  const { error } = await db
    .from('processed_updates')
    .insert({ update_id: updateId });

  if (!error) return true;

  if (error.code === '23505') {
    return false; // duplicate — already processed
  }

  // Unexpected error — log but allow processing to continue
  console.error(JSON.stringify({
    event: 'dedup_insert_error',
    error: error.message,
    code: error.code,
    update_id: updateId,
  }));
  return true;
}

export async function findRelatedNotes(
  db: SupabaseClient,
  embedding: number[],
  threshold: number,
): Promise<MatchedNote[]> {
  const { data, error } = await db.rpc('match_notes', {
    query_embedding: embedding,
    match_threshold: threshold,
    match_count: 5,
    filter_type: null,
    filter_source: null,
    filter_tags: null,
  });

  if (error) {
    console.error(JSON.stringify({
      event: 'match_notes_error',
      error: error.message,
    }));
    return [];
  }

  return (data as MatchedNote[]) ?? [];
}

export async function insertNote(
  db: SupabaseClient,
  capture: CaptureResult,
  embedding: number[],
  rawInput: string,
): Promise<string> {
  const { data, error } = await db
    .from('notes')
    .insert({
      title: capture.title,
      body: capture.body,
      raw_input: rawInput,
      type: capture.type,
      tags: capture.tags,
      source_ref: capture.source_ref,
      source: 'telegram',
      embedding,
    })
    .select('id')
    .single();

  if (error || !data) {
    throw new Error(`Note insert failed: ${error?.message ?? 'no data returned'}`);
  }

  return (data as { id: string }).id;
}

export async function insertLinks(
  db: SupabaseClient,
  noteId: string,
  links: CaptureLink[],
): Promise<void> {
  if (links.length === 0) return;

  const rows = links.map(l => ({
    from_id: noteId,
    to_id: l.to_id,
    link_type: l.link_type,
  }));

  const { error } = await db.from('links').insert(rows);
  if (error) {
    console.error(JSON.stringify({
      event: 'links_insert_error',
      error: error.message,
      noteId,
      links: rows,
    }));
  }
}

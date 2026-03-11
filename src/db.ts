import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './config';
import type { CaptureLink, CaptureResult, MatchedNote } from './types';

export type SupabaseClientType = SupabaseClient;

export function createSupabaseClient(config: Config): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
}

// ── Capture voice ────────────────────────────────────────────────────────────
// Fetches the stylistic prompt section from capture_profiles.
// Any capture interface (Telegram, MCP, CLI) calls this to get the same
// title/body rules, ensuring uniform note style regardless of entry point.
const DEFAULT_CAPTURE_VOICE = `## Your capture style

**Title**: A claim or insight when one is present. If the input doesn't contain a claim, use a descriptive phrase.

**Body**: Use the user's own words. Every sentence must be traceable to the input. 1–3 sentences for short inputs. For longer inputs, use as many sentences as needed to preserve all actionable content — up to 8. Shorter is still better than padded.`;

export async function getCaptureVoice(
  db: SupabaseClient,
  profileName = 'default',
): Promise<string> {
  const { data, error } = await db
    .from('capture_profiles')
    .select('capture_voice')
    .eq('name', profileName)
    .single();

  if (error || !data) {
    console.warn(JSON.stringify({
      event: 'capture_voice_fallback',
      error: error?.message ?? 'no profile found',
      profileName,
    }));
    return DEFAULT_CAPTURE_VOICE;
  }

  return (data as { capture_voice: string }).capture_voice;
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
    filter_intent: null,
    search_text: null,
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
      corrections: capture.corrections,
      intent: capture.intent,
      modality: capture.modality,
      entities: capture.entities,
      embedding,
      embedded_at: new Date().toISOString(),
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
    created_by: 'capture',
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

// Batched insert — one round-trip instead of two [Review fix 11-§8]
export async function logEnrichments(
  db: SupabaseClient,
  noteId: string,
  entries: Array<{ enrichment_type: string; model_used: string | null }>,
): Promise<void> {
  const rows = entries.map(e => ({
    note_id: noteId,
    enrichment_type: e.enrichment_type,
    model_used: e.model_used,
  }));

  const { error } = await db.from('enrichment_log').insert(rows);
  if (error) {
    console.error(JSON.stringify({
      event: 'enrichment_log_error',
      error: error.message,
      noteId,
    }));
  }
}

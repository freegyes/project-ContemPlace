import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './config';
import type { CaptureLink, CaptureResult, MatchedNote, NoteRow, LinkWithTitle, ClusterRow, ClusterNote } from './types';

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

export async function findRelatedNotes(
  db: SupabaseClient,
  embedding: number[],
  threshold: number,
): Promise<MatchedNote[]> {
  const { data, error } = await db.rpc('match_notes', {
    query_embedding: embedding,
    match_threshold: threshold,
    match_count: 5,
    filter_source: null,
    filter_tags: null,
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
  source: string,
): Promise<string> {
  const { data, error } = await db
    .from('notes')
    .insert({
      title: capture.title,
      body: capture.body,
      raw_input: rawInput,
      tags: capture.tags,
      source_ref: capture.source_ref,
      source,
      corrections: capture.corrections,
      entities: [],
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

// ── Read functions ────────────────────────────────────────────────────────────

// Fetch a single note by UUID. Returns null if not found.
export async function fetchNote(
  db: SupabaseClient,
  id: string,
): Promise<NoteRow | null> {
  const { data, error } = await db
    .from('notes')
    .select('id, title, body, raw_input, tags, entities, corrections, source, source_ref, created_at')
    .eq('id', id)
    .is('archived_at', null)
    .single();

  if (error || !data) return null;
  return data as NoteRow;
}

// Fetch all links for a note in both directions, with linked note titles.
export async function fetchNoteLinks(
  db: SupabaseClient,
  id: string,
): Promise<LinkWithTitle[]> {
  const { data: linkRows, error } = await db
    .from('links')
    .select('from_id, to_id, link_type, context, confidence, created_by')
    .or(`from_id.eq.${id},to_id.eq.${id}`);

  if (error || !linkRows || linkRows.length === 0) return [];

  // Collect all linked note IDs (the OTHER note in each link)
  const linkedIds = linkRows.map((l: { from_id: string; to_id: string }) =>
    l.from_id === id ? l.to_id : l.from_id,
  );

  const { data: noteRows } = await db
    .from('notes')
    .select('id, title')
    .in('id', linkedIds)
    .is('archived_at', null);

  const titleMap = new Map<string, string>();
  if (noteRows) {
    for (const n of noteRows as Array<{ id: string; title: string }>) {
      titleMap.set(n.id, n.title);
    }
  }

  return linkRows
    .map((l: {
      from_id: string;
      to_id: string;
      link_type: string;
      context: string | null;
      confidence: number | null;
      created_by: string;
    }) => {
      const isOutbound = l.from_id === id;
      const otherId = isOutbound ? l.to_id : l.from_id;
      // Skip links to archived notes (not in titleMap after filtered query)
      if (!titleMap.has(otherId)) return null;
      return {
        to_id: otherId,
        to_title: titleMap.get(otherId) ?? '',
        link_type: l.link_type,
        context: l.context,
        confidence: l.confidence,
        created_by: l.created_by,
        direction: isOutbound ? 'outbound' : 'inbound',
      } as LinkWithTitle;
    })
    .filter((l): l is LinkWithTitle => l !== null)
    // Capture-time links first (LLM-reasoned), then gardener by confidence descending
    .sort((a, b) => {
      if (a.created_by !== b.created_by) {
        return a.created_by === 'gardener' ? 1 : -1;
      }
      return (b.confidence ?? 0) - (a.confidence ?? 0);
    });
}

// List recent notes, newest first.
export async function listRecentNotes(
  db: SupabaseClient,
  limit: number,
): Promise<NoteRow[]> {
  const { data, error } = await db
    .from('notes')
    .select('id, title, body, tags, source, source_ref, created_at')
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error(JSON.stringify({ event: 'list_recent_error', error: error.message }));
    return [];
  }

  return (data as NoteRow[]) ?? [];
}

// Semantic search via match_notes RPC.
export async function searchNotes(
  db: SupabaseClient,
  embedding: number[],
  threshold: number,
  limit: number,
  filterTags?: string[],
): Promise<MatchedNote[]> {
  const { data, error } = await db.rpc('match_notes', {
    query_embedding: embedding,
    match_threshold: threshold,
    match_count: limit,
    filter_source: null,
    filter_tags: filterTags ?? null,
    search_text: null,
  });

  if (error) {
    console.error(JSON.stringify({ event: 'search_notes_rpc_error', error: error.message }));
    throw new Error(`match_notes RPC failed: ${error.message}`);
  }

  return (data as MatchedNote[]) ?? [];
}

// ── Cluster functions ─────────────────────────────────────────────────────

export interface ClusterWithNotes {
  label: string;
  top_tags: string[];
  note_count: number;
  gravity: number;
  notes: ClusterNote[];
}

// Fetch clusters at a given resolution, with note titles resolved.
// Archived notes are silently filtered out at read time.
export async function fetchClusters(
  db: SupabaseClient,
  resolution: number,
): Promise<{ clusters: ClusterWithNotes[]; computed_at: string | null }> {
  const { data: clusterRows, error } = await db
    .from('clusters')
    .select('label, top_tags, note_ids, gravity, modularity, created_at')
    .eq('resolution', resolution)
    .order('gravity', { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch clusters: ${error.message}`);
  }

  const rows = (clusterRows as ClusterRow[] | null) ?? [];
  if (rows.length === 0) {
    return { clusters: [], computed_at: null };
  }

  // Collect all note IDs across all clusters
  const allNoteIds = [...new Set(rows.flatMap(r => r.note_ids))];

  // Batch-fetch titles (respecting archived_at IS NULL)
  const { data: noteRows } = await db
    .from('notes')
    .select('id, title')
    .in('id', allNoteIds)
    .is('archived_at', null);

  const titleMap = new Map<string, string>();
  if (noteRows) {
    for (const n of noteRows as Array<{ id: string; title: string }>) {
      titleMap.set(n.id, n.title);
    }
  }

  // Map titles back to clusters, filter out archived notes
  const clusters: ClusterWithNotes[] = rows.map(row => {
    const activeNotes: ClusterNote[] = row.note_ids
      .filter(id => titleMap.has(id))
      .map(id => ({ id, title: titleMap.get(id)! }));

    return {
      label: row.label,
      top_tags: row.top_tags,
      note_count: activeNotes.length,
      gravity: row.gravity,
      notes: activeNotes,
    };
  });

  return { clusters, computed_at: rows[0]!.created_at };
}

// ── Undo functions ────────────────────────────────────────────────────────

export interface MostRecentNote {
  id: string;
  title: string;
  created_at: string;
}

// Fetch the most recent active note from a specific source.
export async function fetchMostRecentBySource(
  db: SupabaseClient,
  source: string,
): Promise<MostRecentNote | null> {
  const { data, error } = await db
    .from('notes')
    .select('id, title, created_at')
    .eq('source', source)
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  if (error || !data) return null;
  return data as MostRecentNote;
}

// ── Archive functions ──────────────────────────────────────────────────────

export interface NoteForArchive {
  id: string;
  created_at: string;
  archived_at: string | null;
}

// Fetch a note without archived_at filter — needed by remove_note to distinguish
// "not found" from "already archived".
export async function fetchNoteForArchive(
  db: SupabaseClient,
  id: string,
): Promise<NoteForArchive | null> {
  const { data, error } = await db
    .from('notes')
    .select('id, created_at, archived_at')
    .eq('id', id)
    .single();

  if (error || !data) return null;
  return data as NoteForArchive;
}

// Soft delete — set archived_at to now().
export async function archiveNote(
  db: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await db
    .from('notes')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', id);

  if (error) {
    throw new Error(`Archive failed: ${error.message}`);
  }
}

// Hard delete — CASCADE cleans links + enrichment_log.
export async function hardDeleteNote(
  db: SupabaseClient,
  id: string,
): Promise<void> {
  const { error } = await db
    .from('notes')
    .delete()
    .eq('id', id);

  if (error) {
    throw new Error(`Delete failed: ${error.message}`);
  }
}

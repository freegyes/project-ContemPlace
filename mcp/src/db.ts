import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Config } from './config';
import type { CaptureLink, CaptureResult, MatchedNote, NoteRow, LinkWithTitle } from './types';

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

// ── Curation functions ───────────────────────────────────────────────────────

export interface UnmatchedTagRow {
  tag: string;
  count: number;
  first_seen: string;
  last_seen: string;
}

// List unmatched tags from enrichment_log, grouped by tag string.
// Uses COUNT(DISTINCT note_id) for frequency — resilient to duplicate logging across runs.
// Requires the metadata jsonb column added in migration 20260310000000.
export async function listUnmatchedTags(
  db: SupabaseClient,
  minCount: number,
): Promise<UnmatchedTagRow[]> {
  // Supabase JS client doesn't support GROUP BY natively, so use a raw RPC or
  // filter client-side. Since the enrichment_log is modest in size (hundreds of rows),
  // fetch all unmatched_tag rows and aggregate in JS.
  const { data, error } = await db
    .from('enrichment_log')
    .select('note_id, metadata, completed_at')
    .eq('enrichment_type', 'unmatched_tag');

  if (error) {
    throw new Error(`Failed to list unmatched tags: ${error.message}`);
  }

  const rows = (data as Array<{
    note_id: string;
    metadata: { tag?: string } | null;
    completed_at: string;
  }>) ?? [];

  // Aggregate by tag string
  const tagMap = new Map<string, { noteIds: Set<string>; firstSeen: string; lastSeen: string }>();
  for (const row of rows) {
    const tag = row.metadata?.tag;
    if (!tag) continue;

    const existing = tagMap.get(tag);
    if (existing) {
      existing.noteIds.add(row.note_id);
      if (row.completed_at < existing.firstSeen) existing.firstSeen = row.completed_at;
      if (row.completed_at > existing.lastSeen) existing.lastSeen = row.completed_at;
    } else {
      tagMap.set(tag, {
        noteIds: new Set([row.note_id]),
        firstSeen: row.completed_at,
        lastSeen: row.completed_at,
      });
    }
  }

  // Filter by min_count, sort by count desc, cap at 50
  const results: UnmatchedTagRow[] = [];
  for (const [tag, info] of tagMap) {
    if (info.noteIds.size >= minCount) {
      results.push({
        tag,
        count: info.noteIds.size,
        first_seen: info.firstSeen,
        last_seen: info.lastSeen,
      });
    }
  }

  results.sort((a, b) => b.count - a.count);
  return results.slice(0, 50);
}

export interface ConceptRow {
  id: string;
  scheme: string;
  pref_label: string;
}

// Insert a new concept into the concepts table. Returns the inserted row.
// Throws on duplicate (23505 unique violation on scheme + pref_label).
export async function insertConcept(
  db: SupabaseClient,
  scheme: string,
  prefLabel: string,
  altLabels: string[],
  definition: string | null,
): Promise<ConceptRow> {
  const { data, error } = await db
    .from('concepts')
    .insert({
      scheme,
      pref_label: prefLabel,
      alt_labels: altLabels,
      definition,
    })
    .select('id, scheme, pref_label')
    .single();

  if (error) {
    if (error.code === '23505') {
      throw new Error(`DUPLICATE: Concept '${prefLabel}' already exists in scheme '${scheme}'`);
    }
    throw new Error(`Failed to insert concept: ${error.message}`);
  }

  return data as ConceptRow;
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
    .in('id', linkedIds);

  const titleMap = new Map<string, string>();
  if (noteRows) {
    for (const n of noteRows as Array<{ id: string; title: string }>) {
      titleMap.set(n.id, n.title);
    }
  }

  return linkRows.map((l: {
    from_id: string;
    to_id: string;
    link_type: string;
    context: string | null;
    confidence: number | null;
    created_by: string;
  }) => {
    const isOutbound = l.from_id === id;
    const otherId = isOutbound ? l.to_id : l.from_id;
    return {
      to_id: otherId,
      to_title: titleMap.get(otherId) ?? '',
      link_type: l.link_type,
      context: l.context,
      confidence: l.confidence,
      created_by: l.created_by,
      direction: isOutbound ? 'outbound' : 'inbound',
    } as LinkWithTitle;
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

// ── Chunk search ─────────────────────────────────────────────────────────────

export interface ChunkResult {
  chunk_id: string;
  note_id: string;
  chunk_index: number;
  content: string;
  note_title: string;
  note_tags: string[];
  similarity: number;
}

// Semantic search via match_chunks RPC.
export async function searchChunks(
  db: SupabaseClient,
  embedding: number[],
  threshold: number,
  limit: number,
): Promise<ChunkResult[]> {
  const { data, error } = await db.rpc('match_chunks', {
    query_embedding: embedding,
    match_threshold: threshold,
    match_count: limit,
  });

  if (error) {
    console.error(JSON.stringify({ event: 'search_chunks_rpc_error', error: error.message }));
    throw new Error(`match_chunks RPC failed: ${error.message}`);
  }

  return (data as ChunkResult[]) ?? [];
}

import type { SupabaseClient } from '@supabase/supabase-js';
import type OpenAI from 'openai';
import type { Config } from './config';
import { embedText } from './embed';
import { fetchNote, fetchNoteLinks, listRecentNotes, searchNotes, searchChunks,
         listUnmatchedTags, insertConcept } from './db';
import { runCapturePipeline } from './pipeline';

// ── Validation helpers ────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_SCHEMES = ['domains', 'tools', 'people', 'places'] as const;
const SOURCE_RE = /^[a-zA-Z0-9_-]+$/;
const PREF_LABEL_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/;

function toolSuccess(result: unknown): object {
  return { content: [{ type: 'text', text: JSON.stringify(result) }], isError: false };
}
function toolError(message: string): object {
  return { content: [{ type: 'text', text: message }], isError: true };
}
function clamp(val: number | undefined, min: number, max: number, def: number): number {
  if (val === undefined || isNaN(val)) return def;
  return Math.min(Math.max(val, min), max);
}

// ── Tool definitions (returned by tools/list) ────────────────────────────────
export const TOOL_DEFINITIONS = [
  {
    name: 'search_notes',
    description: 'Search notes by meaning. Returns ranked results with body text included — no need to call get_note just to read content. Scores: above 0.50 is a strong match, 0.35–0.50 is moderate. For finding specific passages within long notes, use search_chunks instead.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query, max 1000 characters' },
        limit: { type: 'number', description: 'Number of results to return (default 5, max 20)' },
        threshold: { type: 'number', description: 'Minimum similarity score (default 0.35, range 0.0–1.0)' },
        filter_tags: { type: 'array', items: { type: 'string' }, description: 'Notes must contain all listed tags' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_note',
    description: 'Fetch a single note by UUID with full metadata, body, raw_input, and links. The body is the capture agent\'s structured interpretation; raw_input is the user\'s exact words and the source of truth — prefer raw_input when quoting what the user said. The corrections field lists voice-dictation fixes applied (e.g., "cattle stitch → kettle stitch").',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'UUID of the note' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_recent',
    description: 'List the most recently created notes, newest first. Returns summary fields including body text. Use get_note for the full record including raw_input and links.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of notes to return (default 10, max 50)' },
      },
      required: [],
    },
  },
  {
    name: 'get_related',
    description: 'Get all notes linked to a given note, in both directions. Link types: extends (builds on), contradicts (challenges), supports (reinforces or parallel effort), is-example-of (concrete instance), duplicate-of (same content as existing note), is-similar-to (auto-detected by gardener). The direction field shows whether the queried note is source (outbound) or target (inbound). created_by distinguishes capture-time links from gardener-detected ones.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'UUID of the source note' },
        limit: { type: 'number', description: 'Total links to return (default 10, max 50)' },
      },
      required: ['id'],
    },
  },
  {
    name: 'capture_note',
    description: 'Capture a thought as a permanent note. Required parameter: raw_input (the user\'s verbatim words). The server embeds, finds related notes, and automatically generates a structured note (title, body, tags, entities, links). Do not pre-structure, summarize, or clean up the input. Voice dictation errors are expected and corrected server-side. Side effect: creates a persistent note.',
    inputSchema: {
      type: 'object',
      properties: {
        raw_input: { type: 'string', description: 'The user\'s exact words — do not rephrase, summarize, clean up, or add wrapper context. Pass through verbatim as spoken or typed. The server handles all structuring and voice-dictation correction. Max 4000 characters.' },
        source: { type: 'string', description: 'Identifies where this note came from. Default "mcp" is fine. Use a specific label when known — e.g., "claude-code", "obsidian-import". Alphanumeric/hyphens/underscores, max 100 chars.' },
      },
      required: ['raw_input'],
    },
  },
  {
    name: 'list_unmatched_tags',
    description: 'List tags that don\'t match any concept in the controlled vocabulary, ordered by frequency. Part of the curation workflow: list unmatched tags → review with the user → promote worthy ones via promote_concept (which enables synonym collapse on the next gardener run). Surface these opportunistically during knowledge browsing — do not auto-promote without user input.',
    inputSchema: {
      type: 'object',
      properties: {
        min_count: { type: 'number', description: 'Only show tags that appear on at least this many notes (default 1, max 100)' },
      },
      required: [],
    },
  },
  {
    name: 'promote_concept',
    description: 'Add a new concept to the controlled vocabulary. On the next gardener run, notes tagged with the pref_label or any alt_label get their refined_tags normalized to the canonical label. Always confirm with the user before promoting. Include alt_labels for all known synonyms — this is what enables normalization.',
    inputSchema: {
      type: 'object',
      properties: {
        pref_label: { type: 'string', description: 'Canonical label in kebab-case (e.g. "laser-cutting"), max 100 chars' },
        scheme: { type: 'string', enum: ['domains', 'tools', 'people', 'places'], description: 'Vocabulary scheme: domains (topic areas like "woodworking"), tools (software/hardware like "obsidian"), people (named individuals), places (locations)' },
        alt_labels: { type: 'array', items: { type: 'string' }, description: 'Synonym labels for tag normalization — include all known variants (max 20, each max 100 chars)' },
        definition: { type: 'string', description: 'Short definition (max 500 chars). Improves semantic matching accuracy for fuzzy tag resolution.' },
      },
      required: ['pref_label', 'scheme'],
    },
  },
  {
    name: 'search_chunks',
    description: 'Search within note paragraphs by semantic similarity. Only notes with body > 1500 characters are chunked — most short notes only appear in search_notes. Use this when looking for specific information buried in a longer note (e.g., imports, detailed write-ups). Results include parent note metadata (tags).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query, max 1000 characters' },
        limit: { type: 'number', description: 'Number of results to return (default 10, max 50)' },
        threshold: { type: 'number', description: 'Minimum similarity score (default 0.35, range 0.0–1.0)' },
      },
      required: ['query'],
    },
  },
];

// ── Tool handlers ─────────────────────────────────────────────────────────────

export async function handleSearchNotes(
  args: Record<string, unknown>,
  db: SupabaseClient,
  openai: OpenAI,
  config: Config,
): Promise<object> {
  const query = args['query'];
  if (typeof query !== 'string' || query.length === 0) return toolError('query is required');
  if (query.length > 1000) return toolError('query exceeds 1000 character limit');

  const limit = clamp(args['limit'] as number | undefined, 1, 20, 5);
  const threshold = clamp(args['threshold'] as number | undefined, 0, 1, config.searchThreshold);
  const filterTags = Array.isArray(args['filter_tags']) ? args['filter_tags'] as string[] : undefined;

  try {
    const embedding = await embedText(openai, config, query);
    const results = await searchNotes(db, embedding, threshold, limit, filterTags);
    return toolSuccess({
      results: results.map(n => ({
        id: n.id,
        title: n.title,
        body: n.body,
        tags: n.tags,
        score: n.similarity,
        created_at: n.created_at,
      })),
      count: results.length,
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'search_notes_error', error: String(err) }));
    return toolError('Search failed. Try again.');
  }
}

export async function handleGetNote(
  args: Record<string, unknown>,
  db: SupabaseClient,
): Promise<object> {
  const id = args['id'];
  if (typeof id !== 'string') return toolError('id is required');
  if (!UUID_RE.test(id)) return toolError(`Invalid UUID format: "${id}"`);

  try {
    const [note, links] = await Promise.all([fetchNote(db, id), fetchNoteLinks(db, id)]);
    if (!note) return toolError(`Note not found: ${id}`);
    return toolSuccess({ ...note, links });
  } catch (err) {
    console.error(JSON.stringify({ event: 'get_note_error', error: String(err), id }));
    return toolError('Database error. Try again.');
  }
}

export async function handleListRecent(
  args: Record<string, unknown>,
  db: SupabaseClient,
): Promise<object> {
  const limit = clamp(args['limit'] as number | undefined, 1, 50, 10);

  try {
    const notes = await listRecentNotes(db, limit);
    return toolSuccess({ notes, count: notes.length });
  } catch (err) {
    console.error(JSON.stringify({ event: 'list_recent_error', error: String(err) }));
    return toolError('Database error. Try again.');
  }
}

export async function handleGetRelated(
  args: Record<string, unknown>,
  db: SupabaseClient,
): Promise<object> {
  const id = args['id'];
  if (typeof id !== 'string') return toolError('id is required');
  if (!UUID_RE.test(id)) return toolError(`Invalid UUID format: "${id}"`);
  const limit = clamp(args['limit'] as number | undefined, 1, 50, 10);

  try {
    const note = await fetchNote(db, id);
    if (!note) return toolError(`Note not found: ${id}`);
    const links = await fetchNoteLinks(db, id);
    return toolSuccess({ source_id: id, links: links.slice(0, limit), count: Math.min(links.length, limit) });
  } catch (err) {
    console.error(JSON.stringify({ event: 'get_related_error', error: String(err), id }));
    return toolError('Database error. Try again.');
  }
}

// Normalize a label to kebab-case: lowercase, trim, spaces→hyphens, strip invalid chars.
function normalizeLabel(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

export async function handleListUnmatchedTags(
  args: Record<string, unknown>,
  db: SupabaseClient,
): Promise<object> {
  const minCount = clamp(args['min_count'] as number | undefined, 1, 100, 1);

  try {
    const tags = await listUnmatchedTags(db, minCount);
    return toolSuccess({ tags, count: tags.length });
  } catch (err) {
    console.error(JSON.stringify({ event: 'list_unmatched_tags_error', error: String(err) }));
    return toolError('Database error. Try again.');
  }
}

export async function handlePromoteConcept(
  args: Record<string, unknown>,
  db: SupabaseClient,
): Promise<object> {
  // Validate scheme
  const scheme = args['scheme'];
  if (typeof scheme !== 'string') return toolError('scheme is required');
  if (!(VALID_SCHEMES as readonly string[]).includes(scheme)) {
    return toolError(`Invalid scheme: "${scheme}". Must be one of: ${VALID_SCHEMES.join(', ')}`);
  }

  // Validate and normalize pref_label
  const rawLabel = args['pref_label'];
  if (typeof rawLabel !== 'string' || rawLabel.trim().length === 0) return toolError('pref_label is required');
  if (rawLabel.length > 100) return toolError('pref_label exceeds 100 character limit');
  const prefLabel = normalizeLabel(rawLabel);
  if (!PREF_LABEL_RE.test(prefLabel)) return toolError(`Invalid pref_label after normalization: "${prefLabel}"`);

  // Validate alt_labels
  let altLabels: string[] = [];
  if (Array.isArray(args['alt_labels'])) {
    if (args['alt_labels'].length > 20) return toolError('alt_labels exceeds 20 element limit');
    for (const label of args['alt_labels']) {
      if (typeof label !== 'string') return toolError('Each alt_label must be a string');
      if (label.length > 100) return toolError(`alt_label "${label}" exceeds 100 character limit`);
    }
    altLabels = [...new Set(
      (args['alt_labels'] as string[]).map(l => l.toLowerCase().trim()).filter(l => l.length > 0),
    )];
  }

  // Validate definition
  let definition: string | null = null;
  if (typeof args['definition'] === 'string') {
    if (args['definition'].length > 500) return toolError('definition exceeds 500 character limit');
    definition = args['definition'].trim() || null;
  }

  try {
    const concept = await insertConcept(db, scheme, prefLabel, altLabels, definition);
    return toolSuccess({
      id: concept.id,
      scheme: concept.scheme,
      pref_label: concept.pref_label,
      message: 'Concept created. Embedding and tag matching will be applied on the next gardener run.',
    });
  } catch (err) {
    const msg = String(err);
    if (msg.includes('DUPLICATE')) {
      return toolError(msg.replace('DUPLICATE: ', ''));
    }
    console.error(JSON.stringify({ event: 'promote_concept_error', error: msg }));
    return toolError('Database error. Try again.');
  }
}

export async function handleSearchChunks(
  args: Record<string, unknown>,
  db: SupabaseClient,
  openai: OpenAI,
  config: Config,
): Promise<object> {
  const query = args['query'];
  if (typeof query !== 'string' || query.length === 0) return toolError('query is required');
  if (query.length > 1000) return toolError('query exceeds 1000 character limit');

  const limit = clamp(args['limit'] as number | undefined, 1, 50, 10);
  const threshold = clamp(args['threshold'] as number | undefined, 0, 1, config.searchThreshold);

  try {
    const embedding = await embedText(openai, config, query);
    const results = await searchChunks(db, embedding, threshold, limit);
    return toolSuccess({
      results: results.map(c => ({
        chunk_id: c.chunk_id,
        note_id: c.note_id,
        note_title: c.note_title,
        note_tags: c.note_tags,
        chunk_index: c.chunk_index,
        content: c.content,
        score: c.similarity,
      })),
      count: results.length,
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'search_chunks_error', error: String(err) }));
    return toolError('Chunk search failed. Try again.');
  }
}

export async function handleCaptureNote(
  args: Record<string, unknown>,
  db: SupabaseClient,
  openai: OpenAI,
  config: Config,
): Promise<object> {
  const text = args['raw_input'];
  if (typeof text !== 'string' || text.length === 0) return toolError('raw_input is required');
  if (text.length > 4000) return toolError('raw_input exceeds 4000 character limit');

  let source = typeof args['source'] === 'string' ? args['source'] : 'mcp';
  if (source.length > 100 || !SOURCE_RE.test(source)) {
    console.warn(JSON.stringify({ event: 'source_sanitized', original: source }));
    source = 'mcp';
  }

  try {
    const result = await runCapturePipeline(text, source, db, openai, config);

    return toolSuccess({
      id: result.id,
      title: result.title,
      body: result.body,
      tags: result.tags,
      links_created: result.links.length,
      source: result.source,
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'capture_note_error', error: String(err) }));
    return toolError('Capture failed. Try again.');
  }
}

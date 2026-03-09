import type { SupabaseClient } from '@supabase/supabase-js';
import type OpenAI from 'openai';
import type { Config } from './config';
import { embedText, buildEmbeddingInput } from './embed';
import { runCaptureAgent } from './capture';
import { getCaptureVoice, findRelatedNotes, insertNote, insertLinks, logEnrichments,
         fetchNote, fetchNoteLinks, listRecentNotes, searchNotes } from './db';

// ── Validation helpers ────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_TYPES = ['idea', 'reflection', 'source', 'lookup'] as const;
const VALID_INTENTS = ['reflect', 'plan', 'create', 'remember', 'reference', 'log'] as const;
const SOURCE_RE = /^[a-zA-Z0-9_-]+$/;

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
    description: 'Search your personal notes by semantic similarity to a query. Embeds the query text and matches against stored notes using vector similarity. Use filter_type or filter_intent to narrow results. Returns ranked results with similarity scores — above 0.75 is a strong match, 0.60–0.75 is moderate, below 0.60 may be loosely related.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language search query, max 1000 characters' },
        limit: { type: 'number', description: 'Number of results to return (default 5, max 20)' },
        threshold: { type: 'number', description: 'Minimum similarity score (default 0.60, range 0.0–1.0)' },
        filter_type: { type: 'string', enum: ['idea', 'reflection', 'source', 'lookup'] },
        filter_intent: { type: 'string', enum: ['reflect', 'plan', 'create', 'remember', 'reference', 'log'] },
        filter_tags: { type: 'array', items: { type: 'string' }, description: 'Notes must contain all listed tags' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_note',
    description: 'Fetch a single note by its UUID, including the full body, all metadata, and any links to other notes. Use this after search_notes to get complete content for a specific note. The raw_input field contains the user\'s original unedited words.',
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
    description: 'List the most recently created notes, newest first. Use filter_type or filter_intent to focus on a specific kind of note — for example, filter_intent=plan to see everything the user is currently planning.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of notes to return (default 10, max 50)' },
        filter_type: { type: 'string', enum: ['idea', 'reflection', 'source', 'lookup'] },
        filter_intent: { type: 'string', enum: ['reflect', 'plan', 'create', 'remember', 'reference', 'log'] },
      },
      required: [],
    },
  },
  {
    name: 'get_related',
    description: 'Get all notes linked to a given note, in both directions. Returns the linked notes along with the link type and any context recorded when the link was created. Useful for traversing the note graph.',
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
    description: 'Create a new note by running the full capture pipeline. The text is embedded, matched against related notes for context, and structured by the AI capture agent (title, body, type, intent, tags, entities, links). The result is permanently stored. Use the source parameter to record where this note came from — for example, "obsidian", "notion", or "manual". This tool has a side effect: it creates a real, persistent note.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Raw text to capture, max 4000 characters' },
        source: { type: 'string', description: 'Provenance label (default "mcp"), alphanumeric and hyphens/underscores only, max 100 chars' },
      },
      required: ['text'],
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
  const threshold = clamp(args['threshold'] as number | undefined, 0, 1, config.matchThreshold);

  const filterType = args['filter_type'] as string | undefined;
  if (filterType && !(VALID_TYPES as readonly string[]).includes(filterType)) {
    return toolError(`Invalid filter_type: "${filterType}"`);
  }
  const filterIntent = args['filter_intent'] as string | undefined;
  if (filterIntent && !(VALID_INTENTS as readonly string[]).includes(filterIntent)) {
    return toolError(`Invalid filter_intent: "${filterIntent}"`);
  }
  const filterTags = Array.isArray(args['filter_tags']) ? args['filter_tags'] as string[] : undefined;

  try {
    const embedding = await embedText(openai, config, query);
    const results = await searchNotes(db, embedding, threshold, limit, filterType, filterIntent, filterTags);
    return toolSuccess({
      results: results.map(n => ({
        id: n.id,
        title: n.title,
        body: n.body,
        type: n.type,
        intent: n.intent,
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
  const filterType = args['filter_type'] as string | undefined;
  if (filterType && !(VALID_TYPES as readonly string[]).includes(filterType)) {
    return toolError(`Invalid filter_type: "${filterType}"`);
  }
  const filterIntent = args['filter_intent'] as string | undefined;
  if (filterIntent && !(VALID_INTENTS as readonly string[]).includes(filterIntent)) {
    return toolError(`Invalid filter_intent: "${filterIntent}"`);
  }

  try {
    const notes = await listRecentNotes(db, limit, filterType, filterIntent);
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

export async function handleCaptureNote(
  args: Record<string, unknown>,
  db: SupabaseClient,
  openai: OpenAI,
  config: Config,
): Promise<object> {
  const text = args['text'];
  if (typeof text !== 'string' || text.length === 0) return toolError('text is required');
  if (text.length > 4000) return toolError('text exceeds 4000 character limit');

  let source = typeof args['source'] === 'string' ? args['source'] : 'mcp';
  if (source.length > 100 || !SOURCE_RE.test(source)) {
    console.warn(JSON.stringify({ event: 'source_sanitized', original: source }));
    source = 'mcp';
  }

  try {
    // Step 1: embed + fetch capture voice in parallel
    const [rawEmbedding, captureVoice] = await Promise.all([
      embedText(openai, config, text),
      getCaptureVoice(db),
    ]);

    // Step 2: find related notes
    const relatedNotes = await findRelatedNotes(db, rawEmbedding, config.matchThreshold);

    // Step 3: run capture LLM
    const capture = await runCaptureAgent(openai, config, text, relatedNotes, captureVoice);

    // Step 4: augmented embedding (fallback to raw on failure)
    let finalEmbedding = rawEmbedding;
    let embeddingType = 'augmented';
    try {
      finalEmbedding = await embedText(openai, config, buildEmbeddingInput(text, capture));
    } catch (embedErr) {
      console.warn(JSON.stringify({ event: 'augmented_embed_fallback', error: String(embedErr) }));
      embeddingType = 'raw_fallback';
    }

    // Step 5: insert note + links
    const noteId = await insertNote(db, capture, finalEmbedding, text, source);
    await insertLinks(db, noteId, capture.links);

    // Step 6: log enrichments
    await logEnrichments(db, noteId, [
      { enrichment_type: 'capture', model_used: config.captureModel },
      { enrichment_type: embeddingType, model_used: config.embedModel },
    ]);

    return toolSuccess({
      id: noteId,
      title: capture.title,
      body: capture.body,
      type: capture.type,
      intent: capture.intent,
      tags: capture.tags,
      links_created: capture.links.length,
      source,
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'capture_note_error', error: String(err) }));
    return toolError('Capture failed. Try again.');
  }
}

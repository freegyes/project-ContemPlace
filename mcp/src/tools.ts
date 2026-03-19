import type { SupabaseClient } from '@supabase/supabase-js';
import type OpenAI from 'openai';
import type { Config } from './config';
import { embedText } from './embed';
import { fetchNote, fetchNoteLinks, listRecentNotes, searchNotes, fetchNoteForArchive, archiveNote, hardDeleteNote, fetchClusters, fetchAvailableResolutions, fetchLastGardenerRun, triggerGardenerWorker } from './db';
import { runCapturePipeline } from './pipeline';

// ── Validation helpers ────────────────────────────────────────────────────────
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
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
    description: 'Search notes by meaning. Returns ranked results with body text included — no need to call get_note just to read content. Scores: above 0.50 is a strong match, 0.35–0.50 is moderate.',
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
    description: 'Get all notes linked to a given note, in both directions. Link types: contradicts (challenges), related (builds on, supports, parallels), is-similar-to (auto-detected by gardener). The direction field shows whether the queried note is source (outbound) or target (inbound). created_by distinguishes capture-time links from gardener-detected ones.',
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
    description: 'Capture an idea fragment. Required parameter: raw_input (the user\'s verbatim words). The server embeds, finds related notes, and structures the fragment (title, body, tags, links). Do not pre-structure, summarize, or clean up the input. Voice dictation errors are expected and corrected server-side. Side effect: creates a persistent fragment.',
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
    name: 'remove_note',
    description: 'Remove a note from the active knowledge graph. What happens depends on the note\'s age: within the grace window (default 11 minutes), the note is permanently deleted — no recovery possible, because you\'re still in the capture session correcting in real time. Beyond the grace window, the note is soft-archived — hidden from all tools but recoverable via direct DB access. Returns { deleted: true } for permanent deletion or { archived: true, id: "..." } for soft archive. Always confirm with the user before calling.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'UUID of the note to remove' },
      },
      required: ['id'],
    },
  },
  {
    name: 'list_clusters',
    description: 'List thematic clusters detected by the gardener. Clusters group notes by semantic similarity — call with no parameters to see the landscape of accumulated thinking. Results are ordered by gravity (size × recency) — high-gravity clusters are where recent attention is concentrated. Try comparing resolutions (e.g., default 1.0 then 1.5) to see which clusters split, revealing internal conceptual structure. The response includes available_resolutions so you know which values to request. Each cluster includes a sample of note titles (default 5) and hub_notes — the 1–2 notes with the most intra-cluster links, which act as conceptual anchors. Start depth dives with get_related on a hub note.',
    inputSchema: {
      type: 'object',
      properties: {
        resolution: {
          type: 'number',
          description: 'Cluster resolution (default 1.0). Lower = fewer larger clusters. Check available_resolutions in the response for valid values.',
        },
        notes_per_cluster: {
          type: 'number',
          description: 'Max note titles to include per cluster (default 5, max 50, 0 = none). Full count is always in note_count.',
        },
      },
      required: [],
    },
  },
  {
    name: 'trigger_gardening',
    description: 'Trigger the gardening pipeline on demand — recomputes similarity links, clusters, and extracts entities from new notes. Takes ~30 seconds at current corpus size. Use after a burst of captures to see updated links and clusters immediately instead of waiting for the nightly cron. Has a 5-minute cooldown between triggers to prevent accidental spam. Returns the full run summary with counts of links created, clusters computed, and entities extracted.',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
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

export async function handleRemoveNote(
  args: Record<string, unknown>,
  db: SupabaseClient,
  config: Config,
): Promise<object> {
  const id = args['id'];
  if (typeof id !== 'string') return toolError('id is required');
  if (!UUID_RE.test(id)) return toolError(`Invalid UUID format: "${id}"`);

  try {
    const note = await fetchNoteForArchive(db, id);
    if (!note) return toolError(`Note not found: ${id}`);
    if (note.archived_at !== null) return toolSuccess({ archived: true, id });

    const ageMs = Date.now() - new Date(note.created_at).getTime();
    const windowMs = config.hardDeleteWindowMinutes * 60 * 1000;

    if (ageMs < windowMs) {
      await hardDeleteNote(db, id);
      console.log(JSON.stringify({ event: 'note_hard_deleted', id }));
      return toolSuccess({ deleted: true });
    } else {
      await archiveNote(db, id);
      console.log(JSON.stringify({ event: 'note_archived', id }));
      return toolSuccess({ archived: true, id });
    }
  } catch (err) {
    console.error(JSON.stringify({ event: 'remove_note_error', error: String(err), id }));
    return toolError('Archive operation failed. Try again.');
  }
}

export async function handleTriggerGardening(
  args: Record<string, unknown>,
  db: SupabaseClient,
  config: Config,
): Promise<object> {
  if (!config.gardenerUrl || !config.gardenerApiKey) {
    return toolError('Gardener triggering not configured. Set GARDENER_WORKER_URL and GARDENER_API_KEY.');
  }

  try {
    const lastRun = await fetchLastGardenerRun(db);

    if (lastRun) {
      const elapsedMs = Date.now() - new Date(lastRun).getTime();
      const cooldownMs = config.gardeningCooldownMinutes * 60 * 1000;
      if (elapsedMs < cooldownMs) {
        const remainingMinutes = Math.ceil((cooldownMs - elapsedMs) / 60000);
        return toolError(`Gardening cooldown active. Try again in ~${remainingMinutes} minute(s).`);
      }
    }

    const result = await triggerGardenerWorker(config.gardenerUrl, config.gardenerApiKey);
    return toolSuccess(result);
  } catch (err) {
    const errorMsg = String(err);
    console.error(JSON.stringify({ event: 'trigger_gardening_error', error: errorMsg }));
    return toolError(`Gardening failed: ${errorMsg}`);
  }
}

export async function handleListClusters(
  args: Record<string, unknown>,
  db: SupabaseClient,
): Promise<object> {
  const resolution = typeof args['resolution'] === 'number' ? args['resolution'] : 1.0;
  const notesPerCluster = clamp(args['notes_per_cluster'] as number | undefined, 0, 50, 5);

  try {
    const [{ clusters, computed_at }, availableResolutions] = await Promise.all([
      fetchClusters(db, resolution),
      fetchAvailableResolutions(db),
    ]);

    const clusteredNotes = clusters.reduce((sum, c) => sum + c.note_count, 0);

    return toolSuccess({
      clusters: clusters.map(c => ({
        label: c.label,
        top_tags: c.top_tags,
        note_count: c.note_count,
        gravity: c.gravity,
        notes: c.notes.slice(0, notesPerCluster),
        hub_notes: c.hub_notes,
      })),
      resolution,
      available_resolutions: availableResolutions,
      cluster_count: clusters.length,
      clustered_notes: clusteredNotes,
      computed_at,
    });
  } catch (err) {
    console.error(JSON.stringify({ event: 'list_clusters_error', error: String(err) }));
    return toolError('Failed to fetch clusters. Try again.');
  }
}

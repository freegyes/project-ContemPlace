import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type OpenAI from 'openai';
import type { Config } from '../mcp/src/config';
import type { CaptureResult } from '../mcp/src/types';

// ── Module mocks ──────────────────────────────────────────────────────────────
// All DB and AI calls are intercepted at the module level. The db and openai
// objects passed to handlers are forwarded to these functions — mocking the
// functions means tests never touch a network.

vi.mock('../mcp/src/db', () => ({
  searchNotes: vi.fn().mockResolvedValue([]),
  fetchNote: vi.fn().mockResolvedValue(null),
  fetchNoteLinks: vi.fn().mockResolvedValue([]),
  listRecentNotes: vi.fn().mockResolvedValue([]),
  getCaptureVoice: vi.fn().mockResolvedValue('## Capture style'),
  findRelatedNotes: vi.fn().mockResolvedValue([]),
  insertNote: vi.fn().mockResolvedValue('aaaaaaaa-0000-0000-0000-000000000001'),
  insertLinks: vi.fn().mockResolvedValue(undefined),
  logEnrichments: vi.fn().mockResolvedValue(undefined),
  fetchNoteForArchive: vi.fn().mockResolvedValue(null),
  archiveNote: vi.fn().mockResolvedValue(undefined),
  hardDeleteNote: vi.fn().mockResolvedValue(undefined),
  fetchClusters: vi.fn().mockResolvedValue({ clusters: [], computed_at: null }),
  fetchAvailableResolutions: vi.fn().mockResolvedValue([1.0, 1.5, 2.0]),
  fetchRecentFragments: vi.fn().mockResolvedValue([]),
  fetchLastGardenerRun: vi.fn().mockResolvedValue(null),
  triggerGardenerWorker: vi.fn().mockResolvedValue({
    event: 'gardener_run_complete',
    similarity: { notes_processed: 10, links_deleted: 5, links_created: 3, enriched_notes: 4, errors: [] },
    clustering: { clusters_created: 3, resolutions_run: 3, clusters_deleted: 2, error: null },
    entities: { notes_extracted: 2, dictionary_entries: 5, notes_updated: 2, error: null },
    duration_ms: 15000,
  }),
}));

vi.mock('../mcp/src/embed', () => ({
  embedText: vi.fn().mockResolvedValue([0.1, 0.2, 0.3]),
  buildEmbeddingInput: vi.fn().mockReturnValue('augmented input text'),
  createOpenAIClient: vi.fn().mockReturnValue({}),
}));

vi.mock('../mcp/src/capture', () => ({
  runCaptureAgent: vi.fn().mockResolvedValue({
    title: 'Mock Note',
    body: 'Mock body.',
    tags: ['mock'],
    source_ref: null,
    corrections: null,
    links: [],
  } satisfies CaptureResult),
  parseCaptureResponse: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import {
  handleSearchNotes,
  handleGetNote,
  handleListRecent,
  handleGetRelated,
  handleCaptureNote,
  handleRemoveNote,
  handleListClusters,
  handleTriggerGardening,
} from '../mcp/src/tools';
import {
  searchNotes,
  fetchNote,
  fetchNoteLinks,
  listRecentNotes,
  getCaptureVoice,
  findRelatedNotes,
  fetchRecentFragments,
  insertNote,
  insertLinks,
  logEnrichments,
  fetchNoteForArchive,
  archiveNote,
  hardDeleteNote,
  fetchClusters,
  fetchAvailableResolutions,
  fetchLastGardenerRun,
  triggerGardenerWorker,
} from '../mcp/src/db';
import { embedText } from '../mcp/src/embed';
import { runCaptureAgent } from '../mcp/src/capture';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const MOCK_CONFIG: Config = {
  mcpApiKey: 'test-key',
  openrouterApiKey: 'or-key',
  supabaseUrl: 'https://example.supabase.co',
  supabaseServiceRoleKey: 'service-key',
  captureModel: 'anthropic/claude-haiku-4-5',
  embedModel: 'openai/text-embedding-3-small',
  matchThreshold: 0.60,
  searchThreshold: 0.35,
  hardDeleteWindowMinutes: 11,
  recentFragmentsCount: 5,
  recentFragmentsWindowMinutes: 60,
  gardenerUrl: 'https://contemplace-gardener.workers.dev',
  gardenerApiKey: 'test-gardener-key',
  gardeningCooldownMinutes: 5,
};

const mockDb = {} as unknown as SupabaseClient;
const mockOpenAI = {} as unknown as OpenAI;

const VALID_UUID = 'aaaaaaaa-0000-0000-0000-000000000001';

const MOCK_NOTE_ROW = {
  id: VALID_UUID,
  title: 'A Note',
  body: 'The body.',
  raw_input: 'the raw input',
  tags: ['tag'],
  entities: [],
  corrections: null,
  source: 'telegram',
  source_ref: null,
  created_at: '2026-03-09T00:00:00.000Z',
};

const MOCK_LINK = {
  to_id: 'bbbbbbbb-0000-0000-0000-000000000002',
  to_title: 'Related Note',
  link_type: 'related',
  context: null,
  confidence: null,
  created_by: 'capture',
  direction: 'outbound' as const,
};

function toolResult(result: object): { isError: boolean; content: Array<{ text: string }> } {
  return result as { isError: boolean; content: Array<{ text: string }> };
}

// ── handleSearchNotes ─────────────────────────────────────────────────────────

describe('handleSearchNotes', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('input validation', () => {
    it('returns error when query is missing', async () => {
      const r = toolResult(await handleSearchNotes({}, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/query is required/);
    });

    it('returns error when query is empty string', async () => {
      const r = toolResult(await handleSearchNotes({ query: '' }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/query is required/);
    });

    it('returns error when query exceeds 1000 characters', async () => {
      const r = toolResult(await handleSearchNotes({ query: 'a'.repeat(1001) }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/1000 character/);
    });

  });

  describe('clamping', () => {
    it('defaults limit to 5 when not provided', async () => {
      await handleSearchNotes({ query: 'test' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(searchNotes)).toHaveBeenCalledWith(mockDb, expect.any(Array), expect.any(Number), 5, undefined);
    });

    it('clamps limit above 20 down to 20', async () => {
      await handleSearchNotes({ query: 'test', limit: 99 }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(searchNotes)).toHaveBeenCalledWith(mockDb, expect.any(Array), expect.any(Number), 20, undefined);
    });

    it('clamps limit below 1 up to 1', async () => {
      await handleSearchNotes({ query: 'test', limit: 0 }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(searchNotes)).toHaveBeenCalledWith(mockDb, expect.any(Array), expect.any(Number), 1, undefined);
    });

    it('defaults threshold to config.searchThreshold when not provided', async () => {
      await handleSearchNotes({ query: 'test' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(searchNotes)).toHaveBeenCalledWith(mockDb, expect.any(Array), MOCK_CONFIG.searchThreshold, expect.any(Number), undefined);
    });

    it('clamps threshold above 1 down to 1', async () => {
      await handleSearchNotes({ query: 'test', threshold: 1.5 }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(searchNotes)).toHaveBeenCalledWith(mockDb, expect.any(Array), 1, expect.any(Number), undefined);
    });
  });

  describe('happy path', () => {
    it('embeds the query before calling searchNotes', async () => {
      await handleSearchNotes({ query: 'test query' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(embedText)).toHaveBeenCalledWith(mockOpenAI, MOCK_CONFIG, 'test query');
      expect(vi.mocked(searchNotes)).toHaveBeenCalledOnce();
    });

    it('passes filter_tags as array to searchNotes', async () => {
      await handleSearchNotes({ query: 'test', filter_tags: ['tag1', 'tag2'] }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(searchNotes)).toHaveBeenCalledWith(mockDb, expect.any(Array), expect.any(Number), expect.any(Number), ['tag1', 'tag2']);
    });

    it('returns isError: false on success', async () => {
      const r = toolResult(await handleSearchNotes({ query: 'test' }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(false);
    });

    it('returns count and results array', async () => {
      const r = toolResult(await handleSearchNotes({ query: 'test' }, mockDb, mockOpenAI, MOCK_CONFIG));
      const body = JSON.parse(r.content[0]!.text);
      expect(body.count).toBe(0);
      expect(body.results).toEqual([]);
    });

    it('maps result fields correctly', async () => {
      vi.mocked(searchNotes).mockResolvedValueOnce([{
        id: VALID_UUID,
        title: 'A Note',
        body: 'body',
        raw_input: 'raw',
        tags: ['t'],
        source_ref: null,
        source: 'telegram',
        entities: null,
        created_at: '2026-01-01',
        similarity: 0.82,
      }]);
      const r = toolResult(await handleSearchNotes({ query: 'test' }, mockDb, mockOpenAI, MOCK_CONFIG));
      const body = JSON.parse(r.content[0]!.text);
      expect(body.count).toBe(1);
      expect(body.results[0]).toMatchObject({
        id: VALID_UUID,
        title: 'A Note',
        score: 0.82,
      });
      // raw_input should NOT be in results (it's in get_note only)
      expect(body.results[0].raw_input).toBeUndefined();
    });

    it('returns toolError when embedText throws', async () => {
      vi.mocked(embedText).mockRejectedValueOnce(new Error('API down'));
      const r = toolResult(await handleSearchNotes({ query: 'test' }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
    });

    it('returns toolError when searchNotes throws', async () => {
      vi.mocked(searchNotes).mockRejectedValueOnce(new Error('DB error'));
      const r = toolResult(await handleSearchNotes({ query: 'test' }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
    });
  });
});

// ── handleGetNote ─────────────────────────────────────────────────────────────

describe('handleGetNote', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('input validation', () => {
    it('returns error when id is missing', async () => {
      const r = toolResult(await handleGetNote({}, mockDb));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/id is required/);
    });

    it('returns error when id is not a string', async () => {
      const r = toolResult(await handleGetNote({ id: 123 }, mockDb));
      expect(r.isError).toBe(true);
    });

    it('returns error when id fails UUID format', async () => {
      const r = toolResult(await handleGetNote({ id: 'not-a-uuid' }, mockDb));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/Invalid UUID/);
    });

    it('accepts a valid lowercase UUID', async () => {
      vi.mocked(fetchNote).mockResolvedValueOnce(MOCK_NOTE_ROW);
      vi.mocked(fetchNoteLinks).mockResolvedValueOnce([]);
      const r = toolResult(await handleGetNote({ id: VALID_UUID }, mockDb));
      expect(r.isError).toBe(false);
    });

    it('accepts a valid uppercase UUID', async () => {
      vi.mocked(fetchNote).mockResolvedValueOnce(MOCK_NOTE_ROW);
      vi.mocked(fetchNoteLinks).mockResolvedValueOnce([]);
      const r = toolResult(await handleGetNote({ id: VALID_UUID.toUpperCase() }, mockDb));
      expect(r.isError).toBe(false);
    });
  });

  describe('happy path', () => {
    it('returns note fields merged with links', async () => {
      vi.mocked(fetchNote).mockResolvedValueOnce(MOCK_NOTE_ROW);
      vi.mocked(fetchNoteLinks).mockResolvedValueOnce([MOCK_LINK]);
      const r = toolResult(await handleGetNote({ id: VALID_UUID }, mockDb));
      const body = JSON.parse(r.content[0]!.text);
      expect(body.title).toBe('A Note');
      expect(body.raw_input).toBe('the raw input');
      expect(body.links).toHaveLength(1);
      expect(body.links[0].link_type).toBe('related');
    });

    it('calls fetchNote and fetchNoteLinks with the correct id', async () => {
      vi.mocked(fetchNote).mockResolvedValueOnce(MOCK_NOTE_ROW);
      vi.mocked(fetchNoteLinks).mockResolvedValueOnce([]);
      await handleGetNote({ id: VALID_UUID }, mockDb);
      expect(vi.mocked(fetchNote)).toHaveBeenCalledWith(mockDb, VALID_UUID);
      expect(vi.mocked(fetchNoteLinks)).toHaveBeenCalledWith(mockDb, VALID_UUID);
    });

    it('returns toolError when fetchNote returns null', async () => {
      vi.mocked(fetchNote).mockResolvedValueOnce(null);
      const r = toolResult(await handleGetNote({ id: VALID_UUID }, mockDb));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/not found/i);
    });

    it('returns toolError on DB exception', async () => {
      vi.mocked(fetchNote).mockRejectedValueOnce(new Error('DB error'));
      const r = toolResult(await handleGetNote({ id: VALID_UUID }, mockDb));
      expect(r.isError).toBe(true);
    });
  });
});

// ── handleListRecent ──────────────────────────────────────────────────────────

describe('handleListRecent', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('input validation', () => {
    it('defaults limit to 10 when not provided', async () => {
      await handleListRecent({}, mockDb);
      expect(vi.mocked(listRecentNotes)).toHaveBeenCalledWith(mockDb, 10);
    });

    it('clamps limit above 50 down to 50', async () => {
      await handleListRecent({ limit: 999 }, mockDb);
      expect(vi.mocked(listRecentNotes)).toHaveBeenCalledWith(mockDb, 50);
    });

    it('clamps limit below 1 up to 1', async () => {
      await handleListRecent({ limit: 0 }, mockDb);
      expect(vi.mocked(listRecentNotes)).toHaveBeenCalledWith(mockDb, 1);
    });

  });

  describe('happy path', () => {
    it('returns notes array and count', async () => {
      vi.mocked(listRecentNotes).mockResolvedValueOnce([MOCK_NOTE_ROW]);
      const r = toolResult(await handleListRecent({}, mockDb));
      const body = JSON.parse(r.content[0]!.text);
      expect(body.count).toBe(1);
      expect(body.notes).toHaveLength(1);
    });

    it('returns toolError on DB exception', async () => {
      vi.mocked(listRecentNotes).mockRejectedValueOnce(new Error('DB error'));
      const r = toolResult(await handleListRecent({}, mockDb));
      expect(r.isError).toBe(true);
    });
  });
});

// ── handleGetRelated ──────────────────────────────────────────────────────────

describe('handleGetRelated', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('input validation', () => {
    it('returns error when id is missing', async () => {
      const r = toolResult(await handleGetRelated({}, mockDb));
      expect(r.isError).toBe(true);
    });

    it('returns error when id fails UUID regex', async () => {
      const r = toolResult(await handleGetRelated({ id: 'bad-id' }, mockDb));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/Invalid UUID/);
    });

    it('defaults limit to 10 when not provided', async () => {
      vi.mocked(fetchNote).mockResolvedValueOnce(MOCK_NOTE_ROW);
      vi.mocked(fetchNoteLinks).mockResolvedValueOnce([]);
      const r = toolResult(await handleGetRelated({ id: VALID_UUID }, mockDb));
      // count is min(links.length, limit) = min(0, 10) = 0
      const body = JSON.parse(r.content[0]!.text);
      expect(body.count).toBe(0);
    });

    it('clamps limit above 50 down to 50', async () => {
      vi.mocked(fetchNote).mockResolvedValueOnce(MOCK_NOTE_ROW);
      // 55 links, limit clamped to 50
      const manyLinks = Array.from({ length: 55 }, (_, i) => ({
        ...MOCK_LINK,
        to_id: `aaaaaaaa-0000-0000-0000-${String(i).padStart(12, '0')}`,
      }));
      vi.mocked(fetchNoteLinks).mockResolvedValueOnce(manyLinks);
      const r = toolResult(await handleGetRelated({ id: VALID_UUID, limit: 999 }, mockDb));
      const body = JSON.parse(r.content[0]!.text);
      expect(body.count).toBe(50);
      expect(body.links).toHaveLength(50);
    });
  });

  describe('happy path', () => {
    it('returns toolError when source note does not exist', async () => {
      vi.mocked(fetchNote).mockResolvedValueOnce(null);
      const r = toolResult(await handleGetRelated({ id: VALID_UUID }, mockDb));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/not found/i);
    });

    it('returns source_id, links, count in toolSuccess', async () => {
      vi.mocked(fetchNote).mockResolvedValueOnce(MOCK_NOTE_ROW);
      vi.mocked(fetchNoteLinks).mockResolvedValueOnce([MOCK_LINK]);
      const r = toolResult(await handleGetRelated({ id: VALID_UUID }, mockDb));
      const body = JSON.parse(r.content[0]!.text);
      expect(body.source_id).toBe(VALID_UUID);
      expect(body.links).toHaveLength(1);
      expect(body.count).toBe(1);
    });

    it('returns toolError on DB exception', async () => {
      vi.mocked(fetchNote).mockRejectedValueOnce(new Error('DB error'));
      const r = toolResult(await handleGetRelated({ id: VALID_UUID }, mockDb));
      expect(r.isError).toBe(true);
    });
  });
});

// ── handleCaptureNote ─────────────────────────────────────────────────────────

describe('handleCaptureNote', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('input validation', () => {
    it('returns error when raw_input is missing', async () => {
      const r = toolResult(await handleCaptureNote({}, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/raw_input is required/);
    });

    it('returns error when raw_input is empty string', async () => {
      const r = toolResult(await handleCaptureNote({ raw_input: '' }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
    });

    it('returns error when raw_input exceeds 4000 characters', async () => {
      const r = toolResult(await handleCaptureNote({ raw_input: 'a'.repeat(4001) }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/4000 character/);
    });

    it('defaults source to "mcp" when not provided', async () => {
      await handleCaptureNote({ raw_input: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(insertNote)).toHaveBeenCalledWith(
        mockDb, expect.any(Object), expect.any(Array), 'hello', 'mcp',
      );
    });

    it('defaults source to "mcp" when source fails SOURCE_RE pattern', async () => {
      await handleCaptureNote({ raw_input: 'hello', source: 'bad source!' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(insertNote)).toHaveBeenCalledWith(
        mockDb, expect.any(Object), expect.any(Array), 'hello', 'mcp',
      );
    });

    it('defaults source to "mcp" when source exceeds 100 characters', async () => {
      await handleCaptureNote({ raw_input: 'hello', source: 'a'.repeat(101) }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(insertNote)).toHaveBeenCalledWith(
        mockDb, expect.any(Object), expect.any(Array), 'hello', 'mcp',
      );
    });

    it('uses the provided source when valid', async () => {
      await handleCaptureNote({ raw_input: 'hello', source: 'obsidian' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(insertNote)).toHaveBeenCalledWith(
        mockDb, expect.any(Object), expect.any(Array), 'hello', 'obsidian',
      );
    });
  });

  describe('capture pipeline', () => {
    it('embeds text and fetches capture voice (calls both)', async () => {
      await handleCaptureNote({ raw_input: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(embedText)).toHaveBeenCalled();
      expect(vi.mocked(getCaptureVoice)).toHaveBeenCalled();
    });

    it('calls findRelatedNotes with raw embedding and config threshold', async () => {
      vi.mocked(embedText).mockResolvedValueOnce([0.1, 0.2]);
      await handleCaptureNote({ raw_input: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(findRelatedNotes)).toHaveBeenCalledWith(mockDb, [0.1, 0.2], MOCK_CONFIG.matchThreshold);
    });

    it('calls runCaptureAgent with text, related notes, capture voice, and recent fragments', async () => {
      vi.mocked(getCaptureVoice).mockResolvedValueOnce('## Voice rules');
      await handleCaptureNote({ raw_input: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(runCaptureAgent)).toHaveBeenCalledWith(
        mockOpenAI, MOCK_CONFIG, 'hello', [], '## Voice rules', [],
      );
    });

    it('calls embedText a second time for augmented embedding', async () => {
      await handleCaptureNote({ raw_input: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(embedText)).toHaveBeenCalledTimes(2);
    });

    it('calls insertNote with augmented embedding', async () => {
      vi.mocked(embedText).mockResolvedValueOnce([0.1]).mockResolvedValueOnce([0.9]);
      await handleCaptureNote({ raw_input: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(insertNote)).toHaveBeenCalledWith(
        mockDb, expect.any(Object), [0.9], 'hello', 'mcp',
      );
    });

    it('calls insertLinks after inserting note', async () => {
      await handleCaptureNote({ raw_input: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(insertLinks)).toHaveBeenCalledWith(mockDb, VALID_UUID, []);
    });

    it('calls logEnrichments with capture and augmented enrichment types', async () => {
      await handleCaptureNote({ raw_input: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(logEnrichments)).toHaveBeenCalledWith(mockDb, VALID_UUID, [
        { enrichment_type: 'capture', model_used: MOCK_CONFIG.captureModel },
        { enrichment_type: 'embedding_augmented', model_used: MOCK_CONFIG.embedModel },
      ]);
    });

    it('returns toolSuccess with note details', async () => {
      const r = toolResult(await handleCaptureNote({ raw_input: 'hello', source: 'obsidian' }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(false);
      const body = JSON.parse(r.content[0]!.text);
      expect(body.id).toBe(VALID_UUID);
      expect(body.title).toBe('Mock Note');
      expect(body.source).toBe('obsidian');
      expect(body.links_created).toBe(0);
    });
  });

  describe('recent fragments', () => {
    it('fetches recent fragments with config count and window', async () => {
      await handleCaptureNote({ raw_input: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(fetchRecentFragments)).toHaveBeenCalledWith(mockDb, 5, 60);
    });

    it('deduplicates recent fragments against related notes', async () => {
      const sharedId = 'bbbbbbbb-0000-0000-0000-000000000002';
      vi.mocked(findRelatedNotes).mockResolvedValueOnce([{
        id: sharedId, title: 'Shared', body: 'body', raw_input: 'raw',
        tags: ['t'], source_ref: null, source: 'mcp', entities: null,
        created_at: '2026-03-19', similarity: 0.8,
      }]);
      vi.mocked(fetchRecentFragments).mockResolvedValueOnce([
        { id: sharedId, title: 'Shared', tags: ['t'], created_at: '2026-03-19' },
        { id: 'cccccccc-0000-0000-0000-000000000003', title: 'Unique', tags: ['u'], created_at: '2026-03-19' },
      ]);
      await handleCaptureNote({ raw_input: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG);
      // runCaptureAgent should receive only the unique fragment
      const recentArg = vi.mocked(runCaptureAgent).mock.calls[0]![5];
      expect(recentArg).toHaveLength(1);
      expect(recentArg![0]!.id).toBe('cccccccc-0000-0000-0000-000000000003');
    });

    it('skips fetch when recentFragmentsCount is 0', async () => {
      const zeroConfig = { ...MOCK_CONFIG, recentFragmentsCount: 0 };
      await handleCaptureNote({ raw_input: 'hello' }, mockDb, mockOpenAI, zeroConfig);
      expect(vi.mocked(fetchRecentFragments)).not.toHaveBeenCalled();
      expect(vi.mocked(runCaptureAgent)).toHaveBeenCalledWith(
        mockOpenAI, zeroConfig, 'hello', [], expect.any(String), [],
      );
    });
  });

  describe('augmented embed fallback', () => {
    it('falls back to raw embedding when second embedText throws', async () => {
      vi.mocked(embedText)
        .mockResolvedValueOnce([0.1, 0.2]) // raw embed — success
        .mockRejectedValueOnce(new Error('embed failed')); // augmented embed — fail
      const r = toolResult(await handleCaptureNote({ raw_input: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG));
      // Should still succeed — note not lost
      expect(r.isError).toBe(false);
      // insertNote called with raw embedding [0.1, 0.2]
      expect(vi.mocked(insertNote)).toHaveBeenCalledWith(
        mockDb, expect.any(Object), [0.1, 0.2], 'hello', 'mcp',
      );
    });

    it('logs raw_fallback enrichment type when augmented embed fails', async () => {
      vi.mocked(embedText)
        .mockResolvedValueOnce([0.1])
        .mockRejectedValueOnce(new Error('embed failed'));
      await handleCaptureNote({ raw_input: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(logEnrichments)).toHaveBeenCalledWith(mockDb, expect.any(String), [
        { enrichment_type: 'capture', model_used: MOCK_CONFIG.captureModel },
        { enrichment_type: 'embedding_raw_fallback', model_used: MOCK_CONFIG.embedModel },
      ]);
    });
  });

  describe('error handling', () => {
    it('returns toolError when first embedText throws', async () => {
      vi.mocked(embedText).mockRejectedValueOnce(new Error('API down'));
      const r = toolResult(await handleCaptureNote({ raw_input: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
    });

    it('returns toolError when runCaptureAgent throws', async () => {
      vi.mocked(runCaptureAgent).mockRejectedValueOnce(new Error('LLM error'));
      const r = toolResult(await handleCaptureNote({ raw_input: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
    });

    it('returns toolError when insertNote throws', async () => {
      vi.mocked(insertNote).mockRejectedValueOnce(new Error('DB error'));
      const r = toolResult(await handleCaptureNote({ raw_input: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
    });
  });
});

// ── handleRemoveNote ────────────────────────────────────────────────────────

// Helper: note created N minutes ago
function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 1000).toISOString();
}

describe('handleRemoveNote', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('input validation', () => {
    it('returns error when id is missing', async () => {
      const r = toolResult(await handleRemoveNote({}, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/id is required/);
    });

    it('returns error when id is not a string', async () => {
      const r = toolResult(await handleRemoveNote({ id: 123 }, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(true);
    });

    it('returns error when id fails UUID format', async () => {
      const r = toolResult(await handleRemoveNote({ id: 'not-a-uuid' }, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/Invalid UUID/);
    });
  });

  describe('note lookup', () => {
    it('returns "not found" when note does not exist', async () => {
      vi.mocked(fetchNoteForArchive).mockResolvedValueOnce(null);
      const r = toolResult(await handleRemoveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/not found/i);
    });

    it('returns success for already-archived note (idempotent)', async () => {
      vi.mocked(fetchNoteForArchive).mockResolvedValueOnce({
        id: VALID_UUID,
        created_at: minutesAgo(60),
        archived_at: minutesAgo(5),
      });
      const r = toolResult(await handleRemoveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(false);
      const body = JSON.parse(r.content[0]!.text);
      expect(body.archived).toBe(true);
      expect(body.id).toBe(VALID_UUID);
    });

    it('does not call archiveNote or hardDeleteNote for already-archived note', async () => {
      vi.mocked(fetchNoteForArchive).mockResolvedValueOnce({
        id: VALID_UUID,
        created_at: minutesAgo(60),
        archived_at: minutesAgo(5),
      });
      await handleRemoveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG);
      expect(vi.mocked(archiveNote)).not.toHaveBeenCalled();
      expect(vi.mocked(hardDeleteNote)).not.toHaveBeenCalled();
    });
  });

  describe('hard delete path (within grace window)', () => {
    it('hard-deletes a note created 2 minutes ago', async () => {
      vi.mocked(fetchNoteForArchive).mockResolvedValueOnce({
        id: VALID_UUID,
        created_at: minutesAgo(2),
        archived_at: null,
      });
      const r = toolResult(await handleRemoveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(false);
      const body = JSON.parse(r.content[0]!.text);
      expect(body.deleted).toBe(true);
      expect(vi.mocked(hardDeleteNote)).toHaveBeenCalledWith(mockDb, VALID_UUID);
      expect(vi.mocked(archiveNote)).not.toHaveBeenCalled();
    });

    it('hard-deletes a note created 9 minutes ago (still within 11-minute window)', async () => {
      vi.mocked(fetchNoteForArchive).mockResolvedValueOnce({
        id: VALID_UUID,
        created_at: minutesAgo(9),
        archived_at: null,
      });
      const r = toolResult(await handleRemoveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG));
      const body = JSON.parse(r.content[0]!.text);
      expect(body.deleted).toBe(true);
      expect(vi.mocked(hardDeleteNote)).toHaveBeenCalledOnce();
    });
  });

  describe('soft archive path (beyond grace window)', () => {
    it('soft-archives a note created 15 minutes ago', async () => {
      vi.mocked(fetchNoteForArchive).mockResolvedValueOnce({
        id: VALID_UUID,
        created_at: minutesAgo(15),
        archived_at: null,
      });
      const r = toolResult(await handleRemoveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(false);
      const body = JSON.parse(r.content[0]!.text);
      expect(body.archived).toBe(true);
      expect(body.id).toBe(VALID_UUID);
      expect(vi.mocked(archiveNote)).toHaveBeenCalledWith(mockDb, VALID_UUID);
      expect(vi.mocked(hardDeleteNote)).not.toHaveBeenCalled();
    });

    it('soft-archives a note created exactly at the grace window boundary', async () => {
      vi.mocked(fetchNoteForArchive).mockResolvedValueOnce({
        id: VALID_UUID,
        created_at: minutesAgo(11),
        archived_at: null,
      });
      const r = toolResult(await handleRemoveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG));
      const body = JSON.parse(r.content[0]!.text);
      expect(body.archived).toBe(true);
      expect(vi.mocked(archiveNote)).toHaveBeenCalledOnce();
      expect(vi.mocked(hardDeleteNote)).not.toHaveBeenCalled();
    });

    it('soft-archives a note created 24 hours ago', async () => {
      vi.mocked(fetchNoteForArchive).mockResolvedValueOnce({
        id: VALID_UUID,
        created_at: minutesAgo(60 * 24),
        archived_at: null,
      });
      const r = toolResult(await handleRemoveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG));
      const body = JSON.parse(r.content[0]!.text);
      expect(body.archived).toBe(true);
    });
  });

  describe('error handling', () => {
    it('returns toolError when fetchNoteForArchive throws', async () => {
      vi.mocked(fetchNoteForArchive).mockRejectedValueOnce(new Error('DB error'));
      const r = toolResult(await handleRemoveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/Archive operation failed/);
    });

    it('returns toolError when hardDeleteNote throws', async () => {
      vi.mocked(fetchNoteForArchive).mockResolvedValueOnce({
        id: VALID_UUID,
        created_at: minutesAgo(2),
        archived_at: null,
      });
      vi.mocked(hardDeleteNote).mockRejectedValueOnce(new Error('DB error'));
      const r = toolResult(await handleRemoveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(true);
    });

    it('returns toolError when archiveNote throws', async () => {
      vi.mocked(fetchNoteForArchive).mockResolvedValueOnce({
        id: VALID_UUID,
        created_at: minutesAgo(60),
        archived_at: null,
      });
      vi.mocked(archiveNote).mockRejectedValueOnce(new Error('DB error'));
      const r = toolResult(await handleRemoveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(true);
    });
  });

  describe('config usage', () => {
    it('uses config.hardDeleteWindowMinutes for the threshold', async () => {
      // 5 minutes ago, with a 3-minute window → should soft-archive
      const shortWindowConfig = { ...MOCK_CONFIG, hardDeleteWindowMinutes: 3 };
      vi.mocked(fetchNoteForArchive).mockResolvedValueOnce({
        id: VALID_UUID,
        created_at: minutesAgo(5),
        archived_at: null,
      });
      const r = toolResult(await handleRemoveNote({ id: VALID_UUID }, mockDb, shortWindowConfig));
      const body = JSON.parse(r.content[0]!.text);
      expect(body.archived).toBe(true);
      expect(vi.mocked(archiveNote)).toHaveBeenCalledOnce();
    });

    it('hard-deletes with a longer grace window', async () => {
      // 5 minutes ago, with a 30-minute window → should hard-delete
      const longWindowConfig = { ...MOCK_CONFIG, hardDeleteWindowMinutes: 30 };
      vi.mocked(fetchNoteForArchive).mockResolvedValueOnce({
        id: VALID_UUID,
        created_at: minutesAgo(5),
        archived_at: null,
      });
      const r = toolResult(await handleRemoveNote({ id: VALID_UUID }, mockDb, longWindowConfig));
      const body = JSON.parse(r.content[0]!.text);
      expect(body.deleted).toBe(true);
      expect(vi.mocked(hardDeleteNote)).toHaveBeenCalledOnce();
    });
  });
});

// ── handleListClusters ───────────────────────────────────────────────────────

const MOCK_CLUSTER = {
  label: 'cooking / italian / pasta',
  top_tags: ['cooking', 'italian', 'pasta'],
  note_count: 3,
  gravity: 2.5,
  notes: [
    { id: 'aaaaaaaa-0000-0000-0000-000000000001', title: 'Homemade pasta basics' },
    { id: 'aaaaaaaa-0000-0000-0000-000000000002', title: 'Italian cooking philosophy' },
    { id: 'aaaaaaaa-0000-0000-0000-000000000003', title: 'Pasta shapes and sauces' },
  ],
  hub_notes: [
    { id: 'aaaaaaaa-0000-0000-0000-000000000001', title: 'Homemade pasta basics', link_count: 4 },
  ],
};

describe('handleListClusters', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('defaults', () => {
    it('defaults resolution to 1.0 when not provided', async () => {
      await handleListClusters({}, mockDb);
      expect(vi.mocked(fetchClusters)).toHaveBeenCalledWith(mockDb, 1.0);
    });

    it('passes through a provided resolution', async () => {
      await handleListClusters({ resolution: 2.0 }, mockDb);
      expect(vi.mocked(fetchClusters)).toHaveBeenCalledWith(mockDb, 2.0);
    });

    it('defaults resolution to 1.0 when non-numeric value provided', async () => {
      await handleListClusters({ resolution: 'bad' }, mockDb);
      expect(vi.mocked(fetchClusters)).toHaveBeenCalledWith(mockDb, 1.0);
    });
  });

  describe('empty state', () => {
    it('returns empty clusters when gardener has not run', async () => {
      vi.mocked(fetchClusters).mockResolvedValueOnce({ clusters: [], computed_at: null });
      const r = toolResult(await handleListClusters({}, mockDb));
      expect(r.isError).toBe(false);
      const body = JSON.parse(r.content[0]!.text);
      expect(body.cluster_count).toBe(0);
      expect(body.clusters).toEqual([]);
      expect(body.computed_at).toBeNull();
    });
  });

  describe('happy path', () => {
    it('returns clusters with correct structure', async () => {
      vi.mocked(fetchClusters).mockResolvedValueOnce({
        clusters: [MOCK_CLUSTER],
        computed_at: '2026-03-18T02:00:00.000Z',
      });
      const r = toolResult(await handleListClusters({}, mockDb));
      expect(r.isError).toBe(false);
      const body = JSON.parse(r.content[0]!.text);
      expect(body.cluster_count).toBe(1);
      expect(body.resolution).toBe(1.0);
      expect(body.clustered_notes).toBe(3);
      expect(body.computed_at).toBe('2026-03-18T02:00:00.000Z');
      expect(body.available_resolutions).toEqual([1.0, 1.5, 2.0]);
    });

    it('returns available_resolutions from DB', async () => {
      vi.mocked(fetchClusters).mockResolvedValueOnce({ clusters: [], computed_at: null });
      vi.mocked(fetchAvailableResolutions).mockResolvedValueOnce([1.0, 2.0]);
      const r = toolResult(await handleListClusters({}, mockDb));
      const body = JSON.parse(r.content[0]!.text);
      expect(body.available_resolutions).toEqual([1.0, 2.0]);
    });

    it('returns cluster fields correctly', async () => {
      vi.mocked(fetchClusters).mockResolvedValueOnce({
        clusters: [MOCK_CLUSTER],
        computed_at: '2026-03-18T02:00:00.000Z',
      });
      const r = toolResult(await handleListClusters({}, mockDb));
      const body = JSON.parse(r.content[0]!.text);
      const cluster = body.clusters[0];
      expect(cluster.label).toBe('cooking / italian / pasta');
      expect(cluster.top_tags).toEqual(['cooking', 'italian', 'pasta']);
      expect(cluster.note_count).toBe(3);
      expect(cluster.gravity).toBe(2.5);
      expect(cluster.notes).toHaveLength(3);
      expect(cluster.notes[0].title).toBe('Homemade pasta basics');
    });

    it('includes hub_notes in cluster response', async () => {
      vi.mocked(fetchClusters).mockResolvedValueOnce({
        clusters: [MOCK_CLUSTER],
        computed_at: '2026-03-18T02:00:00.000Z',
      });
      const r = toolResult(await handleListClusters({}, mockDb));
      const body = JSON.parse(r.content[0]!.text);
      const cluster = body.clusters[0];
      expect(cluster.hub_notes).toHaveLength(1);
      expect(cluster.hub_notes[0].title).toBe('Homemade pasta basics');
      expect(cluster.hub_notes[0].link_count).toBe(4);
    });

    it('returns empty hub_notes when no notes have links', async () => {
      const noHubCluster = { ...MOCK_CLUSTER, hub_notes: [] };
      vi.mocked(fetchClusters).mockResolvedValueOnce({
        clusters: [noHubCluster],
        computed_at: '2026-03-18T02:00:00.000Z',
      });
      const r = toolResult(await handleListClusters({}, mockDb));
      const body = JSON.parse(r.content[0]!.text);
      expect(body.clusters[0].hub_notes).toEqual([]);
    });

    it('sums clustered_notes across multiple clusters', async () => {
      const cluster2 = { ...MOCK_CLUSTER, label: 'music / jazz', note_count: 5, notes: Array(5).fill(MOCK_CLUSTER.notes[0]), hub_notes: [] };
      vi.mocked(fetchClusters).mockResolvedValueOnce({
        clusters: [MOCK_CLUSTER, cluster2],
        computed_at: '2026-03-18T02:00:00.000Z',
      });
      const r = toolResult(await handleListClusters({}, mockDb));
      const body = JSON.parse(r.content[0]!.text);
      expect(body.clustered_notes).toBe(8);
      expect(body.cluster_count).toBe(2);
    });
  });

  describe('notes_per_cluster', () => {
    const bigCluster = {
      ...MOCK_CLUSTER,
      note_count: 10,
      notes: Array.from({ length: 10 }, (_, i) => ({
        id: `aaaaaaaa-0000-0000-0000-00000000${String(i).padStart(4, '0')}`,
        title: `Note ${i}`,
      })),
      hub_notes: [{ id: 'aaaaaaaa-0000-0000-0000-000000000000', title: 'Note 0', link_count: 3 }],
    };

    it('defaults to 5 notes per cluster', async () => {
      vi.mocked(fetchClusters).mockResolvedValueOnce({
        clusters: [bigCluster],
        computed_at: '2026-03-18T02:00:00.000Z',
      });
      const r = toolResult(await handleListClusters({}, mockDb));
      const body = JSON.parse(r.content[0]!.text);
      expect(body.clusters[0].notes).toHaveLength(5);
      expect(body.clusters[0].note_count).toBe(10);
    });

    it('respects explicit notes_per_cluster value', async () => {
      vi.mocked(fetchClusters).mockResolvedValueOnce({
        clusters: [bigCluster],
        computed_at: '2026-03-18T02:00:00.000Z',
      });
      const r = toolResult(await handleListClusters({ notes_per_cluster: 2 }, mockDb));
      const body = JSON.parse(r.content[0]!.text);
      expect(body.clusters[0].notes).toHaveLength(2);
    });

    it('returns no notes when notes_per_cluster is 0', async () => {
      vi.mocked(fetchClusters).mockResolvedValueOnce({
        clusters: [bigCluster],
        computed_at: '2026-03-18T02:00:00.000Z',
      });
      const r = toolResult(await handleListClusters({ notes_per_cluster: 0 }, mockDb));
      const body = JSON.parse(r.content[0]!.text);
      expect(body.clusters[0].notes).toHaveLength(0);
      expect(body.clusters[0].note_count).toBe(10);
    });

    it('clamps notes_per_cluster to max 50', async () => {
      vi.mocked(fetchClusters).mockResolvedValueOnce({
        clusters: [bigCluster],
        computed_at: '2026-03-18T02:00:00.000Z',
      });
      const r = toolResult(await handleListClusters({ notes_per_cluster: 100 }, mockDb));
      const body = JSON.parse(r.content[0]!.text);
      expect(body.clusters[0].notes).toHaveLength(10);
    });
  });

  describe('error handling', () => {
    it('returns toolError when fetchClusters throws', async () => {
      vi.mocked(fetchClusters).mockRejectedValueOnce(new Error('DB error'));
      const r = toolResult(await handleListClusters({}, mockDb));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/Failed to fetch clusters/);
    });
  });
});

// ── handleTriggerGardening ──────────────────────────────────────────────────

// Helper: ISO timestamp N minutes ago
function minutesAgoISO(n: number): string {
  return new Date(Date.now() - n * 60 * 1000).toISOString();
}

const MOCK_GARDENER_RESULT = {
  event: 'gardener_run_complete',
  similarity: { notes_processed: 10, links_deleted: 5, links_created: 3, enriched_notes: 4, errors: [] },
  clustering: { clusters_created: 3, resolutions_run: 3, clusters_deleted: 2, error: null },
  entities: { notes_extracted: 2, dictionary_entries: 5, notes_updated: 2, error: null },
  duration_ms: 15000,
};

describe('handleTriggerGardening', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('not configured', () => {
    it('returns toolError when gardenerUrl is null', async () => {
      const noGardenerConfig = { ...MOCK_CONFIG, gardenerUrl: null, gardenerApiKey: null };
      const r = toolResult(await handleTriggerGardening({}, mockDb, noGardenerConfig));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/not configured/i);
    });

    it('returns toolError when gardenerApiKey is null', async () => {
      const noKeyConfig = { ...MOCK_CONFIG, gardenerUrl: 'https://example.com', gardenerApiKey: null };
      const r = toolResult(await handleTriggerGardening({}, mockDb, noKeyConfig));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/not configured/i);
    });
  });

  describe('cooldown', () => {
    it('returns toolError when last run was within cooldown period', async () => {
      vi.mocked(fetchLastGardenerRun).mockResolvedValueOnce(minutesAgoISO(2));
      const r = toolResult(await handleTriggerGardening({}, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/cooldown/i);
    });

    it('includes minutes remaining in cooldown error', async () => {
      vi.mocked(fetchLastGardenerRun).mockResolvedValueOnce(minutesAgoISO(3));
      const r = toolResult(await handleTriggerGardening({}, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      // ~2 minutes remaining on 5-minute cooldown
      expect(r.content[0]!.text).toMatch(/\d/);
    });

    it('allows trigger when last run was beyond cooldown period', async () => {
      vi.mocked(fetchLastGardenerRun).mockResolvedValueOnce(minutesAgoISO(6));
      const r = toolResult(await handleTriggerGardening({}, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(false);
    });

    it('allows trigger when no prior run exists (null)', async () => {
      vi.mocked(fetchLastGardenerRun).mockResolvedValueOnce(null);
      const r = toolResult(await handleTriggerGardening({}, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(false);
    });

    it('allows trigger when last run was exactly at cooldown boundary', async () => {
      vi.mocked(fetchLastGardenerRun).mockResolvedValueOnce(minutesAgoISO(5));
      const r = toolResult(await handleTriggerGardening({}, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(false);
    });
  });

  describe('happy path', () => {
    it('calls triggerGardenerWorker with url and api key from config', async () => {
      vi.mocked(fetchLastGardenerRun).mockResolvedValueOnce(null);
      await handleTriggerGardening({}, mockDb, MOCK_CONFIG);
      expect(vi.mocked(triggerGardenerWorker)).toHaveBeenCalledWith(
        'https://contemplace-gardener.workers.dev',
        'test-gardener-key',
      );
    });

    it('returns the full GardenerRunResult on success', async () => {
      vi.mocked(fetchLastGardenerRun).mockResolvedValueOnce(null);
      const r = toolResult(await handleTriggerGardening({}, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(false);
      const body = JSON.parse(r.content[0]!.text);
      expect(body.event).toBe('gardener_run_complete');
      expect(body.similarity.links_created).toBe(3);
      expect(body.clustering.clusters_created).toBe(3);
      expect(body.entities.notes_extracted).toBe(2);
      expect(body.duration_ms).toBe(15000);
    });
  });

  describe('error handling', () => {
    it('returns toolError when triggerGardenerWorker throws', async () => {
      vi.mocked(fetchLastGardenerRun).mockResolvedValueOnce(null);
      vi.mocked(triggerGardenerWorker).mockRejectedValueOnce(new Error('Gardener Worker returned 500'));
      const r = toolResult(await handleTriggerGardening({}, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/Gardening failed/i);
    });

    it('returns toolError when fetchLastGardenerRun throws', async () => {
      vi.mocked(fetchLastGardenerRun).mockRejectedValueOnce(new Error('DB error'));
      const r = toolResult(await handleTriggerGardening({}, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(true);
    });
  });
});

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
  listUnmatchedTags: vi.fn().mockResolvedValue([]),
  insertConcept: vi.fn().mockResolvedValue({ id: 'cccccccc-0000-0000-0000-000000000001', scheme: 'domains', pref_label: 'test-concept' }),
  searchChunks: vi.fn().mockResolvedValue([]),
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
    type: 'idea',
    tags: ['mock'],
    source_ref: null,
    corrections: null,
    intent: 'remember',
    modality: 'text',
    entities: [],
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
  handleListUnmatchedTags,
  handlePromoteConcept,
  handleSearchChunks,
} from '../mcp/src/tools';
import {
  searchNotes,
  searchChunks,
  fetchNote,
  fetchNoteLinks,
  listRecentNotes,
  getCaptureVoice,
  findRelatedNotes,
  insertNote,
  insertLinks,
  logEnrichments,
  listUnmatchedTags,
  insertConcept,
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
};

const mockDb = {} as unknown as SupabaseClient;
const mockOpenAI = {} as unknown as OpenAI;

const VALID_UUID = 'aaaaaaaa-0000-0000-0000-000000000001';

const MOCK_NOTE_ROW = {
  id: VALID_UUID,
  title: 'A Note',
  body: 'The body.',
  raw_input: 'the raw input',
  type: 'idea',
  intent: 'remember',
  modality: 'text',
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
  link_type: 'extends',
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

    it('returns error for invalid filter_type', async () => {
      const r = toolResult(await handleSearchNotes({ query: 'test', filter_type: 'bogus' }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/filter_type/);
    });

    it('returns error for invalid filter_intent', async () => {
      const r = toolResult(await handleSearchNotes({ query: 'test', filter_intent: 'wish' }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/filter_intent/);
    });
  });

  describe('clamping', () => {
    it('defaults limit to 5 when not provided', async () => {
      await handleSearchNotes({ query: 'test' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(searchNotes)).toHaveBeenCalledWith(mockDb, expect.any(Array), expect.any(Number), 5, undefined, undefined, undefined);
    });

    it('clamps limit above 20 down to 20', async () => {
      await handleSearchNotes({ query: 'test', limit: 99 }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(searchNotes)).toHaveBeenCalledWith(mockDb, expect.any(Array), expect.any(Number), 20, undefined, undefined, undefined);
    });

    it('clamps limit below 1 up to 1', async () => {
      await handleSearchNotes({ query: 'test', limit: 0 }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(searchNotes)).toHaveBeenCalledWith(mockDb, expect.any(Array), expect.any(Number), 1, undefined, undefined, undefined);
    });

    it('defaults threshold to config.searchThreshold when not provided', async () => {
      await handleSearchNotes({ query: 'test' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(searchNotes)).toHaveBeenCalledWith(mockDb, expect.any(Array), MOCK_CONFIG.searchThreshold, expect.any(Number), undefined, undefined, undefined);
    });

    it('clamps threshold above 1 down to 1', async () => {
      await handleSearchNotes({ query: 'test', threshold: 1.5 }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(searchNotes)).toHaveBeenCalledWith(mockDb, expect.any(Array), 1, expect.any(Number), undefined, undefined, undefined);
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
      expect(vi.mocked(searchNotes)).toHaveBeenCalledWith(mockDb, expect.any(Array), expect.any(Number), expect.any(Number), undefined, undefined, ['tag1', 'tag2']);
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
        type: 'idea',
        tags: ['t'],
        source_ref: null,
        source: 'telegram',
        intent: 'remember',
        modality: 'text',
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
      expect(body.links[0].link_type).toBe('extends');
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
      expect(vi.mocked(listRecentNotes)).toHaveBeenCalledWith(mockDb, 10, undefined, undefined);
    });

    it('clamps limit above 50 down to 50', async () => {
      await handleListRecent({ limit: 999 }, mockDb);
      expect(vi.mocked(listRecentNotes)).toHaveBeenCalledWith(mockDb, 50, undefined, undefined);
    });

    it('clamps limit below 1 up to 1', async () => {
      await handleListRecent({ limit: 0 }, mockDb);
      expect(vi.mocked(listRecentNotes)).toHaveBeenCalledWith(mockDb, 1, undefined, undefined);
    });

    it('returns error for invalid filter_type', async () => {
      const r = toolResult(await handleListRecent({ filter_type: 'bogus' }, mockDb));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/filter_type/);
    });

    it('returns error for invalid filter_intent', async () => {
      const r = toolResult(await handleListRecent({ filter_intent: 'wish' }, mockDb));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/filter_intent/);
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

    it('passes filter_type and filter_intent to listRecentNotes', async () => {
      await handleListRecent({ filter_type: 'idea', filter_intent: 'plan' }, mockDb);
      expect(vi.mocked(listRecentNotes)).toHaveBeenCalledWith(mockDb, expect.any(Number), 'idea', 'plan');
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
    it('returns error when text is missing', async () => {
      const r = toolResult(await handleCaptureNote({}, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/text is required/);
    });

    it('returns error when text is empty string', async () => {
      const r = toolResult(await handleCaptureNote({ text: '' }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
    });

    it('returns error when text exceeds 4000 characters', async () => {
      const r = toolResult(await handleCaptureNote({ text: 'a'.repeat(4001) }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/4000 character/);
    });

    it('defaults source to "mcp" when not provided', async () => {
      await handleCaptureNote({ text: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(insertNote)).toHaveBeenCalledWith(
        mockDb, expect.any(Object), expect.any(Array), 'hello', 'mcp',
      );
    });

    it('defaults source to "mcp" when source fails SOURCE_RE pattern', async () => {
      await handleCaptureNote({ text: 'hello', source: 'bad source!' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(insertNote)).toHaveBeenCalledWith(
        mockDb, expect.any(Object), expect.any(Array), 'hello', 'mcp',
      );
    });

    it('defaults source to "mcp" when source exceeds 100 characters', async () => {
      await handleCaptureNote({ text: 'hello', source: 'a'.repeat(101) }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(insertNote)).toHaveBeenCalledWith(
        mockDb, expect.any(Object), expect.any(Array), 'hello', 'mcp',
      );
    });

    it('uses the provided source when valid', async () => {
      await handleCaptureNote({ text: 'hello', source: 'obsidian' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(insertNote)).toHaveBeenCalledWith(
        mockDb, expect.any(Object), expect.any(Array), 'hello', 'obsidian',
      );
    });
  });

  describe('capture pipeline', () => {
    it('embeds text and fetches capture voice (calls both)', async () => {
      await handleCaptureNote({ text: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(embedText)).toHaveBeenCalled();
      expect(vi.mocked(getCaptureVoice)).toHaveBeenCalled();
    });

    it('calls findRelatedNotes with raw embedding and config threshold', async () => {
      vi.mocked(embedText).mockResolvedValueOnce([0.1, 0.2]);
      await handleCaptureNote({ text: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(findRelatedNotes)).toHaveBeenCalledWith(mockDb, [0.1, 0.2], MOCK_CONFIG.matchThreshold);
    });

    it('calls runCaptureAgent with text and related notes and capture voice', async () => {
      vi.mocked(getCaptureVoice).mockResolvedValueOnce('## Voice rules');
      await handleCaptureNote({ text: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(runCaptureAgent)).toHaveBeenCalledWith(
        mockOpenAI, MOCK_CONFIG, 'hello', [], '## Voice rules',
      );
    });

    it('calls embedText a second time for augmented embedding', async () => {
      await handleCaptureNote({ text: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(embedText)).toHaveBeenCalledTimes(2);
    });

    it('calls insertNote with augmented embedding', async () => {
      vi.mocked(embedText).mockResolvedValueOnce([0.1]).mockResolvedValueOnce([0.9]);
      await handleCaptureNote({ text: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(insertNote)).toHaveBeenCalledWith(
        mockDb, expect.any(Object), [0.9], 'hello', 'mcp',
      );
    });

    it('calls insertLinks after inserting note', async () => {
      await handleCaptureNote({ text: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(insertLinks)).toHaveBeenCalledWith(mockDb, VALID_UUID, []);
    });

    it('calls logEnrichments with capture and augmented enrichment types', async () => {
      await handleCaptureNote({ text: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(logEnrichments)).toHaveBeenCalledWith(mockDb, VALID_UUID, [
        { enrichment_type: 'capture', model_used: MOCK_CONFIG.captureModel },
        { enrichment_type: 'augmented', model_used: MOCK_CONFIG.embedModel },
      ]);
    });

    it('returns toolSuccess with note details', async () => {
      const r = toolResult(await handleCaptureNote({ text: 'hello', source: 'obsidian' }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(false);
      const body = JSON.parse(r.content[0]!.text);
      expect(body.id).toBe(VALID_UUID);
      expect(body.title).toBe('Mock Note');
      expect(body.source).toBe('obsidian');
      expect(body.links_created).toBe(0);
    });
  });

  describe('augmented embed fallback', () => {
    it('falls back to raw embedding when second embedText throws', async () => {
      vi.mocked(embedText)
        .mockResolvedValueOnce([0.1, 0.2]) // raw embed — success
        .mockRejectedValueOnce(new Error('embed failed')); // augmented embed — fail
      const r = toolResult(await handleCaptureNote({ text: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG));
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
      await handleCaptureNote({ text: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(logEnrichments)).toHaveBeenCalledWith(mockDb, expect.any(String), [
        { enrichment_type: 'capture', model_used: MOCK_CONFIG.captureModel },
        { enrichment_type: 'raw_fallback', model_used: MOCK_CONFIG.embedModel },
      ]);
    });
  });

  describe('error handling', () => {
    it('returns toolError when first embedText throws', async () => {
      vi.mocked(embedText).mockRejectedValueOnce(new Error('API down'));
      const r = toolResult(await handleCaptureNote({ text: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
    });

    it('returns toolError when runCaptureAgent throws', async () => {
      vi.mocked(runCaptureAgent).mockRejectedValueOnce(new Error('LLM error'));
      const r = toolResult(await handleCaptureNote({ text: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
    });

    it('returns toolError when insertNote throws', async () => {
      vi.mocked(insertNote).mockRejectedValueOnce(new Error('DB error'));
      const r = toolResult(await handleCaptureNote({ text: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
    });
  });
});

// ── handleListUnmatchedTags ─────────────────────────────────────────────────

describe('handleListUnmatchedTags', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('input handling', () => {
    it('defaults min_count to 1 when not provided', async () => {
      await handleListUnmatchedTags({}, mockDb);
      expect(vi.mocked(listUnmatchedTags)).toHaveBeenCalledWith(mockDb, 1);
    });

    it('clamps min_count below 1 up to 1', async () => {
      await handleListUnmatchedTags({ min_count: 0 }, mockDb);
      expect(vi.mocked(listUnmatchedTags)).toHaveBeenCalledWith(mockDb, 1);
    });

    it('clamps min_count above 100 down to 100', async () => {
      await handleListUnmatchedTags({ min_count: 999 }, mockDb);
      expect(vi.mocked(listUnmatchedTags)).toHaveBeenCalledWith(mockDb, 100);
    });

    it('passes valid min_count through', async () => {
      await handleListUnmatchedTags({ min_count: 5 }, mockDb);
      expect(vi.mocked(listUnmatchedTags)).toHaveBeenCalledWith(mockDb, 5);
    });
  });

  describe('happy path', () => {
    it('returns empty array when no unmatched tags exist', async () => {
      vi.mocked(listUnmatchedTags).mockResolvedValueOnce([]);
      const r = toolResult(await handleListUnmatchedTags({}, mockDb));
      expect(r.isError).toBe(false);
      const body = JSON.parse(r.content[0]!.text);
      expect(body.tags).toEqual([]);
      expect(body.count).toBe(0);
    });

    it('returns tag list with count', async () => {
      vi.mocked(listUnmatchedTags).mockResolvedValueOnce([
        { tag: 'plywood', count: 3, first_seen: '2026-03-09T00:00:00Z', last_seen: '2026-03-10T00:00:00Z' },
        { tag: 'cnc', count: 2, first_seen: '2026-03-10T00:00:00Z', last_seen: '2026-03-10T12:00:00Z' },
      ]);
      const r = toolResult(await handleListUnmatchedTags({}, mockDb));
      expect(r.isError).toBe(false);
      const body = JSON.parse(r.content[0]!.text);
      expect(body.tags).toHaveLength(2);
      expect(body.tags[0].tag).toBe('plywood');
      expect(body.count).toBe(2);
    });
  });

  describe('error handling', () => {
    it('returns toolError on DB exception', async () => {
      vi.mocked(listUnmatchedTags).mockRejectedValueOnce(new Error('DB error'));
      const r = toolResult(await handleListUnmatchedTags({}, mockDb));
      expect(r.isError).toBe(true);
    });
  });
});

// ── handlePromoteConcept ────────────────────────────────────────────────────

describe('handlePromoteConcept', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('input validation', () => {
    it('returns error when pref_label is missing', async () => {
      const r = toolResult(await handlePromoteConcept({ scheme: 'domains' }, mockDb));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/pref_label/);
    });

    it('returns error when pref_label is empty', async () => {
      const r = toolResult(await handlePromoteConcept({ pref_label: '', scheme: 'domains' }, mockDb));
      expect(r.isError).toBe(true);
    });

    it('returns error when pref_label exceeds 100 chars', async () => {
      const r = toolResult(await handlePromoteConcept({ pref_label: 'a'.repeat(101), scheme: 'domains' }, mockDb));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/100 character/);
    });

    it('returns error when scheme is missing', async () => {
      const r = toolResult(await handlePromoteConcept({ pref_label: 'test' }, mockDb));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/scheme/);
    });

    it('returns error when scheme is invalid', async () => {
      const r = toolResult(await handlePromoteConcept({ pref_label: 'test', scheme: 'invalid' }, mockDb));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/Invalid scheme/);
    });

    it('normalizes pref_label to kebab-case', async () => {
      await handlePromoteConcept({ pref_label: 'Laser Cutting', scheme: 'domains' }, mockDb);
      expect(vi.mocked(insertConcept)).toHaveBeenCalledWith(
        mockDb, 'domains', 'laser-cutting', expect.any(Array), null,
      );
    });

    it('returns error for pref_label that normalizes to empty string', async () => {
      const r = toolResult(await handlePromoteConcept({ pref_label: '!!!', scheme: 'domains' }, mockDb));
      expect(r.isError).toBe(true);
    });

    it('returns error when alt_labels exceeds 20 elements', async () => {
      const altLabels = Array.from({ length: 21 }, (_, i) => `label-${i}`);
      const r = toolResult(await handlePromoteConcept({ pref_label: 'test', scheme: 'domains', alt_labels: altLabels }, mockDb));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/20 element/);
    });

    it('returns error when an alt_label is not a string', async () => {
      const r = toolResult(await handlePromoteConcept({ pref_label: 'test', scheme: 'domains', alt_labels: [123] }, mockDb));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/string/);
    });

    it('returns error when definition exceeds 500 chars', async () => {
      const r = toolResult(await handlePromoteConcept({ pref_label: 'test', scheme: 'domains', definition: 'x'.repeat(501) }, mockDb));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/500 char/);
    });

    it('defaults alt_labels to empty array', async () => {
      await handlePromoteConcept({ pref_label: 'test', scheme: 'domains' }, mockDb);
      expect(vi.mocked(insertConcept)).toHaveBeenCalledWith(mockDb, 'domains', 'test', [], null);
    });

    it('deduplicates and lowercases alt_labels', async () => {
      await handlePromoteConcept({
        pref_label: 'test',
        scheme: 'domains',
        alt_labels: ['Foo', 'foo', 'Bar'],
      }, mockDb);
      expect(vi.mocked(insertConcept)).toHaveBeenCalledWith(
        mockDb, 'domains', 'test', ['foo', 'bar'], null,
      );
    });
  });

  describe('happy path', () => {
    it('returns the created concept on success', async () => {
      const r = toolResult(await handlePromoteConcept({ pref_label: 'test', scheme: 'domains' }, mockDb));
      expect(r.isError).toBe(false);
      const body = JSON.parse(r.content[0]!.text);
      expect(body.id).toBe('cccccccc-0000-0000-0000-000000000001');
      expect(body.scheme).toBe('domains');
      expect(body.pref_label).toBe('test-concept');
      expect(body.message).toMatch(/gardener run/);
    });
  });

  describe('error handling', () => {
    it('returns descriptive error on duplicate concept', async () => {
      vi.mocked(insertConcept).mockRejectedValueOnce(new Error("DUPLICATE: Concept 'test' already exists in scheme 'domains'"));
      const r = toolResult(await handlePromoteConcept({ pref_label: 'test', scheme: 'domains' }, mockDb));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/already exists/);
    });

    it('returns generic error on other DB exceptions', async () => {
      vi.mocked(insertConcept).mockRejectedValueOnce(new Error('Connection refused'));
      const r = toolResult(await handlePromoteConcept({ pref_label: 'test', scheme: 'domains' }, mockDb));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/Database error/);
    });
  });
});

// ── handleSearchChunks ────────────────────────────────────────────────────────

describe('handleSearchChunks', () => {
  beforeEach(() => vi.clearAllMocks());

  const MOCK_CHUNK = {
    chunk_id: 'dddddddd-0000-0000-0000-000000000001',
    note_id: VALID_UUID,
    chunk_index: 0,
    content: 'Some paragraph text from a long note.',
    note_title: 'A Long Note',
    note_type: 'idea',
    note_intent: 'remember',
    note_tags: ['cooking', 'project'],
    similarity: 0.72,
  };

  describe('validation', () => {
    it('rejects missing query', async () => {
      const r = toolResult(await handleSearchChunks({}, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/query is required/);
    });

    it('rejects empty query', async () => {
      const r = toolResult(await handleSearchChunks({ query: '' }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
    });

    it('rejects query over 1000 characters', async () => {
      const r = toolResult(await handleSearchChunks({ query: 'x'.repeat(1001) }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/1000 character/);
    });
  });

  describe('success path', () => {
    it('returns chunk results with note metadata', async () => {
      vi.mocked(searchChunks).mockResolvedValueOnce([MOCK_CHUNK]);
      const r = toolResult(await handleSearchChunks({ query: 'cooking recipes' }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(false);
      const data = JSON.parse(r.content[0]!.text);
      expect(data.count).toBe(1);
      expect(data.results[0].chunk_id).toBe(MOCK_CHUNK.chunk_id);
      expect(data.results[0].note_id).toBe(VALID_UUID);
      expect(data.results[0].note_title).toBe('A Long Note');
      expect(data.results[0].note_type).toBe('idea');
      expect(data.results[0].note_tags).toEqual(['cooking', 'project']);
      expect(data.results[0].content).toBe(MOCK_CHUNK.content);
      expect(data.results[0].score).toBe(0.72);
    });

    it('uses default limit of 10', async () => {
      vi.mocked(searchChunks).mockResolvedValueOnce([]);
      await handleSearchChunks({ query: 'test' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(searchChunks)).toHaveBeenCalledWith(mockDb, [0.1, 0.2, 0.3], 0.35, 10);
    });

    it('clamps limit to 1–50', async () => {
      vi.mocked(searchChunks).mockResolvedValueOnce([]);
      await handleSearchChunks({ query: 'test', limit: 100 }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(searchChunks)).toHaveBeenCalledWith(mockDb, [0.1, 0.2, 0.3], 0.35, 50);
    });

    it('uses config searchThreshold as default', async () => {
      vi.mocked(searchChunks).mockResolvedValueOnce([]);
      await handleSearchChunks({ query: 'test' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(searchChunks)).toHaveBeenCalledWith(mockDb, expect.any(Array), 0.35, 10);
    });

    it('allows custom threshold', async () => {
      vi.mocked(searchChunks).mockResolvedValueOnce([]);
      await handleSearchChunks({ query: 'test', threshold: 0.5 }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(searchChunks)).toHaveBeenCalledWith(mockDb, expect.any(Array), 0.5, 10);
    });
  });

  describe('error handling', () => {
    it('returns error on embed failure', async () => {
      vi.mocked(embedText).mockRejectedValueOnce(new Error('API down'));
      const r = toolResult(await handleSearchChunks({ query: 'test' }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/failed/i);
    });

    it('returns error on RPC failure', async () => {
      vi.mocked(searchChunks).mockRejectedValueOnce(new Error('match_chunks RPC failed'));
      const r = toolResult(await handleSearchChunks({ query: 'test' }, mockDb, mockOpenAI, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/failed/i);
    });
  });
});

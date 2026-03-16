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
  handleArchiveNote,
} from '../mcp/src/tools';
import {
  searchNotes,
  fetchNote,
  fetchNoteLinks,
  listRecentNotes,
  getCaptureVoice,
  findRelatedNotes,
  insertNote,
  insertLinks,
  logEnrichments,
  fetchNoteForArchive,
  archiveNote,
  hardDeleteNote,
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

    it('calls runCaptureAgent with text and related notes and capture voice', async () => {
      vi.mocked(getCaptureVoice).mockResolvedValueOnce('## Voice rules');
      await handleCaptureNote({ raw_input: 'hello' }, mockDb, mockOpenAI, MOCK_CONFIG);
      expect(vi.mocked(runCaptureAgent)).toHaveBeenCalledWith(
        mockOpenAI, MOCK_CONFIG, 'hello', [], '## Voice rules',
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

// ── handleArchiveNote ────────────────────────────────────────────────────────

// Helper: note created N minutes ago
function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 1000).toISOString();
}

describe('handleArchiveNote', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('input validation', () => {
    it('returns error when id is missing', async () => {
      const r = toolResult(await handleArchiveNote({}, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/id is required/);
    });

    it('returns error when id is not a string', async () => {
      const r = toolResult(await handleArchiveNote({ id: 123 }, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(true);
    });

    it('returns error when id fails UUID format', async () => {
      const r = toolResult(await handleArchiveNote({ id: 'not-a-uuid' }, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/Invalid UUID/);
    });
  });

  describe('note lookup', () => {
    it('returns "not found" when note does not exist', async () => {
      vi.mocked(fetchNoteForArchive).mockResolvedValueOnce(null);
      const r = toolResult(await handleArchiveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(true);
      expect(r.content[0]!.text).toMatch(/not found/i);
    });

    it('returns success for already-archived note (idempotent)', async () => {
      vi.mocked(fetchNoteForArchive).mockResolvedValueOnce({
        id: VALID_UUID,
        created_at: minutesAgo(60),
        archived_at: minutesAgo(5),
      });
      const r = toolResult(await handleArchiveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG));
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
      await handleArchiveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG);
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
      const r = toolResult(await handleArchiveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG));
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
      const r = toolResult(await handleArchiveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG));
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
      const r = toolResult(await handleArchiveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG));
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
      const r = toolResult(await handleArchiveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG));
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
      const r = toolResult(await handleArchiveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG));
      const body = JSON.parse(r.content[0]!.text);
      expect(body.archived).toBe(true);
    });
  });

  describe('error handling', () => {
    it('returns toolError when fetchNoteForArchive throws', async () => {
      vi.mocked(fetchNoteForArchive).mockRejectedValueOnce(new Error('DB error'));
      const r = toolResult(await handleArchiveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG));
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
      const r = toolResult(await handleArchiveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG));
      expect(r.isError).toBe(true);
    });

    it('returns toolError when archiveNote throws', async () => {
      vi.mocked(fetchNoteForArchive).mockResolvedValueOnce({
        id: VALID_UUID,
        created_at: minutesAgo(60),
        archived_at: null,
      });
      vi.mocked(archiveNote).mockRejectedValueOnce(new Error('DB error'));
      const r = toolResult(await handleArchiveNote({ id: VALID_UUID }, mockDb, MOCK_CONFIG));
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
      const r = toolResult(await handleArchiveNote({ id: VALID_UUID }, mockDb, shortWindowConfig));
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
      const r = toolResult(await handleArchiveNote({ id: VALID_UUID }, mockDb, longWindowConfig));
      const body = JSON.parse(r.content[0]!.text);
      expect(body.deleted).toBe(true);
      expect(vi.mocked(hardDeleteNote)).toHaveBeenCalledOnce();
    });
  });
});

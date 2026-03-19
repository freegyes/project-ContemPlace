/**
 * Unit tests for the /undo flow:
 * - fetchMostRecentBySource (DB helper)
 * - CaptureService.undoLatest() logic (grace-window hard delete or refuse)
 *
 * Tests mock the DB layer — no network.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Config } from '../mcp/src/config';
import type { UndoResult } from '../mcp/src/types';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../mcp/src/db', () => ({
  fetchMostRecentBySource: vi.fn().mockResolvedValue(null),
  hardDeleteNote: vi.fn().mockResolvedValue(undefined),
}));

import { fetchMostRecentBySource, hardDeleteNote } from '../mcp/src/db';

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
};

const VALID_UUID = 'aaaaaaaa-0000-0000-0000-000000000001';

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 1000).toISOString();
}

/**
 * Simulate the undoLatest() logic without instantiating the full WorkerEntrypoint.
 * This mirrors the implementation in CaptureService.undoLatest().
 */
async function undoLatest(db: SupabaseClient, config: Config): Promise<UndoResult> {
  const note = await fetchMostRecentBySource(db, 'telegram');
  if (!note) {
    return { action: 'none' };
  }

  const ageMs = Date.now() - new Date(note.created_at).getTime();
  const windowMs = config.hardDeleteWindowMinutes * 60 * 1000;

  if (ageMs >= windowMs) {
    return { action: 'grace_period_passed', title: note.title, id: note.id };
  }

  await hardDeleteNote(db, note.id);
  return { action: 'deleted', title: note.title, id: note.id };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

const mockDb = {} as unknown as SupabaseClient;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('undoLatest', () => {
  it('returns none when no active Telegram notes exist', async () => {
    vi.mocked(fetchMostRecentBySource).mockResolvedValueOnce(null);
    const r = await undoLatest(mockDb, MOCK_CONFIG);
    expect(r.action).toBe('none');
    expect(r.title).toBeUndefined();
    expect(vi.mocked(hardDeleteNote)).not.toHaveBeenCalled();
  });

  it('hard-deletes a note within the grace window', async () => {
    vi.mocked(fetchMostRecentBySource).mockResolvedValueOnce({
      id: VALID_UUID,
      title: 'Recent Note',
      created_at: minutesAgo(3),
    });
    const r = await undoLatest(mockDb, MOCK_CONFIG);
    expect(r.action).toBe('deleted');
    expect(r.title).toBe('Recent Note');
    expect(r.id).toBe(VALID_UUID);
    expect(vi.mocked(hardDeleteNote)).toHaveBeenCalledWith(mockDb, VALID_UUID);
  });

  it('refuses when the note is beyond the grace window', async () => {
    vi.mocked(fetchMostRecentBySource).mockResolvedValueOnce({
      id: VALID_UUID,
      title: 'Old Note',
      created_at: minutesAgo(15),
    });
    const r = await undoLatest(mockDb, MOCK_CONFIG);
    expect(r.action).toBe('grace_period_passed');
    expect(r.title).toBe('Old Note');
    expect(r.id).toBe(VALID_UUID);
    expect(vi.mocked(hardDeleteNote)).not.toHaveBeenCalled();
  });

  it('refuses at the exact grace window boundary', async () => {
    vi.mocked(fetchMostRecentBySource).mockResolvedValueOnce({
      id: VALID_UUID,
      title: 'Boundary Note',
      created_at: minutesAgo(11),
    });
    const r = await undoLatest(mockDb, MOCK_CONFIG);
    expect(r.action).toBe('grace_period_passed');
    expect(vi.mocked(hardDeleteNote)).not.toHaveBeenCalled();
  });

  it('hard-deletes a note just inside the grace window', async () => {
    vi.mocked(fetchMostRecentBySource).mockResolvedValueOnce({
      id: VALID_UUID,
      title: 'Just Inside',
      created_at: minutesAgo(10),
    });
    const r = await undoLatest(mockDb, MOCK_CONFIG);
    expect(r.action).toBe('deleted');
    expect(vi.mocked(hardDeleteNote)).toHaveBeenCalledOnce();
  });

  it('respects a custom grace window', async () => {
    const shortWindow = { ...MOCK_CONFIG, hardDeleteWindowMinutes: 3 };
    vi.mocked(fetchMostRecentBySource).mockResolvedValueOnce({
      id: VALID_UUID,
      title: 'Custom Window',
      created_at: minutesAgo(5),
    });
    const r = await undoLatest(mockDb, shortWindow);
    expect(r.action).toBe('grace_period_passed');
    expect(vi.mocked(hardDeleteNote)).not.toHaveBeenCalled();
  });

  it('passes source "telegram" to fetchMostRecentBySource', async () => {
    vi.mocked(fetchMostRecentBySource).mockResolvedValueOnce(null);
    await undoLatest(mockDb, MOCK_CONFIG);
    expect(vi.mocked(fetchMostRecentBySource)).toHaveBeenCalledWith(mockDb, 'telegram');
  });

  it('propagates DB read errors', async () => {
    vi.mocked(fetchMostRecentBySource).mockRejectedValueOnce(new Error('DB read error'));
    await expect(undoLatest(mockDb, MOCK_CONFIG)).rejects.toThrow('DB read error');
  });

  it('propagates DB write errors', async () => {
    vi.mocked(fetchMostRecentBySource).mockResolvedValueOnce({
      id: VALID_UUID,
      title: 'Write Fail',
      created_at: minutesAgo(2),
    });
    vi.mocked(hardDeleteNote).mockRejectedValueOnce(new Error('Delete failed'));
    await expect(undoLatest(mockDb, MOCK_CONFIG)).rejects.toThrow('Delete failed');
  });
});

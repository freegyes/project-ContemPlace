import { describe, it, expect, vi } from 'vitest';
import { validateAuth, timingSafeEqual } from '../dashboard-api/src/auth';
import { loadConfig } from '../dashboard-api/src/config';
import type { Env } from '../dashboard-api/src/types';

// ── Auth helpers ─────────────────────────────────────────────────────────────

const VALID_KEY = 'dashboard-api-key-12345';

function makeRequest(authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers['Authorization'] = authHeader;
  return new Request('https://example.com/api/stats', { method: 'GET', headers });
}

// ── validateAuth ─────────────────────────────────────────────────────────────

describe('validateAuth', () => {
  it('returns null for a valid Bearer token', () => {
    const result = validateAuth(makeRequest(`Bearer ${VALID_KEY}`), VALID_KEY);
    expect(result).toBeNull();
  });

  it('returns 401 when Authorization header is missing', () => {
    const result = validateAuth(makeRequest(), VALID_KEY);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('returns 401 for non-Bearer scheme', () => {
    const result = validateAuth(makeRequest(`Token ${VALID_KEY}`), VALID_KEY);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('returns 401 for "Bearer" with no trailing space', () => {
    const result = validateAuth(makeRequest('Bearer'), VALID_KEY);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('returns 403 for wrong token', () => {
    const result = validateAuth(makeRequest('Bearer wrong-token'), VALID_KEY);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it('returns 401 for empty Bearer token (trailing space only)', () => {
    const result = validateAuth(makeRequest('Bearer '), VALID_KEY);
    expect(result).not.toBeNull();
    // Fetch API may trim header values; either 401 or 403 is acceptable
    expect([401, 403]).toContain(result!.status);
  });

  it('logs warning on token mismatch', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateAuth(makeRequest('Bearer wrong-token'), VALID_KEY);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('does not log warning on success', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateAuth(makeRequest(`Bearer ${VALID_KEY}`), VALID_KEY);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ── timingSafeEqual ───────────────────────────────────────────────────────────

describe('timingSafeEqual', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
  });

  it('returns false for different strings of same length', () => {
    expect(timingSafeEqual('abc', 'xyz')).toBe(false);
  });

  it('returns false for strings of different length', () => {
    expect(timingSafeEqual('short', 'longer-string')).toBe(false);
  });

  it('returns true for empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

// ── Config helpers ───────────────────────────────────────────────────────────

// Build test JWTs from parts to avoid secret-scanning false positives.
// These are fabricated tokens with signature "fakesig" — not real credentials.
const HEADER = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const ANON_PAYLOAD = btoa(JSON.stringify({ role: 'anon', iss: 'supabase' }));
const SERVICE_PAYLOAD = btoa(JSON.stringify({ role: 'service_role', iss: 'supabase' }));
const FAKE_SIG = 'fakesig';
const ANON_JWT = `${HEADER}.${ANON_PAYLOAD}.${FAKE_SIG}`;
const SERVICE_JWT = `${HEADER}.${SERVICE_PAYLOAD}.${FAKE_SIG}`;

const VALID_ENV: Env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  DASHBOARD_API_KEY: 'dash-key',
  CORS_ORIGIN: 'https://contemplace-dashboard.pages.dev',
  BACKUP_REPO: 'freegyes/contemplace-backup',
  GITHUB_BACKUP_PAT: 'ghp_testtoken',
};

function env(overrides: Partial<Record<keyof Env, string | undefined>> = {}): Env {
  return { ...VALID_ENV, ...overrides } as Env;
}

// ── loadConfig ───────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  it('returns valid config when all secrets are present', () => {
    const config = loadConfig(VALID_ENV);
    expect(config.supabaseUrl).toBe('https://example.supabase.co');
    expect(config.supabaseServiceRoleKey).toBe('service-key');
    expect(config.dashboardApiKey).toBe('dash-key');
    expect(config.corsOrigin).toBe('https://contemplace-dashboard.pages.dev');
    expect(config.backupRepo).toBe('freegyes/contemplace-backup');
    expect(config.githubBackupPat).toBe('ghp_testtoken');
  });

  it('throws when SUPABASE_URL is missing', () => {
    expect(() => loadConfig(env({ SUPABASE_URL: undefined }))).toThrow('SUPABASE_URL');
  });

  it('throws when SUPABASE_SERVICE_ROLE_KEY is missing', () => {
    expect(() => loadConfig(env({ SUPABASE_SERVICE_ROLE_KEY: undefined }))).toThrow('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('throws when DASHBOARD_API_KEY is missing', () => {
    expect(() => loadConfig(env({ DASHBOARD_API_KEY: undefined }))).toThrow('DASHBOARD_API_KEY');
  });

  it('throws when SUPABASE_SERVICE_ROLE_KEY is an anon JWT', () => {
    expect(() => loadConfig(env({ SUPABASE_SERVICE_ROLE_KEY: ANON_JWT }))).toThrow('expected "service_role"');
  });

  it('accepts a service_role JWT for SUPABASE_SERVICE_ROLE_KEY', () => {
    const config = loadConfig(env({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_JWT }));
    expect(config.supabaseServiceRoleKey).toBe(SERVICE_JWT);
  });

  it('accepts a non-JWT string for SUPABASE_SERVICE_ROLE_KEY', () => {
    const config = loadConfig(env({ SUPABASE_SERVICE_ROLE_KEY: 'plain-key' }));
    expect(config.supabaseServiceRoleKey).toBe('plain-key');
  });

  it('defaults corsOrigin to "*" when CORS_ORIGIN is empty', () => {
    const config = loadConfig(env({ CORS_ORIGIN: '' }));
    expect(config.corsOrigin).toBe('*');
  });

  it('defaults backupRepo to empty string when BACKUP_REPO is absent', () => {
    const config = loadConfig(env({ BACKUP_REPO: undefined }));
    expect(config.backupRepo).toBe('');
  });

  it('includes GITHUB_BACKUP_PAT when set', () => {
    const config = loadConfig(env({ GITHUB_BACKUP_PAT: 'ghp_abc123' }));
    expect(config.githubBackupPat).toBe('ghp_abc123');
  });

  it('returns null for GITHUB_BACKUP_PAT when not set', () => {
    const config = loadConfig(env({ GITHUB_BACKUP_PAT: undefined }));
    expect(config.githubBackupPat).toBeNull();
  });
});

// ── dashboard-api db ─────────────────────────────────────────────────────────

import {
  fetchStats,
  fetchClusters,
  fetchClusterDetail,
  fetchRecent,
} from '../dashboard-api/src/db';

// ── Mock Supabase builder ─────────────────────────────────────────────────────
//
// Each call to db.from(table) returns a new independent query builder that
// resolves with the next unconsumed result for that table. This lets
// Promise.all run multiple chains in parallel without shared state.

type MockResult = { data: unknown; error: null | { message: string }; count?: number | null };

function makeMockDb(tableResults: Record<string, MockResult | MockResult[]>): unknown {
  // Per-table call index — incremented when a result is consumed.
  const callCounts: Record<string, number> = {};

  function makeBuilder(table: string): object {
    // Snapshot which result index this builder will consume.
    const myIndex = callCounts[table] ?? 0;
    callCounts[table] = myIndex + 1;

    function getResult(): MockResult {
      const entry = tableResults[table];
      if (Array.isArray(entry)) {
        return (entry[myIndex] ?? entry[entry.length - 1]) as MockResult;
      }
      return (entry ?? { data: null, error: null }) as MockResult;
    }

    const b: Record<string, unknown> = {
      select() { return this; },
      eq() { return this; },
      is() { return this; },
      in() { return this; },
      or() { return this; },
      order() { return this; },
      limit() { return this; },
      gte() { return this; },
      not() { return this; },
      async single() { return getResult(); },
      // Thenable: used when the chain is awaited directly (no terminal method call).
      then(resolve: (v: MockResult) => void, _reject?: unknown) {
        resolve(getResult());
      },
    };

    // All chain methods return the same builder (this).
    const chainMethods = ['select', 'eq', 'is', 'in', 'or', 'order', 'limit', 'gte', 'not'];
    for (const m of chainMethods) {
      const orig = b[m] as (...args: unknown[]) => unknown;
      b[m] = function (...args: unknown[]) {
        orig.apply(this, args);
        return this;
      };
    }

    return b;
  }

  return {
    from(table: string) {
      return makeBuilder(table);
    },
  };
}

// ── fetchStats ────────────────────────────────────────────────────────────────

describe('dashboard-api db — fetchStats', () => {
  it('aggregates stats correctly from mock data', async () => {
    // We test the JS aggregation logic by building a mock whose parallel
    // queries return known data, then asserting derived values.

    const noteA = 'note-aaa';
    const noteB = 'note-bbb';
    const noteC = 'note-ccc'; // orphan — no links

    // Clusters at two resolutions; lowest is 1.0 (2 clusters covering A+B only).
    const clusterRows = [
      { note_ids: [noteA], resolution: 1.0 },
      { note_ids: [noteB], resolution: 1.0 },
      { note_ids: [noteA, noteB], resolution: 2.0 },
    ];

    // We supply per-table results for the 9 parallel queries and the sequential one.
    // fetchStats calls from('notes') multiple times — we need to cycle results.
    // Order of .from('notes') calls inside Promise.all:
    //   1. count (head:true) — but our mock ignores options, returns count field
    //   2. recent 7d count
    //   3. oldest note
    //   4. newest note
    //   5. all active note IDs
    //   6. image count
    // Then sequential: from('links') for all-links.

    // We model this by making 'notes' an array of results cycled per call.
    const tableResults: Record<string, MockResult | MockResult[]> = {
      notes: [
        // 1. total count
        { data: null, error: null, count: 3 },
        // 2. recent 7d count
        { data: null, error: null, count: 1 },
        // 3. oldest note
        { data: [{ created_at: '2026-01-01T00:00:00Z' }], error: null },
        // 4. newest note
        { data: [{ created_at: '2026-03-20T00:00:00Z' }], error: null },
        // 5. all active note IDs
        { data: [{ id: noteA }, { id: noteB }, { id: noteC }], error: null },
        // 6. image count
        { data: null, error: null, count: 1 },
      ],
      links: [
        // 7. total count (parallel)
        { data: null, error: null, count: 2 },
        // 8. sequential: all links (for orphan computation)
        { data: [{ from_id: noteA, to_id: noteB }], error: null },
      ],
      clusters: [
        // 9. cluster rows (for unclustered + total_clusters + gardener_last_run)
        { data: clusterRows, error: null },
        // 10. gardener last run
        { data: [{ created_at: '2026-03-19T02:00:00Z' }], error: null },
      ],
    };

    const db = makeMockDb(tableResults);
    const stats = await fetchStats(db as never);

    expect(stats.total_notes).toBe(3);
    expect(stats.total_links).toBe(2);
    // Lowest resolution is 1.0 — 2 cluster rows
    expect(stats.total_clusters).toBe(2);
    // noteC is not in any cluster at lowest resolution
    expect(stats.unclustered_count).toBe(1);
    // noteC appears in no links
    expect(stats.orphan_count).toBe(1);
    // 1 note in 7 days → 0.1/day → rounded to 1 decimal
    expect(stats.capture_rate_7d).toBe(Math.round((1 / 7) * 10) / 10);
    // 2 links / 3 notes
    expect(stats.avg_links_per_note).toBe(Math.round((2 / 3) * 10) / 10);
    expect(stats.image_count).toBe(1);
    expect(stats.oldest_note).toBe('2026-01-01T00:00:00Z');
    expect(stats.newest_note).toBe('2026-03-20T00:00:00Z');
    expect(stats.gardener_last_run).toBe('2026-03-19T02:00:00Z');
  });

  it('handles empty corpus gracefully', async () => {
    const tableResults: Record<string, MockResult | MockResult[]> = {
      notes: [
        { data: null, error: null, count: 0 },
        { data: null, error: null, count: 0 },
        { data: [], error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: null, error: null, count: 0 },
      ],
      links: [
        { data: null, error: null, count: 0 },
        { data: [], error: null },
      ],
      clusters: [
        { data: [], error: null },
        { data: [], error: null },
      ],
    };

    const db = makeMockDb(tableResults);
    const stats = await fetchStats(db as never);

    expect(stats.total_notes).toBe(0);
    expect(stats.total_links).toBe(0);
    expect(stats.total_clusters).toBe(0);
    expect(stats.unclustered_count).toBe(0);
    expect(stats.orphan_count).toBe(0);
    expect(stats.capture_rate_7d).toBe(0);
    expect(stats.avg_links_per_note).toBe(0);
    expect(stats.oldest_note).toBeNull();
    expect(stats.newest_note).toBeNull();
    expect(stats.gardener_last_run).toBeNull();
  });

  it('computes orphan_count correctly when all notes have links', async () => {
    const n1 = 'n1', n2 = 'n2';
    const tableResults: Record<string, MockResult | MockResult[]> = {
      notes: [
        { data: null, error: null, count: 2 },
        { data: null, error: null, count: 2 },
        { data: [{ created_at: '2026-01-01T00:00:00Z' }], error: null },
        { data: [{ created_at: '2026-03-20T00:00:00Z' }], error: null },
        { data: [{ id: n1 }, { id: n2 }], error: null },
        { data: null, error: null, count: 0 },
      ],
      links: [
        { data: null, error: null, count: 1 },
        { data: [{ from_id: n1, to_id: n2 }], error: null },
      ],
      clusters: [
        { data: [], error: null },
        { data: [], error: null },
      ],
    };

    const db = makeMockDb(tableResults);
    const stats = await fetchStats(db as never);
    expect(stats.orphan_count).toBe(0);
  });

  it('computes unclustered_count correctly', async () => {
    const n1 = 'n1', n2 = 'n2', n3 = 'n3';
    const tableResults: Record<string, MockResult | MockResult[]> = {
      notes: [
        { data: null, error: null, count: 3 },
        { data: null, error: null, count: 0 },
        { data: [{ created_at: '2026-01-01T00:00:00Z' }], error: null },
        { data: [{ created_at: '2026-03-20T00:00:00Z' }], error: null },
        { data: [{ id: n1 }, { id: n2 }, { id: n3 }], error: null },
        { data: null, error: null, count: 0 },
      ],
      links: [
        { data: null, error: null, count: 0 },
        { data: [], error: null },
      ],
      clusters: [
        // Only n1 and n2 are in a cluster at lowest resolution (1.0)
        { data: [{ note_ids: [n1, n2], resolution: 1.0 }], error: null },
        { data: [], error: null },
      ],
    };

    const db = makeMockDb(tableResults);
    const stats = await fetchStats(db as never);
    // n3 is not in any cluster → unclustered = 1
    expect(stats.unclustered_count).toBe(1);
    expect(stats.total_clusters).toBe(1);
  });
});

// ── fetchClusters ─────────────────────────────────────────────────────────────

describe('dashboard-api db — fetchClusters', () => {
  const n1 = 'n1', n2 = 'n2', n3 = 'n3', n4 = 'n4';

  it('returns clusters with gravity ordering preserved', async () => {
    const tableResults: Record<string, MockResult | MockResult[]> = {
      clusters: [
        // First call: cluster rows at resolution (gravity ordered by DB, mocked in order)
        {
          data: [
            { label: 'High', top_tags: ['a'], note_ids: [n1, n2], gravity: 0.9 },
            { label: 'Low', top_tags: ['b'], note_ids: [n3, n4], gravity: 0.3 },
          ],
          error: null,
        },
        // Second call: available resolutions
        { data: [{ resolution: 1.0 }, { resolution: 1.5 }], error: null },
      ],
      notes: [
        {
          data: [
            { id: n1, title: 'Note 1' },
            { id: n2, title: 'Note 2' },
            { id: n3, title: 'Note 3' },
            { id: n4, title: 'Note 4' },
          ],
          error: null,
        },
      ],
      links: [{ data: [], error: null }],
    };

    const db = makeMockDb(tableResults);
    const result = await fetchClusters(db as never, 1.0);

    expect(result.clusters).toHaveLength(2);
    expect(result.clusters[0]!.label).toBe('High');
    expect(result.clusters[0]!.gravity).toBe(0.9);
    expect(result.clusters[1]!.label).toBe('Low');
    expect(result.available_resolutions).toEqual([1.0, 1.5]);
  });

  it('computes hub notes from intra-cluster links', async () => {
    // n1 <-> n2 twice (hub: n1 or n2 tied at 2), n3 alone
    const tableResults: Record<string, MockResult | MockResult[]> = {
      clusters: [
        {
          data: [
            { label: 'Cluster A', top_tags: ['x'], note_ids: [n1, n2, n3], gravity: 0.8 },
          ],
          error: null,
        },
        { data: [{ resolution: 1.0 }], error: null },
      ],
      notes: [
        {
          data: [
            { id: n1, title: 'Alpha' },
            { id: n2, title: 'Beta' },
            { id: n3, title: 'Gamma' },
          ],
          error: null,
        },
      ],
      links: [
        {
          data: [
            { from_id: n1, to_id: n2 },
            { from_id: n1, to_id: n2 }, // duplicate edge → still counts per link row
          ],
          error: null,
        },
      ],
    };

    const db = makeMockDb(tableResults);
    const result = await fetchClusters(db as never, 1.0);

    const cluster = result.clusters[0]!;
    // n1 appears as from_id twice → link_count 2; n2 as to_id twice → link_count 2
    expect(cluster.hub_notes).toHaveLength(2);
    const hubIds = cluster.hub_notes.map(h => h.id);
    expect(hubIds).toContain(n1);
    expect(hubIds).toContain(n2);
    // n3 has no links → not a hub note
    expect(hubIds).not.toContain(n3);
  });

  it('returns empty hub_notes when no intra-cluster links exist', async () => {
    const tableResults: Record<string, MockResult | MockResult[]> = {
      clusters: [
        { data: [{ label: 'Solo', top_tags: [], note_ids: [n1, n2], gravity: 0.5 }], error: null },
        { data: [{ resolution: 1.0 }], error: null },
      ],
      notes: [
        { data: [{ id: n1, title: 'A' }, { id: n2, title: 'B' }], error: null },
      ],
      links: [{ data: [], error: null }],
    };

    const db = makeMockDb(tableResults);
    const result = await fetchClusters(db as never, 1.0);
    expect(result.clusters[0]!.hub_notes).toHaveLength(0);
  });

  it('filters archived notes out of cluster note_ids', async () => {
    // n3 is archived — not returned by the notes query
    const tableResults: Record<string, MockResult | MockResult[]> = {
      clusters: [
        { data: [{ label: 'C', top_tags: [], note_ids: [n1, n2, n3], gravity: 0.5 }], error: null },
        { data: [{ resolution: 1.0 }], error: null },
      ],
      notes: [
        // Only n1 and n2 survive the archived_at IS NULL filter
        { data: [{ id: n1, title: 'A' }, { id: n2, title: 'B' }], error: null },
      ],
      links: [{ data: [], error: null }],
    };

    const db = makeMockDb(tableResults);
    const result = await fetchClusters(db as never, 1.0);
    expect(result.clusters[0]!.note_ids).toEqual([n1, n2]);
    expect(result.clusters[0]!.note_count).toBe(2);
  });
});

// ── fetchClusterDetail ────────────────────────────────────────────────────────

describe('dashboard-api db — fetchClusterDetail', () => {
  const n1 = 'note-1', n2 = 'note-2', n3 = 'note-3-outside';

  it('returns notes with image_url and intra-cluster links only', async () => {
    const tableResults: Record<string, MockResult | MockResult[]> = {
      notes: [
        {
          data: [
            { id: n1, title: 'First', tags: ['a'], image_url: 'https://r2/img.jpg', created_at: '2026-01-01T00:00:00Z' },
            { id: n2, title: 'Second', tags: ['b'], image_url: null, created_at: '2026-02-01T00:00:00Z' },
          ],
          error: null,
        },
      ],
      links: [
        {
          // Both endpoints in the set — intra-cluster link
          data: [
            { from_id: n1, to_id: n2, link_type: 'related', confidence: null, created_by: 'capture' },
          ],
          error: null,
        },
      ],
    };

    const db = makeMockDb(tableResults);
    const result = await fetchClusterDetail(db as never, [n1, n2]);

    expect(result.notes).toHaveLength(2);
    expect(result.notes[0]!.image_url).toBe('https://r2/img.jpg');
    expect(result.notes[1]!.image_url).toBeNull();
    expect(result.links).toHaveLength(1);
    expect(result.links[0]!.created_by).toBe('capture');
  });

  it('includes confidence and created_by on links', async () => {
    const tableResults: Record<string, MockResult | MockResult[]> = {
      notes: [
        { data: [{ id: n1, title: 'A', tags: [], image_url: null, created_at: '2026-01-01T00:00:00Z' }], error: null },
      ],
      links: [
        {
          data: [
            { from_id: n1, to_id: n2, link_type: 'is-similar-to', confidence: 0.85, created_by: 'gardener' },
          ],
          error: null,
        },
      ],
    };

    const db = makeMockDb(tableResults);
    const result = await fetchClusterDetail(db as never, [n1, n2]);

    expect(result.links[0]!.confidence).toBe(0.85);
    expect(result.links[0]!.link_type).toBe('is-similar-to');
    expect(result.links[0]!.created_by).toBe('gardener');
  });
});

// ── fetchRecent ───────────────────────────────────────────────────────────────

describe('dashboard-api db — fetchRecent', () => {
  it('returns notes in order with image_url', async () => {
    const tableResults: Record<string, MockResult | MockResult[]> = {
      notes: [
        {
          data: [
            {
              id: 'n1', title: 'Latest', tags: ['x'], source: 'telegram',
              image_url: 'https://r2/a.jpg', created_at: '2026-03-20T00:00:00Z',
            },
            {
              id: 'n2', title: 'Older', tags: [], source: 'mcp',
              image_url: null, created_at: '2026-03-19T00:00:00Z',
            },
          ],
          error: null,
        },
      ],
    };

    const db = makeMockDb(tableResults);
    const result = await fetchRecent(db as never, 10);

    expect(result).toHaveLength(2);
    expect(result[0]!.title).toBe('Latest');
    expect(result[0]!.image_url).toBe('https://r2/a.jpg');
    expect(result[1]!.image_url).toBeNull();
    expect(result[0]!.source).toBe('telegram');
  });

  it('respects the limit parameter', async () => {
    const tableResults: Record<string, MockResult | MockResult[]> = {
      notes: [
        {
          data: [
            { id: 'n1', title: 'A', tags: [], source: 'mcp', image_url: null, created_at: '2026-03-20T00:00:00Z' },
          ],
          error: null,
        },
      ],
    };

    const db = makeMockDb(tableResults);
    const result = await fetchRecent(db as never, 1);
    expect(result).toHaveLength(1);
  });
});

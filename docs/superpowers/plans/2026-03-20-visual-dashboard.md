# Visual Dashboard Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a read-only visual dashboard (API Worker + static SPA) for exploring the ContemPlace knowledge graph — clusters, links, images, and system health.

**Architecture:** New Dashboard API Worker (`contemplace-dashboard-api`) serves JSON endpoints over Bearer token auth. Vanilla HTML/CSS/JS SPA on Cloudflare Pages consumes the API. Cytoscape.js (CDN via import map) renders force-directed cluster graphs. Modular ES module structure for extensibility.

**Tech Stack:** Cloudflare Workers (TypeScript), Cloudflare Pages (static), Supabase (Postgres), Cytoscape.js, GitHub API (backup check)

**Issue:** #101

**Prerequisites:** Create branch `feat/visual-dashboard` from `main` before starting. The branch should already exist when executing this plan.

**Local dev note:** ES module `<script type="module">` imports fail when opening `index.html` from `file://` due to CORS. Use `npx wrangler pages dev dashboard/` for local testing.

---

## File Structure

```
dashboard-api/
  wrangler.toml          # Worker config: name, vars (CORS_ORIGIN, BACKUP_REPO), secrets ref
  tsconfig.json          # TypeScript config (same pattern as gardener/)
  src/
    index.ts             # Worker entry: route dispatch, CORS, auth gate
    auth.ts              # timingSafeEqual + validateAuth (adapted from mcp/src/auth.ts)
    config.ts            # loadConfig with service role key validation
    db.ts                # Supabase queries: stats, clusters, cluster detail, recent
    github.ts            # GitHub API: backup recency check with in-memory cache
    types.ts             # Env interface, API response types

dashboard/
  index.html             # Layout skeleton + inline CSS (dark theme, CSS grid)
  js/
    app.js               # API client (fetch + Bearer auth + 10s timeout), panel init
    stats.js             # Stats bar: vanity numbers + health indicator dots
    clusters.js          # Cluster grid: cards, resolution selector, Cytoscape expand
    recent.js            # Recent captures: chronological list with image indicators

tests/
  dashboard-api.test.ts  # Unit tests: auth, config, db queries, health thresholds, CORS
  dashboard-smoke.test.ts # Smoke tests: hit live endpoints, verify response shapes
```

**Modified files:**
- `scripts/deploy.sh` — add typecheck, API Worker deploy, Pages deploy steps
- `CLAUDE.md` — project layout, architecture table, env vars, commands
- `docs/architecture.md` — 4th Worker section
- `docs/setup.md` — new secrets, Pages project creation
- `docs/development.md` — test file listing, deploy commands
- `docs/decisions.md` — ADR entry

---

## Chunk 1: Dashboard API Worker

### Task 1: Scaffold the API Worker

**Files:**
- Create: `dashboard-api/wrangler.toml`
- Create: `dashboard-api/tsconfig.json`
- Create: `dashboard-api/src/types.ts`

- [ ] **Step 1: Create `dashboard-api/wrangler.toml`**

```toml
name = "contemplace-dashboard-api"
main = "src/index.ts"
compatibility_date = "2024-04-03"
compatibility_flags = ["nodejs_compat"]

[vars]
CORS_ORIGIN = "https://contemplace-dashboard.pages.dev"
BACKUP_REPO = "freegyes/contemplace-backup"

# Secrets (set via: wrangler secret put <NAME> -c dashboard-api/wrangler.toml):
# SUPABASE_URL
# SUPABASE_SERVICE_ROLE_KEY
# DASHBOARD_API_KEY
# GITHUB_BACKUP_PAT        (optional — enables backup freshness metric)
```

- [ ] **Step 2: Create `dashboard-api/tsconfig.json`**

Same pattern as `gardener/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "outDir": "dist"
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `dashboard-api/src/types.ts`**

```typescript
// ── Dashboard API Worker Env ────────────────────────────────────────────────

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  DASHBOARD_API_KEY: string;
  CORS_ORIGIN: string;
  BACKUP_REPO: string;
  GITHUB_BACKUP_PAT?: string;
}

// ── API response types ──────────────────────────────────────────────────────

export interface StatsResponse {
  total_notes: number;
  total_links: number;
  total_clusters: number;
  unclustered_count: number;
  image_count: number;
  capture_rate_7d: number;
  oldest_note: string | null;
  newest_note: string | null;
  orphan_count: number;
  avg_links_per_note: number;
  gardener_last_run: string | null;
  backup_last_commit: string | null;
}

export interface ClusterCard {
  label: string;
  top_tags: string[];
  note_count: number;
  gravity: number;
  note_ids: string[];
  hub_notes: Array<{ id: string; title: string; link_count: number }>;
}

export interface ClustersResponse {
  resolution: number;
  available_resolutions: number[];
  clusters: ClusterCard[];
}

export interface ClusterDetailNote {
  id: string;
  title: string;
  tags: string[];
  image_url: string | null;
  created_at: string;
}

export interface ClusterDetailLink {
  from_id: string;
  to_id: string;
  link_type: string;
  confidence: number | null;
  created_by: string;
}

export interface ClusterDetailResponse {
  notes: ClusterDetailNote[];
  links: ClusterDetailLink[];
}

export interface RecentNote {
  id: string;
  title: string;
  tags: string[];
  source: string;
  image_url: string | null;
  created_at: string;
}

export interface Config {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  dashboardApiKey: string;
  corsOrigin: string;
  backupRepo: string;
  githubBackupPat: string | null;
}
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p dashboard-api/tsconfig.json`
Expected: PASS (no errors)

- [ ] **Step 5: Commit**

```bash
git add dashboard-api/
git commit -m "feat(dashboard-api): scaffold Worker with types and config files

refs #101"
```

---

### Task 2: Auth and config modules

**Files:**
- Create: `dashboard-api/src/auth.ts`
- Create: `dashboard-api/src/config.ts`
- Create: `tests/dashboard-api.test.ts` (auth + config sections)

- [ ] **Step 1: Write auth tests**

In `tests/dashboard-api.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { validateAuth } from '../dashboard-api/src/auth';
import { loadConfig } from '../dashboard-api/src/config';
import type { Env } from '../dashboard-api/src/types';

const VALID_KEY = 'test-dashboard-api-key';

function makeRequest(method: string, path: string, authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers['Authorization'] = authHeader;
  return new Request(`https://example.com${path}`, { method, headers });
}

describe('dashboard-api auth', () => {
  it('returns null for valid Bearer token', () => {
    const result = validateAuth(makeRequest('GET', '/stats', `Bearer ${VALID_KEY}`), VALID_KEY);
    expect(result).toBeNull();
  });

  it('returns 401 when Authorization header is missing', () => {
    const result = validateAuth(makeRequest('GET', '/stats'), VALID_KEY);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('returns 401 for non-Bearer scheme', () => {
    const result = validateAuth(makeRequest('GET', '/stats', `Token ${VALID_KEY}`), VALID_KEY);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('returns 403 for wrong token', () => {
    const result = validateAuth(makeRequest('GET', '/stats', 'Bearer wrong'), VALID_KEY);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });
});
```

- [ ] **Step 2: Write auth module**

In `dashboard-api/src/auth.ts` — adapted from `mcp/src/auth.ts`, takes the key as a parameter instead of reading from Env:

```typescript
/**
 * Constant-time string comparison.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;

  if (typeof crypto !== 'undefined' && crypto.subtle && typeof (crypto.subtle as unknown as Record<string, unknown>)['timingSafeEqual'] === 'function') {
    return crypto.subtle.timingSafeEqual(bufA, bufB);
  }

  let result = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    result |= bufA[i]! ^ bufB[i]!;
  }
  return result === 0;
}

/**
 * Validate Bearer token auth. Returns error Response or null if OK.
 */
export function validateAuth(request: Request, apiKey: string): Response | null {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 });
  }
  const token = authHeader.slice(7);
  if (!token || !timingSafeEqual(token, apiKey)) {
    console.warn(JSON.stringify({ event: 'auth_failed', reason: 'invalid_token' }));
    return new Response('Forbidden', { status: 403 });
  }
  return null;
}
```

- [ ] **Step 3: Write config tests**

Append to `tests/dashboard-api.test.ts`:

```typescript
// Build test JWTs (same pattern as mcp-config.test.ts)
const HEADER = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const ANON_PAYLOAD = btoa(JSON.stringify({ role: 'anon', iss: 'supabase' }));
const SERVICE_PAYLOAD = btoa(JSON.stringify({ role: 'service_role', iss: 'supabase' }));
const FAKE_SIG = 'fakesig';
const ANON_JWT = `${HEADER}.${ANON_PAYLOAD}.${FAKE_SIG}`;
const SERVICE_JWT = `${HEADER}.${SERVICE_PAYLOAD}.${FAKE_SIG}`;

const VALID_ENV: Env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  DASHBOARD_API_KEY: 'dashboard-key',
  CORS_ORIGIN: 'https://contemplace-dashboard.pages.dev',
  BACKUP_REPO: 'owner/repo',
};

function env(overrides: Partial<Record<string, string | undefined>> = {}): Env {
  return { ...VALID_ENV, ...overrides } as unknown as Env;
}

describe('dashboard-api config', () => {
  it('returns valid config when all secrets present', () => {
    const config = loadConfig(VALID_ENV);
    expect(config.supabaseUrl).toBe('https://example.supabase.co');
    expect(config.dashboardApiKey).toBe('dashboard-key');
    expect(config.corsOrigin).toBe('https://contemplace-dashboard.pages.dev');
    expect(config.githubBackupPat).toBeNull();
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

  it('throws when SUPABASE_SERVICE_ROLE_KEY is anon JWT', () => {
    expect(() => loadConfig(env({ SUPABASE_SERVICE_ROLE_KEY: ANON_JWT }))).toThrow('service_role');
  });

  it('accepts service_role JWT', () => {
    const config = loadConfig(env({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_JWT }));
    expect(config.supabaseServiceRoleKey).toBe(SERVICE_JWT);
  });

  it('includes GITHUB_BACKUP_PAT when set', () => {
    const config = loadConfig(env({ GITHUB_BACKUP_PAT: 'ghp_test' }));
    expect(config.githubBackupPat).toBe('ghp_test');
  });
});
```

- [ ] **Step 4: Write config module**

In `dashboard-api/src/config.ts`:

```typescript
import type { Env, Config } from './types';

export function loadConfig(env: Env): Config {
  const supabaseServiceRoleKey = requireSecret(env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY');
  validateServiceRoleKey(supabaseServiceRoleKey);
  return {
    supabaseUrl: requireSecret(env.SUPABASE_URL, 'SUPABASE_URL'),
    supabaseServiceRoleKey,
    dashboardApiKey: requireSecret(env.DASHBOARD_API_KEY, 'DASHBOARD_API_KEY'),
    corsOrigin: env.CORS_ORIGIN || '*',
    backupRepo: env.BACKUP_REPO || '',
    githubBackupPat: env.GITHUB_BACKUP_PAT || null,
  };
}

function requireSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing required secret: ${name}`);
  return value;
}

function validateServiceRoleKey(key: string): void {
  const parts = key.split('.');
  if (parts.length !== 3) return;
  try {
    const payload = parts[1];
    if (!payload) return;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json);
    if (claims.role && claims.role !== 'service_role') {
      throw new Error(
        `SUPABASE_SERVICE_ROLE_KEY has role "${claims.role}" — expected "service_role".`
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('SUPABASE_SERVICE_ROLE_KEY')) throw e;
  }
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/dashboard-api.test.ts`
Expected: All auth + config tests PASS

- [ ] **Step 6: Typecheck**

Run: `npx tsc --noEmit -p dashboard-api/tsconfig.json`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add dashboard-api/src/auth.ts dashboard-api/src/config.ts tests/dashboard-api.test.ts
git commit -m "feat(dashboard-api): auth and config modules with tests

refs #101"
```

---

### Task 3: Database queries

**Files:**
- Create: `dashboard-api/src/db.ts`
- Modify: `tests/dashboard-api.test.ts` (add db tests)

- [ ] **Step 1: Write db query tests**

Append to `tests/dashboard-api.test.ts`. Mock the Supabase client at the module level. Test each query function: `fetchStats`, `fetchClusters`, `fetchClusterDetail`, `fetchRecent`.

Key test cases for each function:
- `fetchStats`: correct aggregation from mock data, derives `avg_links_per_note` and `capture_rate_7d` correctly, returns `image_count`
- `fetchClusters`: gravity ordering, hub note computation (top 2 by intra-cluster link count), `available_resolutions` included
- `fetchClusterDetail`: only returns intra-cluster links (both endpoints in the note_ids set), includes `image_url` and `created_by` on links
- `fetchRecent`: respects limit, includes `image_url`, excludes archived notes

The mock pattern follows `tests/mcp-tools.test.ts`: create a mock Supabase client object with chainable `.from().select().eq()...` methods that return canned data.

- [ ] **Step 2: Write `dashboard-api/src/db.ts`**

```typescript
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Config, StatsResponse, ClusterCard, ClusterDetailNote, ClusterDetailLink, RecentNote } from './types';

export function createSupabaseClient(config: Config): SupabaseClient {
  return createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
}

export async function fetchStats(db: SupabaseClient): Promise<Omit<StatsResponse, 'backup_last_commit'>> {
  // 9 parallel queries
  const [notesRes, linksRes, clustersRes, recentRes, oldestRes, newestRes, orphanRes, gardenerRes, imageRes] = await Promise.all([
    db.from('notes').select('id', { count: 'exact', head: true }).is('archived_at', null),
    db.from('links').select('id', { count: 'exact', head: true }),
    db.from('clusters').select('note_ids, resolution').order('resolution', { ascending: true }),
    db.from('notes').select('id', { count: 'exact', head: true }).gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
    db.from('notes').select('created_at').is('archived_at', null).order('created_at', { ascending: true }).limit(1),
    db.from('notes').select('created_at').is('archived_at', null).order('created_at', { ascending: false }).limit(1),
    db.from('notes').select('id').is('archived_at', null),
    db.from('clusters').select('created_at').order('created_at', { ascending: false }).limit(1),
    db.from('notes').select('id', { count: 'exact', head: true }).is('archived_at', null).not('image_url', 'is', null),
  ]);

  const totalNotes = notesRes.count ?? 0;
  const totalLinks = linksRes.count ?? 0;
  const recentCount = recentRes.count ?? 0;
  const imageCount = imageRes.count ?? 0;

  // Compute unclustered at lowest resolution
  const clusterRows = (clustersRes.data ?? []) as Array<{ note_ids: string[]; resolution: number }>;
  const resolutions = [...new Set(clusterRows.map(r => r.resolution))].sort((a, b) => a - b);
  const lowestRes = resolutions[0];
  const clusteredIds = new Set<string>();
  let clusterCount = 0;
  for (const row of clusterRows) {
    if (row.resolution === lowestRes) {
      clusterCount++;
      for (const id of row.note_ids) clusteredIds.add(id);
    }
  }

  // Compute orphan count — notes with zero links
  const allNoteIds = (orphanRes.data ?? []).map((n: { id: string }) => n.id);
  const linkedIds = new Set<string>();
  // Fetch all links to find orphans (acceptable at ~200 notes; consider RPC at scale)
  const { data: allLinks } = await db.from('links').select('from_id, to_id');
  if (allLinks) {
    for (const l of allLinks as Array<{ from_id: string; to_id: string }>) {
      linkedIds.add(l.from_id);
      linkedIds.add(l.to_id);
    }
  }
  const orphanCount = allNoteIds.filter((id: string) => !linkedIds.has(id)).length;

  const oldest = (oldestRes.data?.[0] as { created_at: string } | undefined)?.created_at ?? null;
  const newest = (newestRes.data?.[0] as { created_at: string } | undefined)?.created_at ?? null;
  const gardenerLastRun = (gardenerRes.data?.[0] as { created_at: string } | undefined)?.created_at ?? null;

  return {
    total_notes: totalNotes,
    total_links: totalLinks,
    total_clusters: clusterCount,
    unclustered_count: totalNotes - clusteredIds.size,
    image_count: imageCount,
    capture_rate_7d: Math.round((recentCount / 7) * 10) / 10,
    oldest_note: oldest,
    newest_note: newest,
    orphan_count: orphanCount,
    avg_links_per_note: totalNotes > 0 ? Math.round((totalLinks / totalNotes) * 10) / 10 : 0,
    gardener_last_run: gardenerLastRun,
  };
}

export async function fetchClusters(db: SupabaseClient, resolution: number): Promise<{ clusters: ClusterCard[]; available_resolutions: number[] }> {
  const [clusterRes, resolutionRes] = await Promise.all([
    db.from('clusters').select('label, top_tags, note_ids, gravity').eq('resolution', resolution).order('gravity', { ascending: false }),
    db.from('clusters').select('resolution').order('resolution', { ascending: true }),
  ]);

  const rows = (clusterRes.data ?? []) as Array<{ label: string; top_tags: string[]; note_ids: string[]; gravity: number }>;
  const available = [...new Set((resolutionRes.data ?? []).map((r: { resolution: number }) => r.resolution))];

  if (rows.length === 0) return { clusters: [], available_resolutions: available };

  // Batch-fetch titles and links for hub note computation
  const allIds = [...new Set(rows.flatMap(r => r.note_ids))];
  const [{ data: noteRows }, { data: linkRows }] = await Promise.all([
    db.from('notes').select('id, title').in('id', allIds).is('archived_at', null),
    db.from('links').select('from_id, to_id').or(`from_id.in.(${allIds.join(',')}),to_id.in.(${allIds.join(',')})`),
  ]);

  const titleMap = new Map<string, string>();
  if (noteRows) {
    for (const n of noteRows as Array<{ id: string; title: string }>) titleMap.set(n.id, n.title);
  }

  const activeIds = new Set(titleMap.keys());
  const activeLinkPairs: Array<{ from_id: string; to_id: string }> = [];
  if (linkRows) {
    for (const l of linkRows as Array<{ from_id: string; to_id: string }>) {
      if (activeIds.has(l.from_id) && activeIds.has(l.to_id)) activeLinkPairs.push(l);
    }
  }

  const clusters: ClusterCard[] = rows.map(row => {
    const activeNoteIds = row.note_ids.filter(id => titleMap.has(id));
    const clusterIds = new Set(activeNoteIds);

    // Hub notes: top 2 by intra-cluster link count
    const linkCounts = new Map<string, number>();
    for (const l of activeLinkPairs) {
      if (clusterIds.has(l.from_id) && clusterIds.has(l.to_id)) {
        linkCounts.set(l.from_id, (linkCounts.get(l.from_id) ?? 0) + 1);
        linkCounts.set(l.to_id, (linkCounts.get(l.to_id) ?? 0) + 1);
      }
    }
    const hubNotes = activeNoteIds
      .map(id => ({ id, title: titleMap.get(id)!, link_count: linkCounts.get(id) ?? 0 }))
      .filter(n => n.link_count > 0)
      .sort((a, b) => b.link_count - a.link_count)
      .slice(0, 2);

    return {
      label: row.label,
      top_tags: row.top_tags,
      note_count: activeNoteIds.length,
      gravity: row.gravity,
      note_ids: activeNoteIds,
      hub_notes: hubNotes,
    };
  });

  return { clusters, available_resolutions: available };
}

export async function fetchClusterDetail(db: SupabaseClient, noteIds: string[]): Promise<{ notes: ClusterDetailNote[]; links: ClusterDetailLink[] }> {
  const [notesRes, linksRes] = await Promise.all([
    db.from('notes').select('id, title, tags, image_url, created_at').in('id', noteIds).is('archived_at', null),
    db.from('links').select('from_id, to_id, link_type, confidence, created_by').in('from_id', noteIds).in('to_id', noteIds),
  ]);

  return {
    notes: (notesRes.data ?? []) as ClusterDetailNote[],
    links: (linksRes.data ?? []) as ClusterDetailLink[],
  };
}

export async function fetchRecent(db: SupabaseClient, limit: number): Promise<RecentNote[]> {
  const { data } = await db
    .from('notes')
    .select('id, title, tags, source, image_url, created_at')
    .is('archived_at', null)
    .order('created_at', { ascending: false })
    .limit(limit);

  return (data ?? []) as RecentNote[];
}
```

Note: The exact implementation will be refined during TDD — write the test assertions first, then shape the queries to pass them. The code above shows the intended query patterns; the actual implementation will emerge from the tests.

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/dashboard-api.test.ts`
Expected: All db tests PASS

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p dashboard-api/tsconfig.json`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard-api/src/db.ts tests/dashboard-api.test.ts
git commit -m "feat(dashboard-api): database query functions with tests

refs #101"
```

---

### Task 4: GitHub backup check

**Files:**
- Create: `dashboard-api/src/github.ts`
- Modify: `tests/dashboard-api.test.ts` (add github tests)

- [ ] **Step 1: Write github tests**

Test cases:
- Returns ISO date string when GitHub API returns commits
- Returns null when `githubBackupPat` is not set
- Returns null when GitHub API returns error (non-200)
- Caches response for 5 minutes (second call within window doesn't re-fetch)

Mock `fetch` globally for these tests.

- [ ] **Step 2: Write `dashboard-api/src/github.ts`**

```typescript
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cachedResult: { value: string | null; timestamp: number } | null = null;

export async function fetchBackupRecency(backupRepo: string, pat: string | null): Promise<string | null> {
  if (!pat || !backupRepo) return null;

  // In-memory cache (best-effort — isolate may be recycled)
  if (cachedResult && (Date.now() - cachedResult.timestamp) < CACHE_TTL_MS) {
    return cachedResult.value;
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${backupRepo}/commits?per_page=1`, {
      headers: {
        Authorization: `token ${pat}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'contemplace-dashboard-api',
      },
    });
    if (!res.ok) {
      console.warn(JSON.stringify({ event: 'github_backup_check_error', status: res.status }));
      cachedResult = { value: null, timestamp: Date.now() };
      return null;
    }
    const commits = await res.json() as Array<{ commit: { committer: { date: string } } }>;
    const date = commits[0]?.commit?.committer?.date ?? null;
    cachedResult = { value: date, timestamp: Date.now() };
    return date;
  } catch (err) {
    console.warn(JSON.stringify({ event: 'github_backup_fetch_error', error: String(err) }));
    cachedResult = { value: null, timestamp: Date.now() };
    return null;
  }
}

/** Reset cache — for testing only. */
export function _resetCache(): void {
  cachedResult = null;
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/dashboard-api.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Commit**

```bash
git add dashboard-api/src/github.ts tests/dashboard-api.test.ts
git commit -m "feat(dashboard-api): GitHub backup recency check with cache

refs #101"
```

---

### Task 5: Route dispatch and CORS

**Files:**
- Create: `dashboard-api/src/index.ts`
- Modify: `tests/dashboard-api.test.ts` (add CORS and routing tests)

- [ ] **Step 1: Write routing and CORS tests**

Test cases:
- OPTIONS request returns CORS preflight headers (200)
- CORS headers include `Access-Control-Allow-Origin` matching `CORS_ORIGIN`
- GET /stats with valid auth returns 200 JSON
- GET /clusters?resolution=1.0 returns 200 JSON
- GET /clusters/detail?note_ids=uuid1,uuid2 returns 200 JSON
- GET /recent returns 200 JSON
- GET /unknown returns 404
- Request without auth returns 401
- Request with wrong token returns 403
- POST method on all endpoints returns 405

- [ ] **Step 2: Write `dashboard-api/src/index.ts`**

```typescript
import { loadConfig } from './config';
import { validateAuth } from './auth';
import { createSupabaseClient, fetchStats, fetchClusters, fetchClusterDetail, fetchRecent } from './db';
import { fetchBackupRecency } from './github';
import type { Env } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = loadConfig(env);
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: corsHeaders(config.corsOrigin) });
    }

    // Auth gate (all routes)
    const authError = validateAuth(request, config.dashboardApiKey);
    if (authError) return withCors(authError, config.corsOrigin);

    // Method check
    if (request.method !== 'GET') {
      return withCors(new Response('Method Not Allowed', { status: 405 }), config.corsOrigin);
    }

    const db = createSupabaseClient(config);

    try {
      if (path === '/stats') {
        const stats = await fetchStats(db);
        const backupLastCommit = await fetchBackupRecency(config.backupRepo, config.githubBackupPat);
        return jsonResponse({ ...stats, backup_last_commit: backupLastCommit }, config.corsOrigin);
      }

      if (path === '/clusters') {
        const resolution = parseFloat(url.searchParams.get('resolution') ?? '1.0');
        if (isNaN(resolution)) return withCors(new Response('Invalid resolution', { status: 400 }), config.corsOrigin);
        const result = await fetchClusters(db, resolution);
        return jsonResponse({ resolution, ...result }, config.corsOrigin);
      }

      if (path === '/clusters/detail') {
        const idsParam = url.searchParams.get('note_ids') ?? '';
        const noteIds = idsParam.split(',').filter(Boolean);
        if (noteIds.length === 0) return withCors(new Response('note_ids required', { status: 400 }), config.corsOrigin);
        if (noteIds.length > 50) return withCors(new Response('Maximum 50 note_ids', { status: 400 }), config.corsOrigin);
        if (!noteIds.every(id => UUID_RE.test(id))) return withCors(new Response('Invalid UUID format', { status: 400 }), config.corsOrigin);
        const result = await fetchClusterDetail(db, noteIds);
        return jsonResponse(result, config.corsOrigin);
      }

      if (path === '/recent') {
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '15', 10) || 15, 1), 50);
        const notes = await fetchRecent(db, limit);
        return jsonResponse(notes, config.corsOrigin);
      }

      return withCors(new Response('Not Found', { status: 404 }), config.corsOrigin);
    } catch (err) {
      console.error(JSON.stringify({ event: 'dashboard_api_error', error: String(err), path }));
      return withCors(new Response('Internal Server Error', { status: 500 }), config.corsOrigin);
    }
  },
};

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function jsonResponse(data: unknown, origin: string): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin },
  });
}
```

- [ ] **Step 3: Run tests**

Run: `npx vitest run tests/dashboard-api.test.ts`
Expected: All tests PASS

- [ ] **Step 4: Typecheck all projects**

Run: `npx tsc --noEmit && npx tsc --noEmit -p mcp/tsconfig.json && npx tsc --noEmit -p gardener/tsconfig.json && npx tsc --noEmit -p dashboard-api/tsconfig.json`
Expected: All PASS

- [ ] **Step 5: Commit**

```bash
git add dashboard-api/src/index.ts tests/dashboard-api.test.ts
git commit -m "feat(dashboard-api): route dispatch with CORS and auth

refs #101"
```

---

## Chunk 2: Dashboard Frontend

### Task 6: Frontend — app.js (API client and auth)

**Files:**
- Create: `dashboard/index.html` (layout skeleton only)
- Create: `dashboard/js/app.js`

- [ ] **Step 1: Create `dashboard/index.html` with layout skeleton**

The HTML file contains:
- `<meta name="viewport">` for iPad/tablet
- Import map pointing Cytoscape to `esm.sh`
- Dark theme CSS inline (CSS grid layout, responsive `auto-fill` for cluster grid)
- `<section>` elements for each panel: `#stats`, `#clusters`, `#recent`
- Auth overlay: a simple form that prompts for the API key, stores in `localStorage`
- `<script type="module" src="js/app.js">`

Key CSS details:
- CSS variables for colors (dark background, light text, accent for health dots)
- `.cluster-grid` uses `grid-template-columns: repeat(auto-fill, minmax(320px, 1fr))`
- `.cluster-expanded` uses `grid-column: 1 / -1` for full-width expansion
- Health dots: `.dot-green`, `.dot-amber`, `.dot-red`, `.dot-gray`
- Source badges: small colored pills for `telegram` / `mcp`
- Image indicator: camera icon (Unicode or CSS) next to titles

- [ ] **Step 2: Create `dashboard/js/app.js`**

```javascript
// API client with Bearer auth and 10s timeout
const API_URL = document.querySelector('meta[name="api-url"]')?.content;
const AUTH_KEY = 'contemplace-dashboard-key';

function getToken() {
  return localStorage.getItem(AUTH_KEY);
}

function setToken(token) {
  localStorage.setItem(AUTH_KEY, token);
}

function clearToken() {
  localStorage.removeItem(AUTH_KEY);
}

async function apiFetch(path) {
  const token = getToken();
  if (!token) throw new Error('No API key');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(`${API_URL}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (res.status === 401 || res.status === 403) {
      clearToken();
      location.reload();
      return;
    }
    if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
    return res.json();
  } finally {
    clearTimeout(timeout);
  }
}

// Export API client for panels
export const api = { fetch: apiFetch };

// Panel initialization
import { init as initStats } from './stats.js';
import { init as initClusters } from './clusters.js';
import { init as initRecent } from './recent.js';

function showAuth() {
  document.getElementById('auth-overlay').style.display = 'flex';
  document.getElementById('main-content').style.display = 'none';
}

function showDashboard() {
  document.getElementById('auth-overlay').style.display = 'none';
  document.getElementById('main-content').style.display = 'block';
}

async function boot() {
  if (!getToken()) {
    showAuth();
    document.getElementById('auth-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const key = document.getElementById('api-key-input').value.trim();
      if (key) {
        setToken(key);
        showDashboard();
        loadPanels();
      }
    });
    return;
  }
  showDashboard();
  loadPanels();
}

async function loadPanels() {
  const results = await Promise.allSettled([
    initStats(api),
    initClusters(api),
    initRecent(api),
  ]);
  for (const r of results) {
    if (r.status === 'rejected') console.error('Panel init failed:', r.reason);
  }
}

boot();
```

- [ ] **Step 3: Verify the page loads in a browser (manual)**

Run: `npx wrangler pages dev dashboard/` (ES modules require a server — `file://` won't work due to CORS).
Should show the auth overlay. After entering any key, should show the panel sections (empty, with loading/error states).

- [ ] **Step 4: Commit**

```bash
git add dashboard/
git commit -m "feat(dashboard): HTML skeleton and app.js API client

refs #101"
```

---

### Task 7: Frontend — stats.js panel

**Files:**
- Create: `dashboard/js/stats.js`

- [ ] **Step 1: Write `dashboard/js/stats.js`**

The stats panel fetches `/stats` and renders two rows:
- Row 1: vanity numbers (total notes, total links, total clusters, capture rate, image count)
- Row 2: health indicators with colored dots

Health thresholds (computed in JS from the API response):

| Metric | Green | Amber | Red |
|---|---|---|---|
| Gardener freshness | < 26h since `gardener_last_run` | 26-48h | > 48h or null |
| Orphan ratio | `orphan_count / total_notes` < 0.15 | 0.15-0.25 | > 0.25 |
| Clustered ratio | `1 - (unclustered_count / total_notes)` > 0.85 | 0.70-0.85 | < 0.70 |
| Avg links/note | > 2 | 1-2 | < 1 |
| Last backup | < 26h since `backup_last_commit` | 26-48h | > 48h or null |

```javascript
export async function init(api) {
  const container = document.getElementById('stats');
  try {
    container.innerHTML = '<p class="loading">Loading stats...</p>';
    const data = await api.fetch('/stats');
    render(container, data);
  } catch (err) {
    renderError(container, 'Stats unavailable', () => init(api));
  }
}
```

The `render` function builds the DOM for both rows. Each health indicator is a `<span>` with a colored dot class and a label.

- [ ] **Step 2: Commit**

```bash
git add dashboard/js/stats.js
git commit -m "feat(dashboard): stats bar panel with health indicators

refs #101"
```

---

### Task 8: Frontend — clusters.js panel

**Files:**
- Create: `dashboard/js/clusters.js`

- [ ] **Step 1: Write `dashboard/js/clusters.js`**

The cluster panel has three states:
1. **Grid view** — cards ordered by gravity, resolution selector at top
2. **Expanded view** — one card expanded to full width with Cytoscape graph + note list
3. **Loading/error** — per standard pattern

Cytoscape is imported via the import map:
```javascript
import cytoscape from 'cytoscape';
```

Resolution selector: reads `available_resolutions` from the API response, renders as `<select>`. Change event re-fetches `/clusters?resolution=X` and re-renders.

Card click: fetches `/clusters/detail?note_ids=...` (the card's `note_ids`, capped at 50), renders:
- Left: Cytoscape `cose` layout. Nodes sized by link count. Hub notes get a distinct color. Edges: capture-time = solid (from `created_by !== 'gardener'`), gardener = dashed. Node click shows tooltip with title + tags.
- Right: scrollable list of note titles. Image-bearing notes show a 📷 indicator.

Click card header again (or an X button) to collapse.

- [ ] **Step 2: Commit**

```bash
git add dashboard/js/clusters.js
git commit -m "feat(dashboard): cluster grid with Cytoscape graph expand

refs #101"
```

---

### Task 9: Frontend — recent.js panel

**Files:**
- Create: `dashboard/js/recent.js`

- [ ] **Step 1: Write `dashboard/js/recent.js`**

Fetches `/recent?limit=15`. Renders a list of note entries:
- Title
- Tags as small pills
- Source badge (colored: telegram = blue, mcp = green)
- Relative timestamp (e.g., "2h ago", "yesterday")
- Image indicator: if `image_url` is set, show a small thumbnail (32px) loaded via `<img>` from the R2 URL. Add an `onerror` handler on the `<img>` element that replaces it with a camera icon text node on failure: `img.onerror = () => { img.replaceWith(document.createTextNode('\u{1F4F7}')); }`

```javascript
export async function init(api) {
  const container = document.getElementById('recent');
  try {
    container.innerHTML = '<p class="loading">Loading recent captures...</p>';
    const notes = await api.fetch('/recent?limit=15');
    render(container, notes);
  } catch (err) {
    renderError(container, 'Recent captures unavailable', () => init(api));
  }
}
```

- [ ] **Step 2: Commit**

```bash
git add dashboard/js/recent.js
git commit -m "feat(dashboard): recent captures panel with image indicators

refs #101"
```

---

## Chunk 3: Deploy Integration and Documentation

### Task 10: Deploy and verify

**Files:**
- Modify: `scripts/deploy.sh`
- Create: `tests/dashboard-smoke.test.ts`

**Prerequisites (manual, one-time):**
1. Generate `DASHBOARD_API_KEY`: `openssl rand -hex 32`
2. Create GitHub fine-grained PAT (Contents: read-only on backup repo)
3. Add to `.dev.vars`:
   ```
   DASHBOARD_API_KEY=<generated value>
   GITHUB_BACKUP_PAT=<github pat>
   DASHBOARD_API_URL=https://contemplace-dashboard-api.<account>.workers.dev
   ```
4. Set secrets: `wrangler secret put SUPABASE_URL -c dashboard-api/wrangler.toml`, repeat for `SUPABASE_SERVICE_ROLE_KEY`, `DASHBOARD_API_KEY`, `GITHUB_BACKUP_PAT`
5. Create Pages project: `wrangler pages project create contemplace-dashboard`
6. Verify `BACKUP_REPO` value in `dashboard-api/wrangler.toml` matches the actual backup repo name

- [ ] **Step 1: Deploy API Worker**

Run: `wrangler deploy -c dashboard-api/wrangler.toml`
Expected: Deployed successfully

- [ ] **Step 2: Write smoke test**

In `tests/dashboard-smoke.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';

const API_URL = process.env.DASHBOARD_API_URL;
const API_KEY = process.env.DASHBOARD_API_KEY;

describe('dashboard-api smoke', () => {
  it('GET /stats returns 200 with expected shape', async () => {
    const res = await fetch(`${API_URL}/stats`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('total_notes');
    expect(data).toHaveProperty('total_links');
    expect(data).toHaveProperty('total_clusters');
    expect(data).toHaveProperty('orphan_count');
    expect(data).toHaveProperty('image_count');
    expect(data).toHaveProperty('gardener_last_run');
    expect(data.total_notes).toBeGreaterThan(0);
  });

  it('GET /clusters returns clusters with hub_notes', async () => {
    const res = await fetch(`${API_URL}/clusters?resolution=1.0`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('clusters');
    expect(data).toHaveProperty('available_resolutions');
    expect(data.clusters.length).toBeGreaterThan(0);
    expect(data.clusters[0]).toHaveProperty('hub_notes');
    expect(data.clusters[0]).toHaveProperty('note_ids');
  });

  it('GET /clusters/detail returns notes + links for a cluster', async () => {
    // First get a cluster's note_ids
    const clusterRes = await fetch(`${API_URL}/clusters?resolution=1.0`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    const clusterData = await clusterRes.json();
    const noteIds = clusterData.clusters[0].note_ids.slice(0, 10);
    const res = await fetch(`${API_URL}/clusters/detail?note_ids=${noteIds.join(',')}`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveProperty('notes');
    expect(data).toHaveProperty('links');
    expect(data.notes[0]).toHaveProperty('image_url');
    if (data.links.length > 0) expect(data.links[0]).toHaveProperty('created_by');
  });

  it('GET /recent returns notes with image_url', async () => {
    const res = await fetch(`${API_URL}/recent?limit=5`, { headers: { Authorization: `Bearer ${API_KEY}` } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty('image_url');
    expect(data[0]).toHaveProperty('source');
  });

  it('rejects request without auth', async () => {
    const res = await fetch(`${API_URL}/stats`);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 3: Run smoke tests**

Run: `npx vitest run tests/dashboard-smoke.test.ts`
Expected: All PASS

- [ ] **Step 4: Update `<meta name="api-url">` in `dashboard/index.html`**

Set the content to the deployed API Worker URL (e.g., `https://contemplace-dashboard-api.<account>.workers.dev`).

- [ ] **Step 5: Deploy frontend**

Run: `wrangler pages deploy dashboard/ --project-name contemplace-dashboard`
Expected: Deployed successfully. Outputs the Pages URL.

- [ ] **Step 6: Visual verification**

Open the Pages URL in a browser. Enter the API key. Verify:
- Stats bar shows numbers and health dots
- Cluster grid shows cards ordered by gravity
- Resolution selector works (changing resolution refreshes cards)
- Clicking a cluster card expands it with Cytoscape graph
- Hub notes are highlighted in the graph
- Recent captures show with source badges and timestamps
- Image-bearing notes show indicators
- Page works on iPad Safari (test with device or simulator)

- [ ] **Step 7: Update `scripts/deploy.sh`**

Update step numbering from `N/8` to `N/11` throughout. Add these three new steps after the Gardener Worker deploy (current step 7) and before smoke tests:

After the existing step 7 (`Deploying Gardener Worker`), insert:

```bash
# ── Step 8: Typecheck Dashboard API ──────────────────────────────────────────
echo "▶  8/11  Typechecking Dashboard API..."
npx tsc --noEmit -p dashboard-api/tsconfig.json
echo "   ✓ No type errors."
echo ""

# ── Step 9: Deploy Dashboard API Worker ──────────────────────────────────────
echo "▶  9/11  Deploying Dashboard API Worker..."
wrangler deploy -c dashboard-api/wrangler.toml
echo "   ✓ Dashboard API Worker deployed."
echo ""

# ── Step 10: Deploy Dashboard Pages ──────────────────────────────────────────
echo "▶  10/11  Deploying Dashboard..."
wrangler pages deploy dashboard/ --project-name contemplace-dashboard
echo "   ✓ Dashboard deployed."
echo ""
```

Update the smoke test step (now step 11) to also run dashboard smoke tests:

```bash
echo "▶  11/11  Running smoke tests against live Workers..."
npx vitest run tests/smoke.test.ts tests/dashboard-smoke.test.ts
```

Also update step 2 (typecheck) to include: `npx tsc --noEmit -p dashboard-api/tsconfig.json`

Also update step 3 (unit tests) to include: `tests/dashboard-api.test.ts`

- [ ] **Step 8: Commit**

```bash
git add scripts/deploy.sh tests/dashboard-smoke.test.ts dashboard/index.html
git commit -m "feat(dashboard): deploy integration and smoke tests

refs #101"
```

---

### Task 11: Documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/architecture.md`
- Modify: `docs/setup.md`
- Modify: `docs/development.md`
- Modify: `docs/decisions.md`

- [ ] **Step 1: Add ADR entry to `docs/decisions.md`**

Append new entry:

```markdown
## Dashboard as a presentation layer, not enrichment (2026-03-20)

**Decision:** Build a read-only visual dashboard — a Dashboard API Worker (`contemplace-dashboard-api`) serving JSON, and a vanilla HTML/CSS/JS SPA on Cloudflare Pages. Auth via Bearer token in localStorage. Cytoscape.js for force-directed cluster graphs.

**Why:** The knowledge graph (clusters, links, similarity signals) had no visual surface. MCP tools expose data to agents; the dashboard exposes it to the human. Image capture (#209) confirmed the need — MCP clients can't render images inline, making the dashboard the only retrieval surface for visual notes. Specialist review (two agents) confirmed: Cytoscape.js, separate API Worker, three-panel layout, no full-corpus graph. Auth simplified from Cloudflare Access to Bearer token — works across all devices, no CORS+Access complexity.

**Alternatives considered:** Adding REST endpoints to the MCP Worker (rejected: different auth model, different secrets scope, deployment coupling). Cloudflare Access for auth (rejected: two auth layers for one user, CORS pain, setup overhead — can layer on later). Framework-based frontend (rejected: three panels + one graph library don't need React). Full-corpus graph view (rejected: prior art shows it becomes a hairball above ~100 nodes).
```

- [ ] **Step 2: Update `CLAUDE.md`**

- Add `Dashboard API Worker` to the architecture table
- Add `dashboard/` and `dashboard-api/` to the project layout
- Add env vars section for Dashboard API Worker
- Add typecheck + deploy commands

- [ ] **Step 3: Update `docs/architecture.md`**

- Update "Three Workers" to "Four Workers" table, adding Dashboard API
- Add section describing the Dashboard API Worker (read-only, no Service Bindings)
- Add to security boundaries (Bearer token auth)

- [ ] **Step 4: Update `docs/setup.md`**

- Add `DASHBOARD_API_KEY` and `GITHUB_BACKUP_PAT` generation commands
- Add Cloudflare Pages project creation step
- Add `wrangler secret put` commands for dashboard-api

- [ ] **Step 5: Update `docs/development.md`**

- Add dashboard-api test files to the test file breakdown
- Add dashboard deploy commands

- [ ] **Step 6: Commit**

```bash
git add docs/ CLAUDE.md
git commit -m "docs: architecture, setup, and decisions for visual dashboard

refs #101"
```

---

### Task 12: Push and create PR

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/visual-dashboard
```

- [ ] **Step 2: Create PR**

Title: `feat: visual dashboard — graph exploration with cluster views and image support`

Body should include:
- Summary: what was built (API Worker + SPA), 4 API endpoints, 3 frontend panels
- Key decisions: Bearer token auth, Cytoscape.js, modular ES modules, image support
- Test plan checklist: unit tests, smoke tests, visual verification, iPad test
- Reference: closes #101

- [ ] **Step 3: Verify CI passes**

Check that all tests pass on the PR.

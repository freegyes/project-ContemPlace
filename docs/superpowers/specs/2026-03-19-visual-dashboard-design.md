# Visual Dashboard Design Spec

**Issue:** #101
**Status:** Approved
**Date:** 2026-03-19

## Problem

ContemPlace has a knowledge graph with clusters, links, and notes — but no way to see it. The MCP tools expose this data to agents; the dashboard exposes it to the human. The goal: see the shape of your thinking, what's gaining density, and whether the system is healthy.

## Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Access pattern | Standalone first, agent-driven later | Must work as a bookmark; agent navigation is a future upgrade |
| Data access | Thin API Worker | MCP tools wrong shape for dashboard; RLS too large a prerequisite |
| Graph library | Cytoscape.js (CDN, minified) | Graph-first API, built-in force layouts, cluster grouping support |
| Hosting | Cloudflare Pages | Fits existing stack, static SPA, `wrangler pages deploy` |
| Access control | Cloudflare Access (Zero Trust) | Email allowlist with OTP, free tier, no auth code in the SPA |
| Page structure | Single page, panel-based | Simplest scaffolding for MVP; scroll is the navigation |
| Frontend stack | Vanilla HTML/CSS/JS, no framework | Three panels and one graph library don't need a framework |
| Testing | API Worker unit tests + smoke test, no frontend tests | Same patterns as other Workers; visual verification by eyeball |
| Code sharing | None — duplicate `createSupabaseClient` etc. | Project precedent: shared path over shared code |

## Page Layout

Three vertical sections, top to bottom:

### 1. Stats Bar

**Row 1 — Vanity numbers:** Total notes, total links, total clusters, capture rate (notes/day, 7-day window). Large numbers, glanceable.

**Row 2 — Health indicators:** Each shows a value with a colored dot (green/amber/red):

| Metric | Source | Green | Amber | Red |
|---|---|---|---|---|
| Gardener freshness | `MAX(created_at)` on `clusters` | < 26h | 26-48h | > 48h |
| Orphan ratio | notes with zero links (either direction) / total | < 15% | 15-25% | > 25% |
| Clustered ratio | notes in any cluster / total | > 85% | 70-85% | < 70% |
| Avg links/note | total links / total notes | > 2 | 1-2 | < 1 |
| Last backup | GitHub API (backup repo last commit) | < 26h | 26-48h | > 48h |

If any metric fails to load, it shows a gray dot with "unknown" — doesn't block the rest.

### 2. Cluster Grid

Responsive grid of cluster cards (2-3 columns). Each card shows: cluster label, note count, gravity score, top tags as pills. Ordered by gravity descending.

Resolution selector driven by `available_resolutions` from the API response (not hardcoded). Toggles cluster granularity — grid re-renders.

Clicking a card expands it inline (full width). The expand triggers a second API call that returns notes + links together:
- **Left:** Cytoscape force-directed graph of cluster notes and their links. Nodes sized by link count, edges colored by type (capture-time = solid, gardener = dashed). Click a node for title + tags tooltip.
- **Right:** scrollable list of member note titles.

### 3. Recent Captures

Reverse-chronological list of the last 15 notes. Each entry: title, tags, source badge (telegram/mcp), relative timestamp. No body or raw_input.

## API Worker

New Cloudflare Worker: `dashboard-api`. Read-only Supabase access. Bearer token auth via constant-time comparison (`timingSafeEqual`, matching MCP Worker pattern).

### Endpoints

**`GET /stats`** — corpus-level numbers. Supabase queries and GitHub API call run independently; GitHub failure degrades to `backup_last_commit: null` without blocking the response.
```json
{
  "total_notes": 186,
  "total_links": 63,
  "total_clusters": 9,
  "unclustered_count": 15,
  "capture_rate_7d": 4.3,        // count(notes where created_at > now - 7d) / 7, includes archived
  "oldest_note": "2026-02-15T...",
  "newest_note": "2026-03-18T...",
  "orphan_count": 15,
  "avg_links_per_note": 1.8,
  "gardener_last_run": "2026-03-19T02:00:00Z",
  "backup_last_commit": "2026-03-19T04:00:00Z"
}
```

The GitHub API call to check backup recency is cached for 5 minutes (Cloudflare `cache` API or in-memory) to avoid rate limiting on repeated dashboard refreshes.

**`GET /clusters?resolution=1.0`** — cluster cards. Returns card-level data only (no notes array). Notes are fetched on expand via the detail endpoint.
```json
{
  "resolution": 1.0,
  "available_resolutions": [1.0, 1.5, 2.0],
  "clusters": [
    {
      "label": "capture-pipeline / voice-correction",
      "note_count": 24,
      "gravity": 18.7,
      "top_tags": ["capture", "voice", "pipeline"],
      "note_ids": ["uuid1", "uuid2", "..."]
    }
  ]
}
```

**`GET /clusters/detail?note_ids=uuid1,uuid2,...`** — notes + links for a specific cluster. Called on card expand. The frontend passes the `note_ids` it received from `/clusters`, avoiding any label-collision issues. Maximum 100 note_ids per request.
```json
{
  "notes": [
    { "id": "uuid", "title": "...", "tags": ["..."], "created_at": "..." }
  ],
  "links": [
    { "from_id": "uuid", "to_id": "uuid", "link_type": "related", "confidence": 0.72 }
  ]
}
```

**`GET /recent?limit=15`**
```json
[
  { "id": "uuid", "title": "...", "tags": ["..."], "source": "telegram", "created_at": "..." }
]
```

### Error Responses

Plain text body with HTTP status code, matching existing Worker patterns:
- `401 Unauthorized` — missing or invalid Bearer token
- `400 Bad Request` — invalid parameters (e.g., non-numeric resolution, too many note_ids)
- `500 Internal Server Error` — Supabase query failure (no internal details exposed)

### Auth and CORS

- Bearer token validated via constant-time comparison against `DASHBOARD_API_KEY` secret
- CORS: `Access-Control-Allow-Origin` set to the specific Pages domain (read from `CORS_ORIGIN` var in `wrangler.toml`)
- CORS preflight: `OPTIONS` handler returns `Access-Control-Allow-Headers: Authorization` and `Access-Control-Allow-Methods: GET, OPTIONS`

### Secrets

- `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (same as other Workers)
- `DASHBOARD_API_KEY` (new — add to `.dev.vars`)
- `GITHUB_BACKUP_PAT` (read-only Contents on backup repo — separate from `BACKUP_PAT` used by the GH Actions workflow, which has write access. Add to `.dev.vars`)
- `BACKUP_REPO` (owner/repo string — same value as `vars.BACKUP_REPO` in the GH Actions workflow. Set in `wrangler.toml [vars]`)

## Frontend

### Stack

Vanilla HTML + CSS + JS. Single `index.html`. Cytoscape.js loaded from CDN (minified build). No build step, no node_modules.

### Styling

Dark theme (GitHub-dark palette). CSS grid for layout. Responsive down to tablet. Phone out of scope for v1.

### Cytoscape Configuration

Layout: `cose` (force-directed). Nodes sized proportionally to link count within cluster. Edges: capture-time = solid, gardener = dashed. Node labels = truncated titles. Click for tooltip with full title + tags.

## File Structure

```
dashboard/
  index.html          # Full page — markup, styles, JS
  wrangler.toml       # Cloudflare Pages config
dashboard-api/
  wrangler.toml       # Dashboard API Worker config
  tsconfig.json       # TypeScript config
  src/
    index.ts          # Worker entry — route dispatch, CORS handling
    auth.ts           # Bearer token validation (timingSafeEqual)
    db.ts             # Supabase queries (stats, clusters, recent, cluster links)
    config.ts         # Env var validation (SUPABASE_*, DASHBOARD_API_KEY, GITHUB_*)
    types.ts          # TypeScript interfaces
```

## Deployment

New steps in `scripts/deploy.sh` (step numbering updated to reflect new total):
1. `npx tsc --noEmit -p dashboard-api/tsconfig.json` — typecheck
2. `wrangler deploy -c dashboard-api/wrangler.toml` — API Worker
3. `wrangler pages deploy dashboard/ --project-name contemplace-dashboard` — static site

API Worker deploys before Pages (dependency goes first).

### Cloudflare Access

Zero Trust access policy on the Pages domain. Email allowlist (single email). OTP authentication. One-time CLI setup.

### Dashboard Configuration

API Worker URL set as a `<meta>` tag in the HTML that the JS reads at runtime.

## Testing

### API Worker unit tests (`tests/dashboard-api.test.ts`)

- Auth: missing/wrong token rejected (constant-time), valid token passes
- Config: service_role key validation (same as other Workers)
- Stats: correct aggregation from mocked queries, GitHub failure degrades gracefully
- Clusters: resolution validation, gravity ordering, archived notes excluded
- Cluster detail: note_ids parameter parsing, links filtered to cluster scope
- Recent: limit clamping, archived notes excluded
- Health: threshold classification logic (green/amber/red)
- CORS: only Pages domain allowed, preflight handled

### Smoke test (`tests/dashboard-smoke.test.ts`)

Hits deployed API Worker, calls all endpoints, verifies response shapes.

### No frontend tests

Visual verification by opening the page after deploy.

## Out of Scope (v1)

- Editing or capturing notes from the dashboard
- Full-corpus graph view (all 186+ notes at once)
- Phone-responsive layout
- Historical trends / time-series charts
- Admin/settings UI
- Agent-driven navigation (future: MCP tool opens dashboard to a specific cluster)

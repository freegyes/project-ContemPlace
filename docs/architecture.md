# Architecture

*How the system works internally — Workers, data flow, embedding strategy, error handling. Read this to understand what happens between receiving a message and storing a note.*

ContemPlace's irreducible core is the **database + MCP surface + gardening pipeline**. The database (Supabase with pgvector) stores notes, embeddings, and links. The MCP server exposes this to any agent — input via `capture_note`, retrieval via `search_notes`/`get_related`/`get_note`/`list_recent`. The gardener surfaces connections that make the graph useful. Everything else — input channels like Telegram, import tools, a dashboard — is optional.

The current implementation runs as three Cloudflare Workers: a **Telegram capture Worker** (a convenient input channel), an **MCP Worker** (the core interface), and a **Gardener Worker** (the enrichment layer). Supabase provides the database — Postgres with pgvector for semantic search. There are no Edge Functions, no queues, no background job runners.

> **Architectural update (2026-03-12):** The Telegram Worker now delegates capture to the MCP Worker via a Cloudflare Service Binding (PR #90). There is one capture pipeline (`mcp/src/pipeline.ts`), and the Telegram Worker is a thin webhook adapter. This resolved issue #46 and eliminated ~650 lines of duplicated code.

## Why this shape

The system needs to do four things fast: receive a message, embed it, call an LLM, and store the result. Cloudflare Workers can do all of this in a single request lifecycle using `ctx.waitUntil()` for background processing. There's no cold start penalty, the runtime is globally distributed, and the deployment is a single command.

Supabase was chosen over a self-managed Postgres instance because it bundles pgvector, PostgREST (for RPC calls from the Workers), and a management dashboard — all on a free tier that's sufficient for a single-user system. The tradeoff is vendor lock-in on the database layer, but the schema is standard Postgres and could be migrated.

OpenRouter sits between the Workers and all AI models. This adds a hop but means the system can switch between models (or providers) by changing an environment variable. No code change, no redeployment needed. The `openai` npm package talks to OpenRouter via a `baseURL` override — the same SDK works for embeddings and chat completions.

## Three Workers

| Worker | Name | Purpose | Trigger |
|---|---|---|---|
| **Telegram capture** | `contemplace` | Receives Telegram webhooks, delegates capture to MCP Worker via Service Binding, formats HTML reply | Telegram webhook POST |
| **MCP server** | `mcp-contemplace` | MCP tools via JSON-RPC 2.0 over HTTP. Hosts `CaptureService` entrypoint for Service Binding RPC (`capture()` + `undoLatest()`). | HTTP POST /mcp, Service Binding RPC |
| **Gardener** | `contemplace-gardener` | Nightly enrichment: similarity linking + cluster detection | Cron (02:00 UTC) or POST /trigger |

Each Worker is independently deployed with its own `wrangler.toml` and secrets. They share the same Supabase database and use the same `openai` SDK pattern for OpenRouter calls.

The capture pipeline lives in one place (`mcp/src/pipeline.ts`). The Telegram Worker calls it via a Cloudflare Service Binding — zero-overhead in-process RPC, no HTTP hop, no auth overhead.

## The async capture flow

Telegram sends a webhook POST for every message. The Worker must respond quickly or Telegram will retry (and eventually disable the webhook). The solution: return HTTP 200 immediately, then do all the real work in `ctx.waitUntil()`.

```
 Telegram POST
       │
       ▼
 ┌─────────────────────────────────┐
 │ Telegram Worker (contemplace)   │
 │  1. Verify webhook secret       │ ← 403 if wrong
 │  2. Parse body                  │ ← 200 if non-text message
 │  3. Check chat ID whitelist     │ ← 200 silently if not allowed
 │  4. /start → welcome message    │
 │  5. /undo → Service Binding RPC │ ← hard-delete most recent Telegram capture
 │  6. Dedup (insert update_id)    │ ← 200 if already processed
 │  7. Return 200                  │
 └─────────────────────────────────┘
       │
       ▼  ctx.waitUntil()
 ┌─────────────────────────────────┐
 │  • Send typing indicator        │
 │  • Call Service Binding RPC:    │
 │    env.CAPTURE_SERVICE.capture  │
 │    (text, 'telegram')           │
 └──────────────┬──────────────────┘
                │  in-process RPC
                ▼
 ┌─────────────────────────────────┐
 │ MCP Worker (mcp-contemplace)    │
 │ CaptureService.capture()        │
 │  → runCapturePipeline():        │
 │                                 │
 │  A. In parallel:                │
 │     • embed raw text            │
 │     • fetch capture voice       │
 │     • fetch recent fragments    │
 │       (last N within time       │
 │        window, titles+tags)     │
 │                                 │
 │  B. Find related notes          │
 │     (match_notes RPC, top 5)    │
 │     Deduplicate recent against  │
 │     related (by ID)             │
 │                                 │
 │  C. Call capture LLM            │
 │     (system frame + voice       │
 │      + raw input + recent       │
 │      fragments + related        │
 │      notes + today's date)      │
 │                                 │
 │  D. Parse + validate response   │
 │     (6 fields, logged defaults  │
 │      for invalid values)        │
 │                                 │
 │  E. Re-embed with metadata      │
 │     augmentation (fallback to   │
 │     raw embedding on failure)   │
 │                                 │
 │  F. Insert note + links         │
 │                                 │
 │  G. Log enrichments             │
 │                                 │
 │  → Return ServiceCaptureResult  │
 └──────────────┬──────────────────┘
                │
                ▼
 ┌─────────────────────────────────┐
 │ Telegram Worker (continued)     │
 │  • Format HTML reply with emoji │
 │    indicators                   │
 │  • Send Telegram message        │
 └─────────────────────────────────┘
```

The same `runCapturePipeline()` function is called by both the Service Binding RPC (Telegram gateway) and the MCP `capture_note` tool handler. One capture process, multiple gateways.

## MCP server

The MCP Worker implements JSON-RPC 2.0 over HTTP with dual authentication: OAuth 2.1 (Authorization Code + PKCE) for browser-based clients and static Bearer token for API/SDK callers. It exposes these tools:

| Tool | Operation |
|---|---|
| `search_notes` | Semantic search via `match_notes()` with optional tag filters |
| `get_note` | Full note retrieval by UUID |
| `list_recent` | Recent notes, newest first |
| `get_related` | All linked notes in both directions, ordered capture-time first then gardener by confidence |
| `capture_note` | Full capture pipeline (same logic as Telegram, synchronous) |
| `remove_note` | Remove a note — permanent delete if recent (< grace window), soft archive if older |
| `list_clusters` | Thematic clusters from the gardener. `resolution` controls granularity, `notes_per_cluster` limits title sample (default 5). Response includes `available_resolutions` from DB. Gravity-ordered. |

Tool descriptions in `TOOL_DEFINITIONS` (mcp/src/tools.ts) include behavioral guidance for connecting agents — what kind of input to pass, how to interpret results, when to use each tool. The `capture_note` description explicitly instructs agents to pass user's raw words without cleaning up or pre-structuring. These descriptions are the only guidance a connecting agent receives about how to use ContemPlace.

Both `MCP_SEARCH_THRESHOLD` and `MATCH_THRESHOLD` are intentionally low — the LLM and user respectively act as the quality gate. The thresholds provide a generous candidate pool rather than tight precision filtering. Current values live in `mcp/wrangler.toml` `[vars]`.

## Gardener pipeline

### Goal

The gardener's job is to **complete the similarity graph that capture-time linking structurally cannot**. Capture-time linking has two blind spots:

1. **Backward blindness.** When a fragment is captured, the pipeline finds the top 5 most similar existing notes and the LLM decides whether to link. But linking only looks backward — Monday's note never evaluates Tuesday's note. If Tuesday is a thematic neighbor, Monday will never initiate a link to it. The gardener compares all pairs regardless of creation order.

2. **Context window truncation.** The capture pipeline presents only the top 5 candidates. In a dense topic, candidates 6–15 might all deserve links but the LLM never sees them. The gardener has no such limit — `find_similar_pairs` returns all pairs above threshold.

A technical nuance: the comparison basis also differs. Capture-time matching compares raw text against augmented stored embeddings (`[Tags: ...] text`). The gardener compares augmented against augmented, so notes that share tags get a cosine boost the capture pipeline doesn't see.

**Success looks like:** Every note that has a genuine thematic neighbor in the corpus is connected to it. A human browsing `get_related` for any note should see all the notes they'd group with it — not just the ones that happened to exist at capture time or fit in the top 5.

**Failure looks like:** Notes about the same topic sit unconnected because one was captured after the other, or because the topic was too dense for the top-5 window. Entire input sources (e.g., short Telegram captures) are systematically excluded from similarity links. Clusters form without the gardener's contribution because its links are too sparse to matter.

**How to test:** Pick 10 notes at random. For each, ask: does `get_related` surface all its thematic neighbors, or are some missing? Are any similarity links spurious — connecting notes a human wouldn't group together? Do short Telegram fragments get similarity links at a comparable rate to longer imports? If the answer to any of these is wrong, the threshold or the mechanism needs adjustment. Additionally, run full-corpus overlap analysis: compare all gardener link pairs against all capture-time link pairs. The novelty rate (gardener-only pairs / total gardener pairs) measures whether the gardener is adding genuinely new connections or just echoing capture. Random sampling alone under-represents sparse signal.

**Validated (2026-03-18, #149):** At 186 notes, the gardener produces 117 links with 11.1% novelty (13 genuinely new connections capture missed). Zero spurious links on human review. The 13 new connections break down by failure mode: 9 from context-window truncation (later note already linked to 3+ others, this pair didn't make the top-5), 4 from backward blindness (earlier note couldn't evaluate the later one). All 13 sit in the 0.65–0.70 band — invisible at the previous 0.70 threshold.

### Operation

The Gardener Worker runs three phases — similarity linking, cluster detection, and entity extraction — with error isolation and best-effort alerting:

```
 Cron trigger (02:00 UTC) or POST /trigger
       │
       ▼
 ┌─────────────────────────────────┐
 │  1. Fetch shared data           │
 │     • fetchNotesForSimilarity   │
 │     • find_similar_pairs at     │
 │       cosineFloor (0.40)        │
 └──────────────┬──────────────────┘
                │
       ┌────────┴────────┐
       ▼                 ▼
 ┌───────────────┐ ┌───────────────┐
 │ 2. Similarity │ │ 3. Clustering │
 │    linking    │ │    (try/catch)│
 │ • Filter pairs│ │ • Graphology  │
 │   >= 0.65     │ │   graph build │
 │ • Clean-slate │ │ • Louvain at  │
 │   delete +    │ │   each        │
 │   reinsert    │ │   resolution  │
 │ • Context from│ │ • Gravity +   │
 │   shared tags │ │   tag labels  │
 └───────────────┘ │ • Clean-slate │
                   │   delete +    │
                   │   insert      │
                   └───────────────┘
       │
       ▼
 ┌───────────────────────────────────┐
 │ 4. Entity extraction (try/catch) │
 │ • Incremental: new notes only    │
 │ • LLM extraction via Haiku       │
 │ • Corpus-wide dedup/resolution   │
 │ • Clean-slate dictionary rebuild │
 │ • Per-note entities update       │
 │ (only when OPENROUTER_API_KEY    │
 │  is set — skipped otherwise)     │
 └───────────────────────────────────┘
       │
       ▼  on any error
 ┌─────────────────────────────────┐
 │  Best-effort Telegram alert     │
 │  (if TELEGRAM_BOT_TOKEN set)    │
 └─────────────────────────────────┘
```

The orchestrator fetches pairs once at `GARDENER_COSINE_FLOOR` (0.40) and shares them between the similarity and clustering phases. Pairs >= `GARDENER_SIMILARITY_THRESHOLD` (0.65) go to the linker; all pairs go to clustering. Each phase is error-isolated via try/catch — a failure in clustering or entity extraction never kills the gardener run or affects earlier phases.

Cluster detection uses Louvain community detection via Graphology (pure JS, runs in CF Workers V8). Multi-resolution: runs at each value in `GARDENER_CLUSTER_RESOLUTIONS` (default 1.0, 1.5, 2.0). Higher resolution = more granular clusters. Results stored in the `clusters` table with gravity (recency-weighted size) and top-3 tag labels.

Entity extraction uses Haiku via OpenRouter to extract proper nouns from note title + body + tags, then resolves them corpus-wide into a canonical `entity_dictionary` table. Extraction is incremental (only new notes, tracked via `enrichment_log`), limited by `GARDENER_ENTITY_BATCH_SIZE` (default 15) to stay within the CF Workers 50-subrequest limit. The entity phase is optional — it only runs when `OPENROUTER_API_KEY` is set on the gardener.

## Two-pass embedding

Every note gets embedded twice:

1. **Raw embedding** — the user's exact input text, embedded before the LLM runs. Used to find related notes via `match_notes()`. This is the lookup embedding.

2. **Augmented embedding** — after the LLM structures the note, `buildEmbeddingInput()` prepends tags: `[Tags: cooking, project] The actual text...`. This is stored in the `notes.embedding` column.

The augmented embedding bakes organizational context into the vector space. Two notes that share tags will be slightly closer in vector space than they would be from raw text alone. If the augmented embedding fails (API error, timeout), the system falls back to the raw embedding and logs an `augmented_embed_fallback` enrichment entry. The note is never lost.

> **History:** Before #110, augmentation also included `[Type: X] [Intent: Y]` prefixes. These were dropped — the marginal vector space benefit didn't justify the classification complexity.

The cost of double-embedding is negligible — roughly $0.00001 per note at current `text-embedding-3-small` pricing.

## System prompt structure

The LLM prompt is split into two parts that live in different places:

**System frame** — lives in code (`SYSTEM_FRAME` in `mcp/src/capture.ts`). This is the structural contract: the JSON schema the LLM must return, the allowed values for each enum field, the rules for linking, and the voice correction instructions. It changes only when the data model changes.

**Capture voice** — lives in the database (`capture_profiles` table, fetched at runtime by `getCaptureVoice()`). This is the stylistic layer: how titles should be phrased, how bodies should read, the traceability rule, tone preferences, examples of good and bad output. It can be edited in the Supabase SQL Editor without redeploying.

This split exists because structural changes (adding a new field, a new enum value) require code changes anyway, but stylistic tuning (shorter titles, different tone) should be instant. Any capture interface — Telegram, a future MCP tool, a CLI — fetches the same capture voice from the same table, ensuring consistent note style regardless of entry point.

The user message includes three context sections: recent fragments (temporal context — titles and tags only, explicitly labeled as potentially unrelated), related notes (semantic matches — titles and bodies, for linking decisions), and today's date (for relative time references). Recent fragments are deduplicated against related notes by ID to avoid showing the same note in both sections. The recent fragments section is omitted when empty (no captures within the time window).

## Error handling

The system distinguishes between errors the user should see and errors that need debugging:

- **User-facing:** A generic "Something went wrong" message sent to Telegram. Never includes stack traces, model names, or internal details.
- **Console logs:** Full structured JSON with the error, the input that caused it, and the processing stage. Visible in the Cloudflare Workers dashboard.
- **Gardener alerts:** Best-effort Telegram message to a configured chat ID on pipeline failure. HTML-escaped, truncated to 1000 chars, never throws.

The parser (`parseCaptureResponse`) handles malformed LLM output gracefully. Each field has a fallback default. Every fallback is logged as structured JSON so prompt tuning issues can be diagnosed from logs.

## Deduplication

Telegram can deliver the same webhook multiple times. The `processed_updates` table stores each `update_id` with a unique constraint. Before processing, the Worker attempts an insert — if it hits a `23505` unique violation, the update was already processed and is silently ignored.

This runs *before* the 200 response, so dedup is synchronous and guaranteed even if the background processing fails.

## Automated backup

The backup is not a Worker — it's a GitHub Actions workflow (`.github/workflows/backup.yml`) that runs daily at 04:00 UTC. It uses `supabase db dump` (which runs `pg_dump` inside a Docker container) to produce three SQL files:

- **`roles.sql`** — database roles (`--role-only`)
- **`schema.sql`** — DDL: tables, indexes, RPC functions, pgvector extension, RLS policies
- **`data.sql`** — all row data in COPY format (`--data-only --use-copy --schema public`)

The data dump is scoped to the `public` schema only — Supabase internal tables (`auth`, `storage`) are excluded. This means the dump restores cleanly to any Supabase project without permission errors.

Dumps are pushed to a configurable private GitHub repository. Git history provides natural retention and deduplication — if nothing changed since the last backup, no commit is created. A verification step checks that dump files are non-empty, pgvector is present, RPC functions (`match_notes`, `find_similar_pairs`) are included, and notes data and `capture_profiles` seed exist.

Authentication: the workflow uses a `SUPABASE_DB_URL` secret (session mode pooler connection string, port 5432) for the database connection, and a fine-grained `BACKUP_PAT` for push access to the backup repo.

## Future direction

### Synthesis layer

Cluster detection is live — the gardener computes Louvain clusters nightly and the `list_clusters` MCP tool exposes them. Whether narrative MOC-like synthesis (auto-generated summaries from cluster contents) is needed on top of cluster exploration is an open question (#120). Real usage will determine if browsing clusters satisfies the undirected exploration use case or if a synthesis layer adds value.

### URL handling

URL detection at capture time — fetching content, cross-referencing existing notes, building reference notes with real context — remains a natural extension but has no open issue. It will surface through real-world usage when the need is concrete.

## Security boundaries

- **Webhook verification:** Every request must include a valid `x-telegram-bot-api-secret-token` header matching the configured secret. Missing or wrong = 403.
- **Chat ID whitelist:** Only chat IDs listed in `ALLOWED_CHAT_IDS` are processed. Others get a silent 200 (no information leak).
- **MCP auth (dual):** Two permanent auth paths, both routed through `@cloudflare/workers-oauth-provider`:
  - **OAuth 2.1** — Authorization Code + PKCE for browser-based clients (Claude.ai web, ChatGPT, Cursor). Dynamic Client Registration at `/register`. Opaque tokens stored as hashes in KV. S256-only PKCE. 1h access / 30d refresh with rotation. Consent page at `/authorize` protected by `CONSENT_SECRET` — a passphrase field validated via constant-time comparison before any authorization code is issued.
  - **Static Bearer token** — `MCP_API_KEY` for API/SDK callers. Handled via `resolveExternalToken` callback with constant-time `timingSafeEqual`. The hex key has no colons, so the library skips KV lookup entirely — no latency penalty.
  - Both paths reach the same `handleMcpRequest` dispatch function. Unauthenticated requests get 401 with `WWW-Authenticate` header pointing to RFC 9728 resource metadata.
- **Gardener trigger auth:** Optional Bearer token (`GARDENER_API_KEY`) for the `/trigger` endpoint.
- **Service role key:** All Supabase access uses the service role key, bypassing RLS. The anon key is never used. RLS is enabled on all tables with a `deny all` policy as defense in depth — if the anon key were ever exposed, it would have zero access.
- **No raw SQL interpolation:** JSONB columns (`entities`, `metadata`) contain LLM-generated content and are never interpolated into SQL strings. All queries use parameterized Supabase client calls.

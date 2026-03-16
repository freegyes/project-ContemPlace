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
| **MCP server** | `mcp-contemplace` | Exposes 6 tools to AI agents via JSON-RPC 2.0 over HTTP. Hosts `CaptureService` entrypoint for Service Binding RPC (`capture()` + `undoLatest()`). | HTTP POST /mcp, Service Binding RPC |
| **Gardener** | `contemplace-gardener` | Nightly enrichment: similarity linking | Cron (02:00 UTC) or POST /trigger |

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
 │                                 │
 │  B. Find related notes          │
 │     (match_notes RPC, top 5)    │
 │                                 │
 │  C. Call capture LLM            │
 │     (system frame + voice       │
 │      + raw input + related      │
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

The MCP Worker implements JSON-RPC 2.0 over HTTP with dual authentication: OAuth 2.1 (Authorization Code + PKCE) for browser-based clients and static Bearer token for API/SDK callers. It exposes 6 tools:

| Tool | Operation |
|---|---|
| `search_notes` | Semantic search via `match_notes()` with optional tag filters |
| `get_note` | Full note retrieval by UUID |
| `list_recent` | Recent notes, newest first |
| `get_related` | All linked notes in both directions |
| `capture_note` | Full capture pipeline (same logic as Telegram, synchronous) |
| `remove_note` | Remove a note — permanent delete if recent (< grace window), soft archive if older |

Tool descriptions in `TOOL_DEFINITIONS` (mcp/src/tools.ts) include behavioral guidance for connecting agents — what kind of input to pass, how to interpret results, when to use each tool. The `capture_note` description explicitly instructs agents to pass user's raw words without cleaning up or pre-structuring. These descriptions are the only guidance a connecting agent receives about how to use ContemPlace.

The search threshold (`MCP_SEARCH_THRESHOLD`, default 0.35) is lower than the capture threshold (`MATCH_THRESHOLD`, 0.60) because stored embeddings are metadata-augmented while search queries are bare natural language.

## Gardener pipeline

The Gardener Worker runs similarity linking, with error isolation and best-effort alerting:

```
 Cron trigger (02:00 UTC) or POST /trigger
       │
       ▼
 ┌─────────────────────────────────┐
 │  Similarity linking             │
 │  • find_similar_pairs() RPC     │
 │  • Clean-slate delete + reinsert│
 │  • Auto-context from shared     │
 │    tags                         │
 └─────────────────────────────────┘
       │
       ▼  on any error
 ┌─────────────────────────────────┐
 │  Best-effort Telegram alert     │
 │  (if TELEGRAM_BOT_TOKEN set)    │
 └─────────────────────────────────┘
```

Subrequest budget is minimal and well within CF Workers' 50 free-tier limit, thanks to the `find_similar_pairs` batch RPC function.

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

The user message, related notes, and today's date are injected as the user turn. Related notes are provided so the LLM can create typed links; the date is provided so it can resolve relative time references ("yesterday", "next week").

## Error handling

The system distinguishes between errors the user should see and errors that need debugging:

- **User-facing:** A generic "Something went wrong" message sent to Telegram. Never includes stack traces, model names, or internal details.
- **Console logs:** Full structured JSON with the error, the input that caused it, and the processing stage. Visible in the Cloudflare Workers dashboard.
- **Gardener alerts:** Best-effort Telegram message to a configured chat ID on pipeline failure. HTML-escaped, truncated to 1000 chars, never throws.

The parser (`parseCaptureResponse`) handles malformed LLM output gracefully. Each field has a fallback default. Every fallback is logged as structured JSON so prompt tuning issues can be diagnosed from logs.

## Deduplication

Telegram can deliver the same webhook multiple times. The `processed_updates` table stores each `update_id` with a unique constraint. Before processing, the Worker attempts an insert — if it hits a `23505` unique violation, the update was already processed and is silently ignored.

This runs *before* the 200 response, so dedup is synchronous and guaranteed even if the background processing fails.

## Future direction

### Fragment-first capture and synthesis layer

The system captures idea fragments — whatever the user sends, in their own voice. Focused fragments produce the best immediate structuring, but all fragments are valuable raw material. The capture pipeline structures each fragment (title, body, tags, links) and preserves the user's exact words. See `docs/decisions.md` for the fragment-first ADR (2026-03-14).

The planned synthesis layer (#116) will build higher-order structures from accumulated fragments: cluster detection, MOC-like synthesis notes, computed maturity from density and link patterns. This is a design-phase concept — the mechanism, schema implications, and gardener integration are open questions tracked in #116.

### URL handling and input awareness

Two capture-time enhancements remain in scope (issue #27, narrowed):
1. **URL detection** — when a URL is present, the pipeline should handle it differently (fetch content, cross-reference existing notes, build a reference note with real context).
2. **Multi-fragment detection** — surface quality signals when input contains multiple ideas. The fragment is always captured; how and whether to communicate this to the user needs design work (#116).

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

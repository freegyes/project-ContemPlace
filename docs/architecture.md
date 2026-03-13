# Architecture

ContemPlace's irreducible core is the **database + MCP surface**. The database (Supabase with pgvector) stores notes, embeddings, links, and the SKOS vocabulary. The MCP server exposes this to any agent — input via `capture_note`, retrieval via `search_notes`/`search_chunks`/`get_related`, curation via `list_unmatched_tags`/`promote_concept`. Everything else is a module.

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
| **MCP server** | `mcp-contemplace` | Exposes 8 tools to AI agents via JSON-RPC 2.0 over HTTP. Hosts the `CaptureService` entrypoint for Service Binding RPC. | HTTP POST /mcp, Service Binding RPC |
| **Gardener** | `contemplace-gardener` | Nightly enrichment: tag normalization, similarity linking, chunk generation | Cron (02:00 UTC) or POST /trigger |

Each Worker is independently deployed with its own `wrangler.toml` and secrets. They share the same Supabase database and use the same `openai` SDK pattern for OpenRouter calls.

The capture pipeline lives in one place (`mcp/src/pipeline.ts`). The Telegram Worker calls it via a Cloudflare Service Binding — zero-overhead in-process RPC, no HTTP hop, no auth overhead. The Gardener Worker still has its own copy of embedding helpers because its batch-oriented pattern differs from capture-time embedding.

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
 │  4. Dedup (insert update_id)    │ ← 200 if already processed
 │  5. Return 200                  │
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
 │     (10 fields, logged defaults │
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

The MCP Worker implements JSON-RPC 2.0 over HTTP with dual authentication: OAuth 2.1 (Authorization Code + PKCE) for browser-based clients and static Bearer token for API/SDK callers. It exposes 8 tools:

| Tool | Operation |
|---|---|
| `search_notes` | Semantic search via `match_notes()` with optional facet filters |
| `search_chunks` | Chunk-level semantic search via `match_chunks()` for fine-grained RAG |
| `get_note` | Full note retrieval by UUID |
| `list_recent` | Recent notes with optional filtering |
| `get_related` | All linked notes in both directions |
| `capture_note` | Full capture pipeline (same logic as Telegram, synchronous) |
| `list_unmatched_tags` | Tags without SKOS concept matches, for vocabulary curation |
| `promote_concept` | Insert new SKOS concept interactively |

Tool descriptions in `TOOL_DEFINITIONS` (mcp/src/tools.ts) include behavioral guidance for connecting agents — what kind of input to pass, how to interpret results, when to use each tool. The `capture_note` description explicitly instructs agents to pass user's raw words without cleaning up or pre-structuring. Filter enum descriptions explain the classification taxonomy. These descriptions are the only guidance a connecting agent receives about how to use ContemPlace.

The search threshold (`MCP_SEARCH_THRESHOLD`, default 0.35) is lower than the capture threshold (`MATCH_THRESHOLD`, 0.60) because stored embeddings are metadata-augmented while search queries are bare natural language.

## Gardener pipeline

The Gardener Worker runs three phases sequentially, each error-isolated (a failure in one phase doesn't block the others):

```
 Cron trigger (02:00 UTC) or POST /trigger
       │
       ▼
 ┌─────────────────────────────────┐
 │  Phase 1: Tag normalization     │
 │  • Fetch notes + concepts       │
 │  • Lexical match (pref_label    │
 │    + alt_labels) first          │
 │  • Semantic match fallback      │
 │  • batch_update_refined_tags()  │
 │  • Populate note_concepts       │
 │  • Log unmatched tags           │
 ├─────────────────────────────────┤
 │  Phase 2: Similarity linking    │
 │  • find_similar_pairs() RPC     │
 │  • Clean-slate delete + reinsert│
 │  • Auto-context from shared     │
 │    tags + entities              │
 ├─────────────────────────────────┤
 │  Phase 3: Chunk generation      │
 │  • Fetch notes with body > 1500 │
 │  • Body hash idempotency check  │
 │  • Split at paragraph/sentence  │
 │    boundaries (500–800 chars)   │
 │  • Embed all chunks (batched)   │
 │  • Insert chunks + log          │
 └─────────────────────────────────┘
       │
       ▼  on any error
 ┌─────────────────────────────────┐
 │  Best-effort Telegram alert     │
 │  (if TELEGRAM_BOT_TOKEN set)    │
 └─────────────────────────────────┘
```

Subrequest budget is ~16 fixed (within CF Workers' 50 free-tier limit), regardless of note count, thanks to batch RPC functions (`batch_update_refined_tags`, `find_similar_pairs`).

## Two-pass embedding

Every note gets embedded twice:

1. **Raw embedding** — the user's exact input text, embedded before the LLM runs. Used to find related notes via `match_notes()`. This is the lookup embedding.

2. **Augmented embedding** — after the LLM classifies the note, `buildEmbeddingInput()` prepends metadata: `[Type: idea] [Intent: plan] [Tags: cooking, project] The actual text...`. This is stored in the `notes.embedding` column.

The augmented embedding bakes organizational context into the vector space. Two notes about "cooking" and "woodworking" that share the intent `plan` will be slightly closer in vector space than they would be from raw text alone. This matters for downstream retrieval — an agent searching for "things the user is planning" benefits from intent being part of the vector.

If the augmented embedding fails (API error, timeout), the system falls back to the raw embedding and logs an `augmented_embed_fallback` enrichment entry. The note is never lost.

Chunk embeddings use a lighter prefix: `{title} [{tags}]: {chunk_text}` — tags for topic anchoring without type/intent (those are note-level concerns).

The cost of double-embedding is negligible — roughly $0.00001 per note at current `text-embedding-3-small` pricing.

## System prompt structure

The LLM prompt is split into two parts that live in different places:

**System frame** — lives in code (`SYSTEM_FRAME` in `mcp/src/capture.ts`). This is the structural contract: the JSON schema the LLM must return, the allowed values for each enum field, the rules for entity extraction and linking, and the voice correction instructions. It changes only when the data model changes.

**Capture voice** — lives in the database (`capture_profiles` table, fetched at runtime by `getCaptureVoice()`). This is the stylistic layer: how titles should be phrased, how bodies should read, the traceability rule, tone preferences, examples of good and bad output. It can be edited in the Supabase SQL Editor without redeploying.

This split exists because structural changes (adding a new field, a new enum value) require code changes anyway, but stylistic tuning (shorter titles, different tone) should be instant. Any capture interface — Telegram, a future MCP tool, a CLI — fetches the same capture voice from the same table, ensuring consistent note style regardless of entry point.

The user message, related notes (with their type and intent metadata), and today's date are injected as the user turn. Related notes are provided so the LLM can create typed links; the date is provided so it can resolve relative time references ("yesterday", "next week").

## Error handling

The system distinguishes between errors the user should see and errors that need debugging:

- **User-facing:** A generic "Something went wrong" message sent to Telegram. Never includes stack traces, model names, or internal details.
- **Console logs:** Full structured JSON with the error, the input that caused it, and the processing stage. Visible in the Cloudflare Workers dashboard.
- **Gardener alerts:** Best-effort Telegram message to a configured chat ID on pipeline failure. HTML-escaped, truncated to 1000 chars, never throws.

The parser (`parseCaptureResponse`) handles malformed LLM output gracefully. Each of the 10 fields has a fallback default (e.g., invalid type defaults to `idea`, missing intent defaults to `remember`). Every fallback is logged as structured JSON so prompt tuning issues can be diagnosed from logs.

## Deduplication

Telegram can deliver the same webhook multiple times. The `processed_updates` table stores each `update_id` with a unique constraint. Before processing, the Worker attempts an insert — if it hits a `23505` unique violation, the update was already processed and is silently ignored.

This runs *before* the 200 response, so dedup is synchronous and guaranteed even if the background processing fails.

## Future direction: URL handling and input awareness

The system is optimized for atomic notes in the user's own voice. Complex input (brain dumps, multi-topic streams) is the user's responsibility to pre-process — either manually or via an LLM agent using MCP tools.

Two capture-time enhancements remain in scope (issue #27, narrowed):
1. **URL detection** — when a URL is present, the pipeline should handle it differently (fetch content, cross-reference existing notes, build a reference note with real context).
2. **Non-optimal input detection** — warn the user when input doesn't match the system's sweet spot (multi-topic, very long). The note is still captured; the warning is informational (#109).

See `docs/decisions.md` for the full ADR on the storage philosophy decision (2026-03-13).

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

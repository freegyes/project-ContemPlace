# Roadmap

## Phase 1 — Capture pipeline (complete)

The foundation: a Telegram bot backed by a Cloudflare Worker that captures messages into Supabase with pgvector embeddings and semantic linking.

Delivered:
- Telegram webhook handler with async background processing
- Chat ID whitelist and webhook secret verification
- Deduplication via `processed_updates` table
- LLM-generated structured notes (title, body, type, tags, source_ref)
- Semantic search via `match_notes()` RPC with cosine similarity
- Typed links between notes (`extends`, `contradicts`, `supports`, `is-example-of`)
- HTML-formatted Telegram confirmation replies
- Smoke tests against the live Worker

## Phase 1.5 — Enriched capture (complete)

Expanded the data model and capture logic. The schema was rebuilt from scratch (v2) with all Phase 2 infrastructure pre-created.

Delivered:
- **Schema v2:** 8 tables (notes, links, concepts, note_concepts, note_chunks, enrichment_log, capture_profiles, processed_updates) with RLS, HNSW indexes, and seeded data
- **Classification taxonomy:** `intent` (6 values), `modality` (4 values), `entities` (proper nouns with typed categories)
- **Two-pass embedding:** Raw text for lookup, metadata-augmented for storage, with fallback
- **System prompt split:** Structural contract in code (`SYSTEM_FRAME`), stylistic rules in database (`capture_profiles`)
- **Enrichment log:** Audit trail per note per enrichment type, batched inserts
- **Hybrid search:** `match_notes()` with 8 parameters including intent filter and full-text search
- **SKOS concepts:** 10 seeded domain concepts for future tag normalization
- **Parser hardening:** 17 unit tests covering all fallback paths
- **Automated deploy:** `scripts/deploy.sh` runs schema → typecheck → unit tests → Worker deploy → smoke tests
- **Voice correction:** LLM detects and silently fixes transcription errors, reports in Telegram reply

## Phase 2a — MCP server (complete)

Exposes the note database to AI agents via the Model Context Protocol. The primary client is Claude Code (CLI). Deployed as a separate Cloudflare Worker at `mcp-contemplace.adamfreisinger.workers.dev`.

Eight tools:
- **`search_notes`** — semantic search via `match_notes()` with optional type/intent/tag filters
- **`search_chunks`** — chunk-level semantic search via `match_chunks()` for fine-grained RAG retrieval
- **`get_note`** — full note retrieval with linked notes and entity data
- **`list_recent`** — recent notes with optional facet filtering
- **`get_related`** — notes connected to a given note via the `links` table
- **`capture_note`** — full capture pipeline (embed → related lookup → LLM → store), same logic as Telegram but synchronous and source-tagged
- **`list_unmatched_tags`** — tags that haven't matched any SKOS concept, with frequency; for vocabulary curation
- **`promote_concept`** — insert a new concept into the SKOS vocabulary interactively

Auth: single API key (Bearer token). `MCP_SEARCH_THRESHOLD` (default 0.35) is separate from `MATCH_THRESHOLD` (0.60) — bare query vectors score lower against metadata-augmented stored embeddings.

**Tool description enrichment (PR #49)** — All 8 tool descriptions now include behavioral guidance for connecting agents. `capture_note` tells agents to pass raw user words without summarizing or pre-structuring. Filter enums include glosses explaining each value's meaning. `get_note` explains the raw_input vs body distinction. `get_related` includes a link type glossary. This enables agent-driven interaction (e.g., Claude Code CLI) without agents having to guess how the system works.

**Single capture path (PR #90, 2026-03-12):** The Telegram Worker now delegates capture to the MCP Worker via a Cloudflare Service Binding. `mcp/src/pipeline.ts` is the single source of truth for capture logic. ~650 lines of duplicated code removed (`src/capture.ts`, `src/embed.ts`, shared DB functions, parity tests). See `docs/decisions.md` for the full ADR.

In scope after the MCP server is live: import scripts for **ChatGPT memory export** and **Obsidian vault** — standalone Node.js scripts that loop `capture_note` calls with appropriate source tags.

### Real-world test findings (2026-03-10)

First live test against 6 notes via Claude Code confirmed all five tools work correctly. One configuration issue found:

**Threshold mismatch** — `search_notes` returned 0 results at the default threshold (0.60). Dropping to 0.30 surfaced relevant results (scores 0.41–0.49). The root cause is that stored embeddings are metadata-augmented (`[Type: idea] [Intent: plan] [Tags: …] text`) while search queries are bare natural language. The single `MATCH_THRESHOLD` env var was calibrated for capture-time related-note lookup (higher precision needed), not for agent search (broader exploration).

Fix: add `MCP_SEARCH_THRESHOLD` (default 0.35) as a separate config value used only by `handleSearchNotes`. `MATCH_THRESHOLD` (0.60) stays for `findRelatedNotes` inside `capture_note`. See `docs/decisions.md` for full analysis.

**`get_related` UX note** — the tool requires a note `id`. A text-based "find notes related to this topic" lookup is a natural UX expectation. Tracked as a candidate tool (`search_related`?) for a later phase.

## Phase 2b — Gardening pipeline (complete) — issue #2

A separate Cloudflare Worker (`contemplace-gardener`) that enriches the note graph in the background. Runs nightly at 02:00 UTC via cron trigger, also triggerable via `POST /trigger` with Bearer auth. Sends failure alerts to Telegram.

Three phases run sequentially, each error-isolated:

### Similarity linker — delivered (PR #30, v2.1.0)

Pairwise cosine similarity across all notes via `find_similar_pairs` RPC (self-join). Inserts `is-similar-to` links above `GARDENER_SIMILARITY_THRESHOLD` (0.70) with `created_by = 'gardener'` and `confidence` = similarity score. Auto-generated context from shared tags and entities via `buildContext()`. Clean-slate delete + reinsert for idempotency.

### SKOS tag normalization — delivered (PR #41)

Maps free-form note tags to the SKOS controlled vocabulary (`concepts` table). Hybrid matching: lexical match against `pref_label` + `alt_labels` first, embedding similarity fallback at `GARDENER_TAG_MATCH_THRESHOLD` (0.55). Populates `notes.refined_tags` (pref_labels only) and `note_concepts` junction. Unmatched tags logged to `enrichment_log` as `type = 'unmatched_tag'` for curation via MCP tools. Uses `batch_update_refined_tags` RPC to stay within CF Workers subrequest budget. 32 seed concepts across 4 schemes (domains, tools, people, places).

### Chunk generation — delivered (PR #44)

Splits long notes (body > 1500 chars) into ~500–800 char chunks at paragraph boundaries, with sentence and newline fallbacks. Embeds each chunk with title + tag prefix (`{title} [{tags}]: {chunk_text}`). Body hash idempotency via SHA-256 in `enrichment_log.metadata` — only re-chunks when body content changes. Embed-first-insert-second to avoid orphan chunks. Enables `search_chunks` MCP tool for fine-grained RAG retrieval.

### Subrequest budget optimization — delivered (PR #42)

Reduced gardener subrequests from ~12 + 2N to ~16 fixed via two new RPC functions: `batch_update_refined_tags` (JSONB batch UPDATE) and `find_similar_pairs` (self-join replaces N individual `match_notes` calls). At 300 notes: 16 subrequests instead of 612.

### Maturity/importance scoring — deferred

User's mental model is emergent MOC-style graph evolution (maps of content as gravitational centers, freshness = recently linked, density = many relations). Closer to community detection than per-note scoring. Needs real graph patterns to design well. ADR recorded in `docs/decisions.md`.

### Alerting and manual trigger — delivered (PRs #36, #37)

Best-effort Telegram failure alerts (`sendAlert()`). Optional `POST /trigger` endpoint with Bearer auth (`GARDENER_API_KEY`). Integration test exercises the full cycle: capture → trigger → assert DB state.

### Schema infrastructure already in place

The v2 schema was designed with Phase 2 in mind. These columns and tables are now partially populated by the gardener:

- `notes.refined_tags` — populated by tag normalization
- `note_chunks` table — populated by chunk generation
- `note_concepts` junction table — populated by tag normalization
- `concepts` table — 32 seeded concepts with embeddings
- `enrichment_log` — records all gardener activity with metadata

Still unpopulated: `notes.summary`, `notes.categories`, `notes.importance_score` (defaults to NULL), `notes.maturity` (defaults to `seedling`).

## Phase 2c — OAuth 2.1 (mostly complete) — issue #5

Add OAuth 2.1 authentication to the MCP server for browser-based clients (Claude.ai web, ChatGPT, Cursor). Uses `@cloudflare/workers-oauth-provider` with KV-backed opaque tokens and Dynamic Client Registration. Static `MCP_API_KEY` kept permanently for API/SDK callers. Plan doc: `docs/phase-2c-oauth-plan.md`.

Progress:
- **Sub-issue A** — Handler refactor: `handleMcpRequest` extracted, timing-safe auth (PR #63, merged)
- **Sub-issue B** — KV namespace + OAuth dependency: `@cloudflare/workers-oauth-provider@0.3.0` installed, `OAUTH_KV` created, `Env` updated (PR #64, merged)
- **Sub-issue C** — OAuthProvider integration + consent page + static bypass (PR #65, merged)
- **Sub-issue D** — Consent page secured with `CONSENT_SECRET` passphrase (PR #67, merged)

### Sub-issue D — delivered (PR #67)

Closed the open-gate vulnerability on the consent page. Added a `CONSENT_SECRET` Worker secret validated via constant-time comparison on POST `/authorize` before `completeAuthorization()` is called. Wrong or missing passphrase returns 403 with a denial page. Graceful degradation: if `CONSENT_SECRET` is not set, the page works as before with a console warning.

Verified: wrong passphrase rejected, correct passphrase completes OAuth flow, Claude.ai web connector works end-to-end.

### Sub-issue C — delivered (PR #65)

Wired up `@cloudflare/workers-oauth-provider` as the MCP Worker's default export. The library handles OAuth 2.1 Authorization Code + PKCE, DCR, discovery endpoints, token management, and CORS uniformly.

Key design decision: used `resolveExternalToken` callback (the library's extension point for external token validation) instead of a wrapper function for static token bypass. This means all requests go through OAuthProvider — no dual routing, no CORS inconsistency. Static `MCP_API_KEY` callers are handled by the callback with constant-time comparison; OAuth callers go through the full flow.

Delivered:
- `GET /.well-known/oauth-protected-resource` — RFC 9728 metadata (auto-served by library)
- `GET /.well-known/oauth-authorization-server` — RFC 8414 metadata (auto-served by library)
- `POST /register` — Dynamic Client Registration (auto-served by library)
- `GET /authorize` — consent page: client name, redirect URI display, "Approve" button
- `POST /authorize` → `POST /token` — completes OAuth flow
- S256-only PKCE (`allowPlainPKCE: false`), 1h access tokens, 30d refresh with rotation
- Verified end-to-end with Claude.ai web connector (all 8 tools visible and functional)

## Architectural clarification: database + MCP is the core

A product-level insight crystallized during smart capture router design (issue #27): the irreducible core of ContemPlace is the **database + MCP surface**. Everything else is a module.

Three layers:
1. **Input** — anything that puts notes into the database. The `capture_note` MCP tool is the universal input gate. The Telegram bot is one client of it. Any MCP-capable agent (Claude CLI, custom scripts) is equally valid.
2. **Enrichment** — the gardening pipeline. The quality guarantee. Makes raw input useful regardless of how messy it arrived.
3. **Retrieval** — agents query the enriched graph via MCP. Where the value compounds.

The first concrete step was delivered in PR #90: the Telegram Worker delegates capture to the MCP Worker via a Service Binding instead of running its own copy of the pipeline. One capture process, multiple gateways.

Remaining implications:
- The smart capture router should enhance the MCP surface, not just Telegram
- The input quality contract (what must be true for gardening to work) needs formal definition

**Status:** Core architecture implemented. Remaining items tracked in issues #27 and #45.

## Smart Capture Router (in design) — issue #27

The capture pipeline currently handles one input type: text → single structured note. The smart capture router is an architectural evolution where the pipeline detects what kind of input it received and dispatches to the right processing strategy. The user's experience stays the same — toss anything in, forget about it — but the system gets smarter about what it produces.

Planned input handlers:
- **Short note** — current Haiku pipeline, unchanged
- **URL/link** — fetch content, cross-reference existing notes, build a reference note with real context
- **Brain dump** — long stream-of-consciousness input routed to a more capable model that decomposes it into atomic ideas, each captured through the standard pipeline
- **List** — individual items extracted as separate notes

**Research finding:** No shipping PKM product auto-splits at capture time. The industry converged on smarter retrieval or user-initiated splitting. ContemPlace's approach — automatic routing with specialized handlers that all produce standard atomic notes — is novel. The router classifies cheaply (rules first, then lightweight LLM if needed) and dispatches to handlers that may use different models at different costs.

**Status:** Architecture direction decided. Open design questions documented in issue #27 and `docs/decisions.md`. Implementation not started. Depends on the broader "MCP as core" architectural review.

## Phase 3 — Associative trails and beyond (deferred)

**Associative trails** — Curated or auto-generated sequences of notes that tell a story or trace a line of thinking. The `trails` and `trail_steps` tables were designed but not created in v2.

**Type inheritance** — A `note_types` table that defines custom types with inheritance, allowing user-defined specializations beyond the four base types.

**Location extraction** — For input channels that support geotags (future mobile app), extract and store location data.

**Additional input channels** — The capture pipeline is channel-agnostic by design. Adding Slack, email, voice, or a web interface means writing a new entry point that calls the same embed → LLM → store flow. The `source` field records provenance.

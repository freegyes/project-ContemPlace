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

`mcp/src/capture.ts` is a deliberate copy of `src/capture.ts` (Cloudflare Workers cannot share code across Worker projects without monorepo tooling). The `tests/mcp-parser.test.ts` parity tests enforce that the copies stay in sync.

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

## Phase 2c — OAuth 2.1 (next) — issue #5

Add OAuth 2.1 authentication to the MCP server for browser-based clients (Claude.ai web, ChatGPT, Cursor). Uses `@cloudflare/workers-oauth-provider` with KV-backed opaque tokens and Dynamic Client Registration. Static `MCP_API_KEY` kept permanently for API/SDK callers. Plan doc: `docs/phase-2c-oauth-plan.md`.

## Architectural clarification: database + MCP is the core

A product-level insight crystallized during smart capture router design (issue #27): the irreducible core of ContemPlace is the **database + MCP surface**. Everything else is a module.

Three layers:
1. **Input** — anything that puts notes into the database. The `capture_note` MCP tool is the universal input gate. The Telegram bot is one client of it. Any MCP-capable agent (Claude CLI, custom scripts) is equally valid.
2. **Enrichment** — the gardening pipeline. The quality guarantee. Makes raw input useful regardless of how messy it arrived.
3. **Retrieval** — agents query the enriched graph via MCP. Where the value compounds.

This has implications for the existing architecture that need thorough review:
- The Telegram Worker duplicates capture logic instead of calling through MCP
- The smart capture router should enhance the MCP surface, not just Telegram
- The input quality contract (what must be true for gardening to work) needs formal definition
- Several Workers may need to be restructured around MCP as the central interface

**Status:** Recognized as a strategic direction. Needs deeper architectural review before implementation reshapes the Worker topology. Tracked in issue #27.

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

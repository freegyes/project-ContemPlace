# Roadmap

*What each phase delivered and what's next. The narrative arc of the project — where it's been and where it's headed.*

## Phase 1 — Capture pipeline (complete)

The foundation: a Telegram bot backed by a Cloudflare Worker that captures messages into Supabase with pgvector embeddings and semantic linking.

Delivered:
- Telegram webhook handler with async background processing
- Chat ID whitelist and webhook secret verification
- Deduplication via `processed_updates` table
- LLM-generated structured notes (title, body, tags, source_ref)
- Semantic search via `match_notes()` RPC with cosine similarity
- Typed links between notes
- HTML-formatted Telegram confirmation replies
- Smoke tests against the live Worker

## Phase 1.5 — Enriched capture (complete)

Expanded the data model and capture logic. The schema was rebuilt from scratch (v2) with all Phase 2 infrastructure pre-created.

Delivered:
- **Schema v2:** 8 tables with RLS, HNSW indexes, and seeded data (later simplified to 5 tables in v4)
- **Entity extraction:** proper nouns with typed categories (later removed from capture in v3.1.0)
- **Two-pass embedding:** Raw text for lookup, metadata-augmented for storage, with fallback
- **System prompt split:** Structural contract in code (`SYSTEM_FRAME`), stylistic rules in database (`capture_profiles`)
- **Enrichment log:** Audit trail per note per enrichment type, batched inserts
- **Hybrid search:** `match_notes()` with vector + full-text search
- **SKOS concepts:** 10 seeded domain concepts (later removed in v4)
- **Parser hardening:** unit tests covering all fallback paths
- **Automated deploy:** `scripts/deploy.sh` runs schema → typecheck → unit tests → Worker deploy → smoke tests
- **Voice correction:** LLM detects and silently fixes transcription errors, reports in Telegram reply

## Phase 2a — MCP server (complete)

Exposes the note database to AI agents via the Model Context Protocol. The primary client is Claude Code (CLI). Deployed as a separate Cloudflare Worker at `mcp-contemplace.adamfreisinger.workers.dev`.

Originally 8 tools, simplified to 5 in v4.0.0 (removed `search_chunks`, `list_unmatched_tags`, `promote_concept`):
- **`search_notes`** — semantic search via `match_notes()` with optional tag filters
- **`get_note`** — full note retrieval with linked notes
- **`list_recent`** — recent notes, newest first
- **`get_related`** — notes connected to a given note via the `links` table
- **`capture_note`** — full capture pipeline (embed → related lookup → LLM → store), same logic as Telegram but synchronous and source-tagged

Auth: single API key (Bearer token). `MCP_SEARCH_THRESHOLD` (default 0.35) is separate from `MATCH_THRESHOLD` (0.60) — bare query vectors score lower against metadata-augmented stored embeddings.

**Tool description enrichment (PR #49)** — All tool descriptions include behavioral guidance for connecting agents. `capture_note` tells agents to pass raw user words without summarizing or pre-structuring. Filter enums include glosses explaining each value's meaning. `get_note` explains the raw_input vs body distinction. `get_related` includes a link type glossary. This enables agent-driven interaction (e.g., Claude Code CLI) without agents having to guess how the system works.

**Single capture path (PR #90, 2026-03-12):** The Telegram Worker now delegates capture to the MCP Worker via a Cloudflare Service Binding. `mcp/src/pipeline.ts` is the single source of truth for capture logic. ~650 lines of duplicated code removed (`src/capture.ts`, `src/embed.ts`, shared DB functions, parity tests). See `docs/decisions.md` for the full ADR.

In scope after the MCP server is live: import scripts for **ChatGPT memory export** and **Obsidian vault** — standalone Node.js scripts that loop `capture_note` calls with appropriate source tags.

### Real-world test findings (2026-03-10)

First live test against 6 notes via Claude Code confirmed all five tools work correctly. One configuration issue found:

**Threshold mismatch** — `search_notes` returned 0 results at the default threshold (0.60). Dropping to 0.30 surfaced relevant results (scores 0.41–0.49). The root cause is that stored embeddings are metadata-augmented (`[Tags: …] text`) while search queries are bare natural language. The single `MATCH_THRESHOLD` env var was calibrated for capture-time related-note lookup (higher precision needed), not for agent search (broader exploration).
Fix: add `MCP_SEARCH_THRESHOLD` (default 0.35) as a separate config value used only by `handleSearchNotes`. `MATCH_THRESHOLD` (0.60) stays for `findRelatedNotes` inside `capture_note`. See `docs/decisions.md` for full analysis. (Note: augmentation simplified from `[Type: X] [Intent: Y] [Tags: ...] text` to `[Tags: ...] text` in v3.1.0.)

**`get_related` UX note** — the tool requires a note `id`. A text-based "find notes related to this topic" lookup is a natural UX expectation. Tracked as a candidate tool (`search_related`?) for a later phase.

## Phase 2b — Gardening pipeline (complete) — issue #2

A separate Cloudflare Worker (`contemplace-gardener`) that enriches the note graph in the background. Runs nightly at 02:00 UTC via cron trigger, also triggerable via `POST /trigger` with Bearer auth. Sends failure alerts to Telegram.

### Similarity linker — delivered (PR #30, v2.1.0)

Pairwise cosine similarity across all notes via `find_similar_pairs` RPC (self-join). Inserts `is-similar-to` links above `GARDENER_SIMILARITY_THRESHOLD` (0.70) with `created_by = 'gardener'` and `confidence` = similarity score. Auto-generated context from shared tags via `buildContext()`. Clean-slate delete + reinsert for idempotency.

### SKOS tag normalization — delivered (PR #41), removed in v4.0.0

Tag normalization via SKOS controlled vocabulary was delivered but later removed in the v4 schema simplification (#128). Embedding search already handled synonym collapse. The curation burden conflicted with the user's preference. See ADR "Drop SKOS tag normalization" in `decisions.md`.

### Chunk generation — delivered (PR #44), removed in v4.0.0

Chunk generation for long notes was delivered but later removed. No note ever exceeded the 1500-char threshold. Fragment-first philosophy makes long notes unlikely. See ADR "Drop chunking infrastructure" in `decisions.md`.

### Subrequest budget optimization — delivered (PR #42)

Reduced gardener subrequests via batch RPC functions. `find_similar_pairs` (self-join) is the remaining batch function after v4 simplification.

### Alerting and manual trigger — delivered (PRs #36, #37)

Best-effort Telegram failure alerts (`sendAlert()`). Optional `POST /trigger` endpoint with Bearer auth (`GARDENER_API_KEY`). Integration test exercises the full cycle: capture → trigger → assert DB state.

## Phase 2c — OAuth 2.1 (complete) — issue #5 — `v3.0.0`

Added OAuth 2.1 Authorization Code + PKCE to the MCP server for browser-based clients. Uses `@cloudflare/workers-oauth-provider` with KV-backed opaque tokens, Dynamic Client Registration, and S256-only PKCE. Static `MCP_API_KEY` retained permanently for API/SDK callers. Plan doc: `docs/phase-2c-oauth-plan.md`.

### Delivered

- **Sub-issue A** — Handler refactor: `handleMcpRequest` extracted, timing-safe auth (PR #63)
- **Sub-issue B** — KV namespace + OAuth dependency: `@cloudflare/workers-oauth-provider@0.3.0`, `OAUTH_KV` binding (PR #64)
- **Sub-issue C** — OAuthProvider integration: full OAuth flow, `resolveExternalToken` for static token bypass, consent page, discovery endpoints (PR #65)
- **Sub-issue D** — Consent page security: `CONSENT_SECRET` passphrase, constant-time comparison (PR #67)
- OAuth endpoints: `/.well-known/oauth-protected-resource` (RFC 9728), `/.well-known/oauth-authorization-server` (RFC 8414), `/register` (DCR), `/authorize`, `/token`
- 1h access tokens, 30d refresh with rotation, S256-only PKCE
- Verified end-to-end with Claude.ai web connector (all tools visible and functional; later reduced from 8 to 5 in v4.0.0)

Cursor and ChatGPT connector verification deferred to #102 — not blocking.

## Architectural clarification: database + MCP is the core

A product-level insight crystallized during smart capture router design (issue #27): the irreducible core of ContemPlace is the **database + MCP surface**. Everything else is a module.

Three layers:
1. **Input** — anything that puts notes into the database. The `capture_note` MCP tool is the universal input gate. The Telegram bot is one client of it. Any MCP-capable agent (Claude CLI, custom scripts) is equally valid.
2. **Enrichment** — the gardening pipeline. The quality guarantee. Makes raw input useful regardless of how messy it arrived.
3. **Retrieval** — agents query the enriched graph via MCP. Where the value compounds.

The first concrete step was delivered in PR #90: the Telegram Worker delegates capture to the MCP Worker via a Service Binding instead of running its own copy of the pipeline. One capture process, multiple gateways.

**Status:** Core architecture implemented and stable as of v4.0.0.

## Smart Capture Router — closed (issue #27)

**Closed 2026-03-14.** The smart capture router concept was superseded by the single capture path (PR #90) and fragment-first philosophy (#116). All inputs go through `capture_note` uniformly.

The one remaining idea — input-aware enrichment where the pipeline detects special patterns (URLs, citations) and takes extra extraction steps while still following the same route — is a separate exploration, not a "router." No issue open for this yet; it'll surface through real-world usage.

## v3.1.0 — Leaner capture pipeline (complete) — issue #110

Removed `type`, `intent`, and `modality` from the entire capture pipeline. Clean-slate v3 schema consolidating 10 migrations into one. Capture voice updated with #108 body rules.

Delivered:
- **7-field LLM contract** — removed type (4-way), intent (6-way), modality (4-way) from SYSTEM_FRAME and parser
- **Simplified embeddings** — format changed from `[Type: X] [Intent: Y] [Tags: ...] text` to `[Tags: ...] text`
- **Leaner MCP tools** — `filter_type`/`filter_intent` removed from `search_notes` and `list_recent`
- **Cleaner Telegram replies** — metadata line shows tags only
- **Capture voice v2** — no compression, no length heuristic, "transcription not synthesis" explicit
- **Corpus re-captured** — 81 notes re-captured from `raw_input` in the new vector space with updated voice
- Net -839 lines across 31 files

## v4.0.0 — Schema simplification bundle (complete) — issue #128, PR #131

Bundled removal of SKOS vocabulary (#122), link type simplification (#124), chunking removal (#127), and maturity/importance_score column drops (#117) into a single schema migration.

Delivered:
- **Schema v4:** Dropped 3 tables (`concepts`, `note_concepts`, `note_chunks`), 3 columns (`refined_tags`, `maturity`, `importance_score`), 2 RPC functions (`match_chunks`, `batch_update_refined_tags`). 8 tables → 5.
- **Link type simplification:** 9 types → 3. Capture-time: `contradicts` + `related` (replaces `extends`/`supports`/`is-example-of`/`duplicate-of`). Gardening-time: `is-similar-to`. Existing links reclassified via migration.
- **MCP Worker:** 8 → 5 tools. Removed `search_chunks`, `list_unmatched_tags`, `promote_concept`.
- **Gardener Worker:** Similarity linking only. Removed tag normalization, chunk generation, `embed.ts`, `normalize.ts`, `chunk.ts`. Removed `OPENROUTER_API_KEY`, `EMBED_MODEL`, `GARDENER_TAG_MATCH_THRESHOLD` config.
- **Tests:** Deleted 4 test files. 210 tests pass across 12 files.
- **Net:** +110 / -2,759 lines

## archive_note — Minimum viable curation (complete) — issue #87, PR #140

The first editorial tool: `archive_note` gives agents the ability to remove notes from the knowledge graph, completing the capture-review-recapture loop that was impossible without direct DB access.

Delivered:
- **`archive_note` MCP tool** — grace-window hybrid: notes younger than `HARD_DELETE_WINDOW_MINUTES` (default 11) are hard-deleted (CASCADE cleans links + enrichment_log), older notes are soft-archived (`archived_at = now()`, recoverable via direct DB)
- **Archived note filtering** — `fetchNote`, `listRecentNotes`, and `fetchNoteLinks` now filter `archived_at IS NULL`. Archived notes are invisible across all MCP tools. Links to archived notes filtered out of `get_related` responses.
- **Idempotent** — calling `archive_note` on an already-archived note returns success, not "not found"
- **No update, no merge** — derived from first principles: `raw_input` is the only real data, everything else is pipeline-computed. Update fights the pipeline. Merge has no coherent `raw_input` semantics. Delete is the only operation that follows. Issues #88, #89, #98 closed.

The design was derived linearly from the core architecture: since everything in the system is computed from `raw_input`, the only meaningful editorial operation is removal. The grace-window hybrid limits blast radius for untrusted MCP agents (soft delete = recoverable) while keeping the on-the-go correction loop clean (hard delete = no ghost rows for immediate mistakes).

## Telegram /undo command (complete) — issue #142, PR #143

The first Telegram bot command beyond `/start`: `/undo` hard-deletes the most recent Telegram capture within the grace window. Source-scoped (Telegram only), grace-window-only (refuses after 11 min), no soft-archive path.

Delivered:
- **`/undo` command** — exact match on `/undo`, placed after chat ID whitelist and before dedup (no note created, no dedup needed)
- **`CaptureService.undoLatest()`** — Service Binding RPC method with source-filtered query (`fetchMostRecentBySource`)
- **Three outcomes:** deleted (within grace window), refused (grace period passed), nothing to undo (no Telegram captures)
- **Bot command registration** — both `/start` and `/undo` registered via Telegram `setMyCommands` API
- **9 unit tests** covering grace window, boundary, custom config, error propagation

## Phase 3 — Associative trails and beyond (deferred)

**Associative trails** — Curated or auto-generated sequences of notes that tell a story or trace a line of thinking. The `trails` and `trail_steps` tables were designed but not created in v2.

**Location extraction** — For input channels that support geotags (future mobile app), extract and store location data.

**Additional input channels** — The capture pipeline is channel-agnostic by design. Adding Slack, email, voice, or a web interface means writing a new entry point that calls the same embed → LLM → store flow. The `source` field records provenance.

# Roadmap

## Phase 1 — Capture pipeline (complete)

The foundation: a Telegram bot backed by a Cloudflare Worker that captures messages into Supabase with pgvector embeddings and semantic linking.

Delivered:
- Telegram webhook handler with async background processing
- Chat ID whitelist and webhook secret verification
- Deduplication via `processed_updates` table
- LLM-generated structured notes (title, body, tags, source_ref)
- Semantic search via `match_notes()` RPC with cosine similarity
- Typed links between notes (`extends`, `contradicts`, `supports`, `is-example-of`)
- HTML-formatted Telegram confirmation replies
- Smoke tests against the live Worker

## Phase 1.5 — Enriched capture (complete)

Expanded the data model and capture logic. The schema was rebuilt from scratch (v2) with all Phase 2 infrastructure pre-created.

Delivered:
- **Schema v2:** 8 tables (notes, links, concepts, note_concepts, note_chunks, enrichment_log, capture_profiles, processed_updates) with RLS, HNSW indexes, and seeded data
- **Entity extraction:** proper nouns with typed categories (person, place, tool, project, concept)
- **Two-pass embedding:** Raw text for lookup, metadata-augmented for storage, with fallback
- **System prompt split:** Structural contract in code (`SYSTEM_FRAME`), stylistic rules in database (`capture_profiles`)
- **Enrichment log:** Audit trail per note per enrichment type, batched inserts
- **Hybrid search:** `match_notes()` with vector + full-text search
- **SKOS concepts:** 10 seeded domain concepts for future tag normalization
- **Parser hardening:** unit tests covering all fallback paths
- **Automated deploy:** `scripts/deploy.sh` runs schema → typecheck → unit tests → Worker deploy → smoke tests
- **Voice correction:** LLM detects and silently fixes transcription errors, reports in Telegram reply

## Phase 2a — MCP server (complete)

Exposes the note database to AI agents via the Model Context Protocol. The primary client is Claude Code (CLI). Deployed as a separate Cloudflare Worker at `mcp-contemplace.adamfreisinger.workers.dev`.

Eight tools:
- **`search_notes`** — semantic search via `match_notes()` with optional tag filters
- **`search_chunks`** — chunk-level search (being removed — #127)
- **`get_note`** — full note retrieval with linked notes and entity data
- **`list_recent`** — recent notes, newest first
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

**Threshold mismatch** — `search_notes` returned 0 results at the default threshold (0.60). Dropping to 0.30 surfaced relevant results (scores 0.41–0.49). The root cause is that stored embeddings are metadata-augmented (`[Tags: …] text`) while search queries are bare natural language. The single `MATCH_THRESHOLD` env var was calibrated for capture-time related-note lookup (higher precision needed), not for agent search (broader exploration).
Fix: add `MCP_SEARCH_THRESHOLD` (default 0.35) as a separate config value used only by `handleSearchNotes`. `MATCH_THRESHOLD` (0.60) stays for `findRelatedNotes` inside `capture_note`. See `docs/decisions.md` for full analysis. (Note: augmentation simplified from `[Type: X] [Intent: Y] [Tags: ...] text` to `[Tags: ...] text` in v3.1.0.)

**`get_related` UX note** — the tool requires a note `id`. A text-based "find notes related to this topic" lookup is a natural UX expectation. Tracked as a candidate tool (`search_related`?) for a later phase.

## Phase 2b — Gardening pipeline (complete) — issue #2

A separate Cloudflare Worker (`contemplace-gardener`) that enriches the note graph in the background. Runs nightly at 02:00 UTC via cron trigger, also triggerable via `POST /trigger` with Bearer auth. Sends failure alerts to Telegram.

Three phases run sequentially, each error-isolated:

### Similarity linker — delivered (PR #30, v2.1.0)

Pairwise cosine similarity across all notes via `find_similar_pairs` RPC (self-join). Inserts `is-similar-to` links above `GARDENER_SIMILARITY_THRESHOLD` (0.70) with `created_by = 'gardener'` and `confidence` = similarity score. Auto-generated context from shared tags and entities via `buildContext()`. Clean-slate delete + reinsert for idempotency.

### SKOS tag normalization — delivered (PR #41)

Maps free-form note tags to the SKOS controlled vocabulary (`concepts` table). Hybrid matching: lexical match against `pref_label` + `alt_labels` first, embedding similarity fallback at `GARDENER_TAG_MATCH_THRESHOLD` (0.55). Populates `notes.refined_tags` (pref_labels only) and `note_concepts` junction. Unmatched tags logged to `enrichment_log` as `type = 'unmatched_tag'` for curation via MCP tools. Uses `batch_update_refined_tags` RPC to stay within CF Workers subrequest budget. 32 seed concepts across 4 schemes (domains, tools, people, places).

### Chunk generation — delivered (PR #44), being removed (#127)

> **Decision (2026-03-14):** Chunking infrastructure scheduled for removal. No note has ever exceeded the 1500-char threshold. Fragment-first philosophy makes long notes unlikely. Even in the synthesis layer future, fragments are the natural retrieval units. See ADR in `decisions.md`. Removal bundled with schema simplification (#117 + #122 + #124 + #127).

Splits long notes (body > 1500 chars) into ~500–800 char chunks at paragraph boundaries, with sentence and newline fallbacks. Embeds each chunk with title + tag prefix (`{title} [{tags}]: {chunk_text}`). Body hash idempotency via SHA-256 in `enrichment_log.metadata` — only re-chunks when body content changes. Embed-first-insert-second to avoid orphan chunks. Enables `search_chunks` MCP tool for fine-grained RAG retrieval.

### Subrequest budget optimization — delivered (PR #42)

Reduced gardener subrequests from ~12 + 2N to ~16 fixed via two new RPC functions: `batch_update_refined_tags` (JSONB batch UPDATE) and `find_similar_pairs` (self-join replaces N individual `match_notes` calls). At 300 notes: 16 subrequests instead of 612.

### Maturity/importance scoring — deferred, approach revised

Per-note maturity labels (seedling/budding/evergreen) and importance scores are rejected as a design direction (ADR 2026-03-14, #116). Maturity is a computed analytical proxy inferred from density, clustering, and link patterns — not a label assigned to individual notes. The `maturity` and `importance_score` columns exist in the schema but are unpopulated and may be dropped or repurposed. See #116 for the broader fragment-first philosophy that drives this change.

### Alerting and manual trigger — delivered (PRs #36, #37)

Best-effort Telegram failure alerts (`sendAlert()`). Optional `POST /trigger` endpoint with Bearer auth (`GARDENER_API_KEY`). Integration test exercises the full cycle: capture → trigger → assert DB state.

### Schema infrastructure already in place

The v2 schema was designed with Phase 2 in mind. These columns and tables are now partially populated by the gardener:

- `notes.refined_tags` — populated by tag normalization
- `note_concepts` junction table — populated by tag normalization
- `concepts` table — 32 seeded concepts with embeddings
- `enrichment_log` — records all gardener activity with metadata

Still unpopulated: `notes.summary`, `notes.categories`, `notes.importance_score` (defaults to NULL), `notes.maturity` (defaults to `seedling`).

## Phase 2c — OAuth 2.1 (complete) — issue #5 — `v3.0.0`

Added OAuth 2.1 Authorization Code + PKCE to the MCP server for browser-based clients. Uses `@cloudflare/workers-oauth-provider` with KV-backed opaque tokens, Dynamic Client Registration, and S256-only PKCE. Static `MCP_API_KEY` retained permanently for API/SDK callers. Plan doc: `docs/phase-2c-oauth-plan.md`.

### Delivered

- **Sub-issue A** — Handler refactor: `handleMcpRequest` extracted, timing-safe auth (PR #63)
- **Sub-issue B** — KV namespace + OAuth dependency: `@cloudflare/workers-oauth-provider@0.3.0`, `OAUTH_KV` binding (PR #64)
- **Sub-issue C** — OAuthProvider integration: full OAuth flow, `resolveExternalToken` for static token bypass, consent page, discovery endpoints (PR #65)
- **Sub-issue D** — Consent page security: `CONSENT_SECRET` passphrase, constant-time comparison (PR #67)
- OAuth endpoints: `/.well-known/oauth-protected-resource` (RFC 9728), `/.well-known/oauth-authorization-server` (RFC 8414), `/register` (DCR), `/authorize`, `/token`
- 1h access tokens, 30d refresh with rotation, S256-only PKCE
- Verified end-to-end with Claude.ai web connector (all 8 tools visible and functional)

Cursor and ChatGPT connector verification deferred to #102 — not blocking.

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

## Smart Capture Router (narrowed scope) — issue #27

**Updated 2026-03-14:** The smart capture router's scope has narrowed following the fragment-first decision (#116). The system captures idea fragments without pressuring atomicity. Complex input pre-processing is the user's choice (via their own LLM agent or manual decomposition), not a system requirement.

What remains:
- **URL detection** — when a URL is present, the capture pipeline handles it differently (fetch content, cross-reference, build reference note). Confirmed as worth special care.
- **Multi-fragment detection** — surface quality signals when input contains multiple ideas. The fragment is always captured. How and whether to communicate this to the user needs design work.

What moved to user-side:
- **Brain dumps** — the user decomposes via an LLM agent (Claude.ai via OAuth MCP, Claude Code) before capturing. The MCP agent training pattern (#107) teaches agents how to help with this.
- **Lists** — the user or agent splits items before capturing.

**Status:** Narrowed scope. URL handling is the main remaining system-side feature.

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

## Phase 3 — Associative trails and beyond (deferred)

**Associative trails** — Curated or auto-generated sequences of notes that tell a story or trace a line of thinking. The `trails` and `trail_steps` tables were designed but not created in v2.

**Location extraction** — For input channels that support geotags (future mobile app), extract and store location data.

**Additional input channels** — The capture pipeline is channel-agnostic by design. Adding Slack, email, voice, or a web interface means writing a new entry point that calls the same embed → LLM → store flow. The `source` field records provenance.

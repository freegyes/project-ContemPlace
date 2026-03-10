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

Five tools:
- **`search_notes`** — semantic search via `match_notes()` with optional type/intent/tag filters
- **`get_note`** — full note retrieval with linked notes and entity data
- **`list_recent`** — recent notes with optional facet filtering
- **`get_related`** — notes connected to a given note via the `links` table
- **`capture_note`** — full capture pipeline (embed → related lookup → LLM → store), same logic as Telegram but synchronous and source-tagged

Auth: single API key (Bearer token). The `search_chunks` tool is deferred to Phase 2b — it depends on the chunk generation pipeline.

`mcp/src/capture.ts` is a deliberate copy of `src/capture.ts` (Cloudflare Workers cannot share code across Worker projects without monorepo tooling). The `tests/mcp-parser.test.ts` parity tests enforce that the copies stay in sync.

In scope after the MCP server is live: import scripts for **ChatGPT memory export** and **Obsidian vault** — standalone Node.js scripts that loop `capture_note` calls with appropriate source tags.

See `reviews/13-mcp-plan.md` for the full implementation plan and `reviews/14-16` for specialist reviews.

### Real-world test findings (2026-03-10)

First live test against 6 notes via Claude Code confirmed all five tools work correctly. One configuration issue found:

**Threshold mismatch** — `search_notes` returned 0 results at the default threshold (0.60). Dropping to 0.30 surfaced relevant results (scores 0.41–0.49). The root cause is that stored embeddings are metadata-augmented (`[Type: idea] [Intent: plan] [Tags: …] text`) while search queries are bare natural language. The single `MATCH_THRESHOLD` env var was calibrated for capture-time related-note lookup (higher precision needed), not for agent search (broader exploration).

Fix: add `MCP_SEARCH_THRESHOLD` (default 0.35) as a separate config value used only by `handleSearchNotes`. `MATCH_THRESHOLD` (0.60) stays for `findRelatedNotes` inside `capture_note`. See `docs/decisions.md` for full analysis.

**`get_related` UX note** — the tool requires a note `id`. A text-based "find notes related to this topic" lookup is a natural UX expectation. Tracked as a candidate tool (`search_related`?) for a later phase.

## Phase 2b — Gardening pipeline (next)

A scheduled background process (Cloudflare Cron Trigger) that runs nightly to enrich the note graph without any user action:

**Similarity linking** — Pairwise cosine similarity across all notes. Insert `is-similar-to` links above a threshold (~0.80) with `created_by = 'gardener'` and `confidence` = similarity score.

**Tag normalization via SKOS** — Embed each concept's `pref_label + definition`. Map note tags to nearest concept by cosine similarity. Populate `note_concepts` and `refined_tags`.

**Chunk generation** — Split notes exceeding ~500 tokens into overlapping ~300-token chunks. Embed each chunk and insert into `note_chunks`. Enables fine-grained RAG via `match_chunks()`.

**Maturity scoring** — Compute `importance_score` from inbound link count, recency, and type weighting. Update `maturity` from `seedling` → `budding` → `evergreen`.

Phase 2b is deliberately sequenced after the MCP server so the Obsidian and ChatGPT imports can seed the database first — gardening produces better results with more notes in the corpus.

### Schema infrastructure already in place

The v2 schema was designed with Phase 2 in mind. These columns and tables exist but are currently unpopulated:

- `notes.summary`, `notes.refined_tags`, `notes.categories`, `notes.metadata`
- `notes.importance_score`, `notes.maturity` (defaults to `seedling`)
- `note_chunks` table with HNSW index
- `note_concepts` junction table
- `concepts` table with seeded vocabulary
- `match_chunks()` RPC function
- `links` table supports gardening-time types (`is-similar-to`, `is-part-of`, `follows`, `is-derived-from`) with `created_by = 'gardener'`
- `enrichment_log` supports any enrichment type string

No schema migration will be needed for Phase 2.

## Phase 3 — Associative trails and beyond (deferred)

**Associative trails** — Curated or auto-generated sequences of notes that tell a story or trace a line of thinking. The `trails` and `trail_steps` tables were designed but not created in v2.

**Type inheritance** — A `note_types` table that defines custom types with inheritance, allowing user-defined specializations beyond the four base types.

**Location extraction** — For input channels that support geotags (future mobile app), extract and store location data.

**Additional input channels** — The capture pipeline is channel-agnostic by design. Adding Slack, email, voice, or a web interface means writing a new entry point that calls the same embed → LLM → store flow. The `source` field records provenance.

# Design decisions

*Architecture Decision Records — timestamped and immutable. When a decision changes, a new entry is added; old entries are never edited. This is the historical record of why things are the way they are.*

Many decisions were refined through specialist reviews during the project bootstrap (see `reviews/` directory).

## Cloud-only, no Docker

**Decision:** Develop against the live Supabase project directly. No local Postgres, no Docker compose, no local Supabase stack.

**Why:** Docker-based local development adds operational complexity that isn't justified for a single-user system. The cloud project is always in sync with production. The tradeoff is no offline development, but the system requires network access anyway (OpenRouter, Telegram).

**Source:** `reviews/01-preferences.md`

## Smoke tests over unit tests

**Decision:** The primary test strategy is smoke tests against the live deployed Worker, not unit tests of internal functions.

**Why:** The internal functions are thin orchestrators — unit testing them would mostly mean mocking Supabase, OpenRouter, and Telegram, which tests the mocks more than the code. Smoke tests verify the actual integration: real webhook → real LLM → real database → real Telegram reply.

The exception is `parseCaptureResponse`, which is a pure function with complex validation logic. It has 17 dedicated unit tests because it handles untrusted LLM output and the fallback behavior matters.

**Source:** `reviews/01-preferences.md`, `reviews/12-v2-testing.md`

## OpenRouter as the AI gateway

**Decision:** All AI calls (embeddings and chat completions) route through OpenRouter at `https://openrouter.ai/api/v1`, using the `openai` npm package with a `baseURL` override.

**Why:** Model agnosticism. The capture model and embedding model are environment variables. Switching from Haiku to Sonnet, or from `text-embedding-3-small` to a different model, is a one-line config change. OpenRouter's OpenAI-compatible API means the same SDK works for everything.

**Tradeoff:** Added latency (one extra hop) and a dependency on OpenRouter's availability. Acceptable for a personal system; might reconsider for a multi-user service.

## Async capture via ctx.waitUntil()

**Decision:** Return HTTP 200 to Telegram immediately, then process the capture asynchronously in `ctx.waitUntil()`.

**Why:** Telegram webhooks have a timeout. If the Worker takes too long to respond, Telegram retries — and can eventually disable the webhook entirely. The capture pipeline involves two embedding calls, a database RPC, and an LLM call, which can take 5–15 seconds total. Returning 200 first eliminates all timeout concerns.

**Source:** `reviews/03-integrations.md`

## Two-pass embedding

**Decision:** Embed the raw text first (for finding related notes), then re-embed with metadata augmentation (for storage).

**Why:** When the raw message arrives, we don't yet know its type, intent, or tags — the LLM hasn't run yet. But we need the embedding to find related notes *before* calling the LLM. So the first embedding uses raw text.

After the LLM classifies the note, we re-embed with metadata prepended: `[Type: idea] [Intent: plan] [Tags: cooking, project] The actual text...`. This bakes organizational context into the vector, so downstream retrieval can distinguish between notes that share text but differ in intent.

If the second embedding fails, we fall back to the raw one. A note with a slightly less precise embedding is better than no note at all.

**Cost:** Approximately $0.00001 per note for the extra embedding call.

## System frame / capture voice split

**Decision:** The LLM system prompt is split into a structural contract (in code) and a stylistic voice (in the database).

**Why:** Structural changes (new fields, new enum values) require code deployment and testing anyway. But stylistic changes (shorter titles, different tone, adjusted examples) are iterative tuning that should happen without deployment. Storing the capture voice in `capture_profiles` means editing a database row is all it takes.

This also ensures any future capture interface (MCP, CLI, Slack) fetches the same voice from the same table, producing uniform note style regardless of entry point.

**Source:** `reviews/10-v2-prompt-engineering.md`

## MATCH_THRESHOLD at 0.60

**Decision:** Lowered from 0.65 to 0.60 after real usage.

**Why:** At 0.65, sibling notes (e.g., two kitchen improvement projects) weren't surfacing as related. They share intent and domain but differ in specifics, putting them just below threshold. 0.60 surfaces these while still filtering noise.

This is an environment variable, adjustable without redeployment.

**Follow-up (2026-03-10):** Real-world MCP testing (6 notes) showed that 0.60 is too high for the `search_notes` tool — see the decision below on embedding space mismatch.

## Embedding space mismatch between capture and search

**Decision (open — not yet resolved):** Stored embeddings are metadata-augmented (`[Type: idea] [Intent: plan] [Tags: workstation, diy] slide-out tray for cutting mat…`). MCP `search_notes` embeds bare natural-language queries. The two vectors live in different parts of the space, which inflates the effective distance and makes the 0.60 threshold too aggressive for agent search.

**Observed in real-world MCP testing (2026-03-10):** queries like "furniture", "workspace organization", and "IKEA" returned 0 results at 0.60. At 0.30–0.35, the expected notes surfaced with scores of 0.41–0.49. The pipeline is not broken — embeddings generate and similarity computes correctly — the threshold is calibrated for the wrong use-case.

**Root cause:** The metadata-augmented embedding was designed for retrieval precision at capture time (finding closely related notes to contextualize a new one). That use-case benefits from higher specificity. Agent search is broader and exploratory; an agent asking "what do I have about workspace organization?" should see anything loosely relevant, not just near-duplicates.

**Three options:**

1. **Separate thresholds** — introduce a `MCP_SEARCH_THRESHOLD` env var (default ~0.35) distinct from `MATCH_THRESHOLD` (used for capture-time `findRelatedNotes`, stays at 0.60). This is the minimal fix: no re-embedding, no behavioral change to capture.

2. **Query augmentation** — before embedding a search query, prepend a best-guess metadata prefix. Impractical: the agent doesn't know the type/intent of results before searching. Chicken-and-egg.

3. **Strip prefix from stored embeddings** — remove the metadata augmentation and rely on separate `filter_type`/`filter_intent` parameters for precision. Requires re-embedding all notes.

**Recommendation:** Option 1. Add `MCP_SEARCH_THRESHOLD` (default 0.35) to `mcp/src/config.ts`, use it as the default in `handleSearchNotes` while keeping `MATCH_THRESHOLD` (0.60) for `handleCaptureNote`'s internal `findRelatedNotes` call. Users can still override per-call via the `threshold` argument.

## Traceability rule in the capture voice

**Decision:** Every sentence in the body must trace back to something the user actually said.

**Why:** Haiku (the capture LLM) reliably adds a concluding sentence that synthesizes or names what the user's words already showed. For example, input "I like painting pebbles with Aztec patterns" would produce a body ending with "The geometric motifs of Aztec design could translate well onto curved stone surfaces" — a sentence the user never said.

The traceability rule is an explicit prohibition. The body should be a cleaned-up transcription, not an interpretation. The user's raw input is the source of truth.

## reflection type requires explicit signal

**Decision:** The `reflection` type is only assigned when the user's words contain an explicit signal of personal resonance ("this resonates", "I realized", "I felt"). Topic alone is never sufficient.

**Why:** Early usage showed the LLM classifying any note about inner life, mindfulness, or personal growth as `reflection` based on topic. A note saying "meditation apps are trending" would be classified as a reflection even though it's clearly an observation. The explicit-signal rule fixed this.

## supports link type covers sibling ideas

**Decision:** The `supports` link type was broadened to cover parallel/sibling ideas working toward the same goal, not just "provides evidence for."

**Why:** Two notes about different kitchen improvement projects (e.g., "build a spice rack" and "install under-cabinet lighting") share a goal but don't extend, contradict, or exemplify each other. Without a fitting link type, the LLM skipped linking entirely. Broadening `supports` to include "parallel effort toward the same goal" fixed this.

## LANGUAGE PLPGSQL for RPC functions

**Decision:** `match_notes` and `match_chunks` use `LANGUAGE PLPGSQL` instead of `LANGUAGE SQL`.

**Why:** The Supabase CLI's `--linked` mode runs migrations through a connection pooler that pipelines SQL statements. `LANGUAGE SQL` functions are validated at creation time — Postgres checks that referenced tables exist during the `Parse` phase. In the pooler's pipeline, the `Parse` for the function can execute before the `CREATE TABLE` for `notes` has been committed. `LANGUAGE PLPGSQL` defers validation to execution time, avoiding this race condition entirely.

**Tradeoff:** `LANGUAGE SQL` functions can be inlined by the query planner for better performance. In practice, these functions run semantic search queries that are dominated by the HNSW index scan — function call overhead is negligible.

## RLS deny-all with service role bypass

**Decision:** All tables have RLS enabled with a blanket `deny all` policy. The Worker uses the service role key exclusively.

**Why:** Defense in depth. The anon key is never used, but if it were ever exposed, it would have zero access. The service role key bypasses RLS by design.

**Source:** `reviews/02-security.md`, `reviews/08-v2-security.md`

## No Edge Functions

**Decision:** Supabase is used as a database only. All compute runs on Cloudflare Workers. No Supabase Edge Functions.

**Why:** Edge Functions add a second deployment target, a second runtime (Deno), and a second set of logs to monitor. The Worker handles everything — webhook verification, LLM calls, database writes, Telegram replies. Keeping compute in one place simplifies deployment, debugging, and the mental model.

## Error transparency, never silent failure

**Decision:** All errors surface a user-facing Telegram message. All errors also log full structured JSON to the Worker console.

**Why:** The user should never send a message and wonder what happened. The error message is generic ("Something went wrong"), but its presence confirms the system received and attempted to process the input. Detailed diagnostics go to logs, not to Telegram.

**Source:** `reviews/01-preferences.md`

## Gardener as a separate Cloudflare Worker project

**Decision (2026-03-10):** The gardening pipeline lives in `gardener/` with its own `wrangler.toml`, separate from the Telegram Worker and MCP Worker.

**Why:** The gardener only needs `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`. It does not need `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `MCP_API_KEY`, or `OPENROUTER_API_KEY` (no LLM calls for similarity linking). Keeping secrets scoped to the Worker that needs them is defense in depth. The separation also follows the precedent set by `mcp/` and keeps each Worker's logs, deployments, and failure domains independent.

**Tradeoff:** Three separate deployment targets to manage. Mitigated by `scripts/deploy.sh` which deploys all three in sequence.

## Gardener similarity linker: clean-slate idempotency

**Decision (2026-03-10):** Each gardener run begins by deleting all `is-similar-to` links with `created_by = 'gardener'`, then re-inserting from scratch.

**Why:** Append-only with conflict detection leaves stale links when the threshold is raised — pairs linked at 0.70 persist even if the threshold moves to 0.80. The clean-slate approach ensures the link set always reflects the current threshold with zero reconciliation logic. At personal-system scale (hundreds to a few thousand notes), the DELETE is a trivial operation. The DELETE runs first so a mid-run crash leaves a partially-populated but not corrupted state; the next run's DELETE cleans it up.

## Gardener similarity linker: link direction convention

**Decision (2026-03-10):** `is-similar-to` links are stored once per pair, with the lexicographically lower UUID as `from_id`.

**Why:** `is-similar-to` is semantically undirected, but the `links` table is directed. Storing both directions doubles storage and causes `get_related` to return the same note twice (once for each direction row). `fetchNoteLinks` already queries `.or('from_id.eq.${id},to_id.eq.${id}')`, so a single directional row is found from either end. The UUID-ordering convention is deterministic and applied consistently at insert time.

## Gardener similarity threshold: 0.70 for augmented-vs-augmented comparison

**Decision (2026-03-10):** `GARDENER_SIMILARITY_THRESHOLD` defaults to 0.70. This is calibrated for augmented-vs-augmented embedding comparison, which is distinct from the capture-time and MCP search thresholds.

**Why:** The similarity linker compares stored augmented embeddings against each other (both sides have the same `[Type: X] [Intent: Y] [Tags: ...]` prefix structure). This is a tighter, more symmetric comparison than capture-time `findRelatedNotes` (raw query vs. augmented store, threshold 0.60) or MCP `search_notes` (bare natural-language query vs. augmented store, threshold 0.35).

Empirical basis from 14-note live DB (issue #20): linked pairs scored 0.57–0.77 (avg 0.66); unrelated pairs peaked at 0.64. Setting the threshold at 0.70 creates clear separation while surfacing genuinely related notes that capture-time linking missed (e.g. the pegboard/lamp pair at 0.80).

These three thresholds are independent and should not be conflated:
- `MATCH_THRESHOLD` (0.60) — raw query vs. augmented store, capture-time related-note lookup
- `MCP_SEARCH_THRESHOLD` (0.35) — bare natural-language query vs. augmented store, agent search
- `GARDENER_SIMILARITY_THRESHOLD` (0.70) — augmented vs. augmented, nightly similarity linking

## Gardener trigger model: fixed nightly cron over event-driven alternatives

**Decision (2026-03-10):** The gardener runs on a fixed nightly Cron Trigger (`0 2 * * *`) rather than being triggered by note captures, accumulation thresholds, or DB events.

**Why fixed cron is correct at this stage:**

The system is designed for async enrichment. Capture already provides immediate context — `findRelatedNotes` runs at capture time and surfaces related notes in the Telegram reply. Similarity links from the gardener are a lower-urgency, corpus-wide signal. A 24-hour lag is acceptable for that use case.

Fixed cron and clean-slate idempotency are a natural pair. The gardener always re-scans everything and rebuilds from scratch. That property only makes sense with a periodic batch model. Event-driven triggering per capture would require switching to incremental per-note processing — dropping clean-slate, adding a cursor, and handling race conditions between concurrent triggers. That's a different and more complex architecture, not a better one.

At personal scale, the cost of "wasted" runs on days with no new notes is zero — the run takes a few seconds and costs nothing.

**Why alternatives were rejected:**

- **Per-capture triggering** — the capture pipeline already runs `findRelatedNotes` for immediate linking. Triggering a full corpus re-scan after every note is O(N) re-scans per session. It also breaks clean-slate by requiring incremental processing.
- **Accumulation threshold ("run when N new notes exist")** — Cloudflare doesn't support conditional cron triggers natively. You'd still poll via cron and add a short-circuit check at the top. Worth adding as a guard once runs get long enough to matter; not worth it now.
- **Supabase DB webhooks** — same problem as per-capture triggering, with added complexity (pg_net, HTTP calls from within Postgres, network reliability concerns).
- **Cloudflare Queues** — proper decoupling with batching and retries, but fundamentally changes the model from "nightly full re-scan" to "incremental per-note processing." Worth considering if the system grows to high-volume or multi-user. Not appropriate now.

**Where fixed cron breaks down:**

1. **Bulk imports** (Obsidian vault, ChatGPT export) — after importing hundreds of notes at once, waiting until 2am is unacceptable. The fix is a `/trigger` HTTP endpoint on the gardener Worker (issue #32), not a different trigger model. One manual call after the import.
2. **Scale ceiling** — when the per-note RPC approach hits ~200–300 notes and runs approach 30 seconds, incremental processing (cursor on `created_at`, only process notes newer than last run) becomes necessary. At that point a smarter trigger model makes more sense. That's a separate problem from what we're solving now.

**Future optimization (not yet implemented):** A lightweight `COUNT(notes WHERE created_at > last_gardener_run)` guard at the top of each run — skip the full scan if nothing is new. Worth adding once a `gardening_runs` table exists and runs get long enough that short-circuiting matters.

## SKOS tag normalization: vocabulary design, matching strategy, and refined_tags semantics

**Decision (2026-03-10):** Three design questions resolved before building tag normalization in the gardener.

**Vocabulary scope — normalizer, not classifier.** The original seed had 10 broad domain concepts (`creativity`, `technology`, `design`…). Mapping `laser-cutting → design` is a domain classifier and loses specificity — not useful for personal knowledge retrieval. SKOS is used here as a synonym/vocabulary normalizer: `pref_label` is the canonical form, `alt_labels` covers all observed variants (`laser-cut`, `lasercutting`, `laser fabrication`). The vocabulary must match the granularity of the content — not 10 broad concepts, but specific terms at the level they actually appear in notes. The seed file has been rewritten as a generic ~30-concept starter kit across four schemes (`domains`, `tools`, `people`, `places`).

**Matching strategy — hybrid, lexical-first.** Exact/normalized string match against `pref_label` + `alt_labels` first (covers the majority of cases at zero cost), embedding similarity fallback for genuinely unseen terms. `concepts.embedding` is null in the seed; populated on the first gardening run. Doing semantic-only is wasteful when lexical would hit; lexical-only fails on novel terms.

**`refined_tags` semantics — `pref_label` values only.** `notes.tags` already preserves the raw originals. `refined_tags` stores only the canonical `pref_label` values of matched concepts — clean, normalized, queryable. Unmatched tags stay in `notes.tags` and are logged to `enrichment_log` with `type = 'unmatched_tag'` for periodic human review.

**Seeding strategy — bootstrap + flag, human authority for additions.** Auto-grown vocabularies are a known anti-pattern: without a human authority, synonyms that should collapse instead split. The correct model: (1) one-time bootstrap from the corpus (`SELECT unnest(tags), count(*) FROM notes GROUP BY tag ORDER BY freq DESC` → LLM clustering pass → review → seed), (2) gardener logs unmatched tags to `enrichment_log`, never auto-creates concepts, (3) human reviews unmatched_tag log periodically and promotes recurring clusters.

**Hierarchy (`broader_id`) deferred.** Start flat. Fill in parent-child relationships via UPDATE once patterns are visible in data.

**Curation workflow (issue #34, decided same day):** Two new MCP tools — `list_unmatched_tags` (queries `enrichment_log` for `type = 'unmatched_tag'`, returns tags with frequency counts, optional `min_count` filter) and `promote_concept` (inserts a new `concepts` row). The agent surfaces unmatched tags opportunistically during organic PKM interactions — no fixed schedule, no separate maintenance mode. When the count crosses a threshold, the agent raises it conversationally and guides the user through clustering and promotion. This keeps vocabulary management on the same surface as note search and capture. Auto-clustering is not server-side; the agent does it conversationally. Concept embeddings are populated by the gardener on the next nightly run after promotion.

## Gardener similarity linker: per-note RPC approach with known scale ceiling

**Decision (2026-03-10):** The similarity linker calls `match_notes` RPC once per note (per-note ANN approach) rather than a SQL self-join or in-memory pairwise comparison.

**Why:** At 14 notes (~700ms), and realistically up to ~200 notes (~10s), the per-note RPC approach is within the 30s Cloudflare Worker CPU limit and reuses the existing `match_notes` function with no new SQL migrations. In-memory pairwise computation breaks at ~100–300 notes due to the O(N²) operation count against the 30s CPU wall.

**Scale ceiling:** ~200–300 notes. When the note corpus approaches this size, `findSimilarNotes()` in `gardener/src/db.ts` should be replaced with a single SQL self-join function (`find_similar_pairs(threshold, offset, limit)`) — one round-trip instead of N. A TODO comment marks this location in the code. No other code changes are required.

## Push vs. pull notification pattern

**Decision (2026-03-10):** Two communication patterns, one boundary rule: if it can wait for the user to ask, it goes through MCP. If it shouldn't wait, it's a Telegram message.

**Push (urgent, don't wait) → Telegram bot.** Error alerts — gardener failures, Worker crashes, anything that needs human attention and shouldn't sit until the next MCP session. Sent through the existing capture bot to the same chat. No second bot, no email, no separate channel. Error messages are rare and actionable; they don't pollute the capture conversation.

**Pull (at your pace) → MCP.** Curation work — reviewing unmatched tags from gardening, enrichment decisions, graph browsing, note editing. The user brings their own agent and interface. The data waits in the database until they choose to engage.

**Why not a second bot or email?** Low-friction means one gateway. The user doesn't want multiple bots in Telegram (one for alerts, one for capture, one for something else). The capture bot is already the primary interaction point. Adding error alerts to it is a minor extension, not a new system.

**Silence means healthy.** No nightly success heartbeat. If you stop getting error messages, the system is working. Success details are logged to Cloudflare console for debugging when needed (`wrangler tail`).

## Phase 2c OAuth: enable DCR, not skip it

**Decision (2026-03-10):** Enable Dynamic Client Registration (RFC 7591) on the MCP OAuth server, reversing the original plan to skip it.

**Why the original plan was wrong:** The plan assumed Claude.ai was the only interactive client and that manually entering `client_id`/`client_secret` in its UI was sufficient. Research showed: ChatGPT has no UI for manual credentials (DCR required), Claude Code CLI errors without DCR ("Incompatible auth server"), and Cursor relies on DCR for connection. Skipping DCR would have locked out 3 of 4 target clients.

**Why it's safe:** `@cloudflare/workers-oauth-provider` handles DCR automatically — one config line. Clients register their own redirect URIs, which eliminates the need to hardcode a redirect URI allowlist. Client registrations are stored in KV with the same hash-based security as tokens.

## Phase 2c OAuth: keep static Bearer token permanently

**Decision (2026-03-10):** The static `MCP_API_KEY` Bearer token must remain as a permanent auth path alongside OAuth, not a temporary migration crutch.

**Why:** API/SDK callers (Anthropic API `authorization_token`, OpenAI Responses API, Claude Code CLI `--header`) use static tokens directly. They never perform browser-based OAuth flows. Removing the static path would break machine-to-machine access with no alternative. OAuth serves browser-based connectors (Claude.ai web, Cursor, ChatGPT web). Static tokens serve programmatic callers. These are two distinct audiences requiring two auth mechanisms.

## Phase 2c OAuth: two-layer discovery (RFC 9728 + RFC 8414)

**Decision (2026-03-10):** Implement both `/.well-known/oauth-protected-resource` (RFC 9728) and `/.well-known/oauth-authorization-server` (RFC 8414), not just RFC 8414.

**Why:** The MCP spec changed in June 2025. The MCP server is now classified as an OAuth resource server, not an authorization server. Clients discover the authorization server via Protected Resource Metadata first, then fetch AS metadata from the URL found there. Claude.ai supports both old and new flows today, but Cursor follows the new spec. ChatGPT has a known bug where it skips PRM and goes straight to RFC 8414 — having both endpoints means both clients work. The `workers-oauth-provider` library serves both automatically.

## Tag normalization: idempotency via always-recompute (Option C)

**Decision (2026-03-10):** The gardener tag normalization step always recomputes `refined_tags` and `note_concepts` for all active notes, rather than using clean-slate deletion (Option A) or skip-if-enriched (Option B).

**Why:** Clean-slate (Option A) would require deleting all `note_concepts` rows, but without a `created_by` column it would destroy future capture-time or user-created concept links. A `created_by` column was added to `note_concepts` to enable scoped deletes. Skip-if-enriched (Option B) would miss newly promoted concepts — old notes would never pick up new matches. Always-recompute handles vocabulary growth automatically: when a concept is promoted via MCP, the next gardener run applies it to all notes.

## Tag normalization: GARDENER_TAG_MATCH_THRESHOLD at 0.55

**Decision (2026-03-10):** A fourth threshold for semantic tag-to-concept matching, distinct from the three existing thresholds.

**Why:** Tags are short strings (1-3 words), concept embeddings include definitions (full sentences). This asymmetry means matching scores are different from all other threshold scenarios. 0.55 is the starting point — lower than MATCH_THRESHOLD (0.60, raw query vs augmented store) because the tag side is bare, higher than MCP_SEARCH_THRESHOLD (0.35) because concept embeddings are shorter than full note embeddings. Tune empirically using unmatched_tag logs.

The four independent thresholds:
- `MATCH_THRESHOLD` (0.60) — raw query vs. augmented store, capture-time
- `MCP_SEARCH_THRESHOLD` (0.35) — bare NL query vs. augmented store, agent search
- `GARDENER_SIMILARITY_THRESHOLD` (0.70) — augmented vs. augmented, nightly linking
- `GARDENER_TAG_MATCH_THRESHOLD` (0.55) — bare tag vs. concept definition, nightly normalization

## Tag normalization: OpenRouter dependency is optional

**Decision (2026-03-10):** The gardener's `OPENROUTER_API_KEY` is optional. When absent, tag normalization runs lexical matching only (pref_label + alt_labels). Semantic fallback is disabled. The gardener previously had zero external API dependencies beyond Supabase.

**Why:** Lexical matching covers the majority of tags (exact pref_label or alt_label hits). Semantic fallback catches morphological variants and novel synonyms not in alt_labels. Making it optional preserves the gardener's ability to run with only Supabase credentials, and ensures an OpenRouter outage doesn't block the entire gardener run.

## Tag normalization: enrichment_log metadata column

**Decision (2026-03-10):** Added `metadata jsonb DEFAULT '{}'` to `enrichment_log` for storing unmatched tag strings, instead of repurposing the `model_used` column.

**Why:** `model_used` has an established semantic contract (AI model identifier or null). Storing tag names in it would create ambiguity and break future queries filtering on model names. A JSONB `metadata` column is extensible — future enrichment types can store arbitrary structured data without another migration. Unmatched tags are stored as `{"tag": "the-tag-string"}`.

## Batch concept embedding updates (CF Workers subrequest limit)

**Decision (2026-03-10):** Batch all concept embedding updates into a single `upsert` call instead of individual `update` calls per concept.

**Why:** Cloudflare Workers has a 50-subrequest limit on the free plan. With 32 seed concepts needing embeddings on first run, individual `updateConceptEmbedding` calls consumed 32 of the 50 budget before the rest of the pipeline (tag normalization per-note + similarity linker per-note) even started. A single `upsert` with all concept rows reduces 32 calls to 1. This also applies to future concept promotion — any number of newly promoted concepts get their embeddings written in one round-trip.

## Phase 2c OAuth: opaque tokens, not JWTs

**Decision (2026-03-10):** Use the `workers-oauth-provider` library's opaque token format rather than JWTs. Reversing the original plan's assumption of "signed JWTs."

**Why:** The library stores token hashes in KV and validates via hash lookup. This means token validation requires a KV read per request (~sub-ms cached). The tradeoff vs JWTs: revocation is immediate (delete from KV), no signing key management, and the library handles everything. For a single-user system, the KV read latency is negligible. JWTs would require either forking the library or building a parallel validation path — unnecessary complexity.

## Maturity/importance scoring: deferred until real graph patterns emerge

**Decision (2026-03-10):** Defer maturity and importance scoring from Phase 2b. Build chunk generation instead.

**Why:** The user's mental model of maturity is emergent and graph-driven, not per-note threshold scoring. Notes accumulate links naturally. When a cluster reaches critical mass, a "map of content" (MOC) emerges as a gravitational center — a concept from the Zettelkasten/PKM tradition. Freshness means a note was recently linked to new notes (currently on the user's mind). Density means many relations. MOCs eventually split when they grow too large and get linked together.

This model is closer to community detection in graph theory than to a formula like `if links > 3 and age > 7 days then budding`. Designing the algorithm requires observing real graph evolution — what link densities emerge naturally, what cluster sizes trigger the "gravitational" effect, when splitting feels right. These patterns don't exist yet with ~30 notes.

The "revisit count" signal from the original issue (#2) is also deferred. No tracking mechanism exists, and adding counters to read paths would produce noisy data (agent iteration inflates counts meaninglessly). If engagement tracking is needed later, it should be a separate analytics layer, not a column on `notes`.

## Chunk generation: paragraph-boundary splitting for brain dumps

**Decision (2026-03-10):** Build chunk generation in the gardener to support brain dump inputs. Paragraph-boundary splitting, ~500-800 character chunks, 1500-character minimum body length to qualify.

**Why:** The user is starting to experiment with brain dumps (multi-paragraph inputs via Telegram), which are chunkier than the current 1-5 sentence notes. Schema (`note_chunks`, `match_chunks` RPC) already exists. Building the infrastructure now means brain dumps work end-to-end immediately.

**Design choices:**
- **Splitting strategy:** Paragraph boundaries (double newlines). If a single paragraph exceeds the chunk size cap, fall back to sentence-boundary splitting within that paragraph. No overlap — ContemPlace notes are personal notes, not long technical documents. Paragraphs are natural semantic units.
- **Chunk content:** Store raw chunk text in `note_chunks.content`. At embed time, prepend `{note.title}: {chunk_text}` for context anchoring. Do not embed type/intent/tags metadata into chunks — those are note-level, not chunk-level.
- **Idempotency:** Skip-if-body-unchanged. Check `enrichment_log` timestamp for `enrichment_type = 'chunking'` vs `notes.updated_at`. If chunks exist and note hasn't changed, skip. If note was updated, delete existing chunks and re-chunk. Avoids re-embedding the entire corpus nightly.
- **Embedding:** Use `batchEmbedTexts` for all chunks in one API call (1 subrequest). The OpenAI batch limit is 2048 inputs — well above expected volume.

**Prerequisite:** Batch `updateRefinedTags` in tag normalization to free subrequest budget. Currently makes one Supabase call per note (~30 calls), which combined with the similarity linker's per-note RPCs already strains the 50-subrequest free tier limit.

## Supabase RPC functions: OPERATOR(extensions.<=>) required for pgvector

**Decision (2026-03-10):** RPC functions that use pgvector's `<=>` operator must use the explicit `OPERATOR(extensions.<=>)` syntax, not the bare `<=>` operator, even when `extensions` is in the function's `SET search_path`.

**Why:** PostgREST's execution context cannot resolve operators via `search_path` alone. The bare `<=>` operator fails with `operator does not exist: extensions.vector <=> extensions.vector` — PostgreSQL identifies the types correctly but cannot find the operator. The existing `match_notes` function works with bare `<=>` because it was created in the initial schema migration (different execution context). Functions created via later migrations through the connection pooler require explicit operator qualification.

Tables must also use explicit `public.notes` references rather than bare `notes` for the same reason.

This applies to any new RPC function that uses pgvector operators (`<=>`, `<->`, `<#>`). Use `OPERATOR(extensions.<=>)` and `public.table_name` to be safe.

## Similarity linker: find_similar_pairs replaces per-note RPC calls

**Decision (2026-03-10):** Replace the per-note `findSimilarNotes` RPC calls (N subrequests) with a single `find_similar_pairs` SQL self-join function (1 subrequest).

**Why:** The per-note approach made N Supabase RPC calls, one per note, consuming N subrequests. At 30 notes this was ~30 subrequests just for the similarity linker. Combined with tag normalization, the total exceeded the 50-subrequest free tier limit. The self-join computes all pairs above threshold in a single query using `a.id < b.id` ordering (each pair appears once). At 300 notes this is ~45,000 cosine distance comparisons — well under a second in Postgres. Combined with batching `insertSimilarityLinks` (all links in one INSERT instead of per-note batches), the entire similarity linker now uses ~5 fixed subrequests regardless of corpus size.

**Scale ceiling:** The brute-force self-join is O(N²). At 1000+ notes, consider an ANN-based approach or pagination.

**Imports context:** Future Obsidian/ChatGPT imports would be agent-driven via MCP `capture_note` in small batches, not bulk automated. No heading-aware splitting needed yet — brain dumps are prose, not structured markdown. Can add heading-awareness later if import content structure demands it.

## Chunk generation: body hash idempotency, not updated_at

**Decision (2026-03-10):** Use SHA-256 hash of `notes.body` stored in `enrichment_log.metadata` for chunk generation idempotency, not `notes.updated_at` comparison.

**Why:** `notes.updated_at` fires on ANY row update via a `BEFORE UPDATE` trigger. The gardener's own tag normalization phase calls `batchUpdateRefinedTags`, which bumps `updated_at` for every processed note on every run. Using `updated_at` would re-chunk the entire corpus nightly. The body hash is deterministic — only changes when the body text actually changes.

The `metadata` JSONB column on `enrichment_log` (added in `20260310000000_tag_normalization_prereqs.sql`) stores `{ body_hash: "sha256..." }` alongside the `enrichment_type = 'chunking'` entry. This is consistent with the existing `{ tag: "..." }` pattern for unmatched tags.

## Chunk generation vs capture-time splitting: different problems

**Decision (2026-03-10):** Build chunk generation first. Defer capture-time splitting of multi-thought inputs to a future `decompose_note` MCP tool or gardener step.

**Why:** Chunk generation fixes retrieval granularity (a long note about 3 topics gets one diluted embedding — chunks give each paragraph its own vector). Capture-time splitting fixes graph identity (one note gets one title, one type, one set of tags). These are complementary, not interchangeable. Chunk generation is ready to ship (schema exists, gardener infrastructure exists, zero changes to capture path). Capture-time splitting changes SYSTEM_FRAME, parseCaptureResponse, DB insert logic, Telegram reply format, dedup semantics, and both capture.ts copies — large blast radius. Chunk generation provides data to evaluate whether splitting is even needed in practice.

**Observation from validation:** The capture agent condenses long inputs — a 1918-char raw input produced a 901-char body. The body rules ("1-5 sentences, atomic") inherently limit body length. Chunk generation will mostly apply to future imported notes or manually edited notes with longer bodies, not Telegram captures. This reinforces the decision to defer capture-time splitting.

## Core product principle: invisible system, frictionless capture

**Decision (2026-03-10):** Established as a foundational product principle, not a feature requirement.

> The user must never think about the system itself. They are free to think what they think and capture it anytime, anywhere, easily, without stressing about administration, routing, or what happens on the other side. They trust that the DB will contain it in an easily retrievable, useful manner.

**Implications:** The capture pipeline must grow to handle diverse input types (short notes, URLs, brain dumps, lists, images) without requiring the user to label, categorize, prefix, or route their input. The system identifies what it received and processes it accordingly. Every route produces well-formed atomic notes. The user's experience is always the same: toss it in, forget about it.

## Database + MCP is the irreducible core

**Decision (2026-03-10):** The product is the database and its MCP surface. Everything else — Telegram bot, smart capture router, gardener, dashboard, import tools — is a module.

**Why:** The `capture_note` MCP tool is already a universal input gate. Any MCP-capable agent (Claude CLI, custom scripts, future clients) can capture notes through the full pipeline. The Telegram bot is one convenient client of this capability, not the product itself. Similarly, retrieval via `search_notes`, `search_chunks`, `get_related` works for any agent. The gardening pipeline is the quality guarantee — it transforms raw input into useful, retrievable, connected notes regardless of input source or quality.

**Three layers:**
1. **Input** — anything that puts notes in the database. The MCP `capture_note` tool is the universal gate. The Telegram bot, smart capture router, import tools are all clients.
2. **Enrichment** — the gardening pipeline. Makes the database useful, not just full. Normalized tags, similarity links, retrieval chunks.
3. **Retrieval** — agents query the enriched graph via MCP. Where value compounds.

**Input quality contract (needs formal definition):** Any input path must produce notes the gardener can work with. Minimum: `raw_input` preserved, `embedding` present, `tags` populated. The `capture_note` MCP tool enforces this via the full LLM pipeline. Future input paths that bypass the LLM must still meet this contract.

**Architectural implications (under review):**
- The Telegram Worker currently duplicates capture logic (`src/capture.ts`) instead of calling through MCP. If MCP is the universal gate, this duplication may need to become delegation.
- The smart capture router (issue #27) should enhance the MCP surface, not just the Telegram Worker.
- The three-Worker topology (Telegram, MCP, Gardener) was designed with Telegram as the primary input. The shift to "MCP is the core interface" may reshape how Workers relate to each other.
- The `source` field distinguishes provenance but the system should behave identically regardless of source.

**Status:** Strategic direction recognized. Needs a thorough architectural review before implementation. Existing decisions about Worker separation, capture pipeline duplication, and the MCP tool surface should be evaluated against this framing.

## Smart Capture Router: reframing brain dump splitting as input-type routing

**Decision (2026-03-10):** Brain dump splitting (issue #27) is not a standalone feature. It is one handler within a broader architectural layer — a smart capture router that detects input type and dispatches to specialized processing strategies.

**Why:** Research showed no shipping PKM product auto-splits at capture time. The industry converged on either smarter retrieval (making monolithic notes work) or user-initiated splitting (Obsidian Note Refactor pattern). But the user's real need is broader: the capture pipeline should handle *anything* thrown at it — a quick thought, a YouTube link, a 15-minute voice ramble, a grocery list — and produce useful atomic notes without user intervention.

**Architecture direction:**
- **Classification** (cheap: regex for URLs, length threshold for brain dumps, rules first)
- **Dispatch** to specialized handlers:
  - Short note → current Haiku pipeline
  - URL → fetch content, cross-ref existing notes, create reference note
  - Brain dump → more capable model (configurable, e.g. Sonnet) decomposes into atomic ideas, each re-enters standard capture
  - List → extract items as separate notes
- **Every handler** produces notes through the standard pipeline (embed, link, store)
- **Database stays consistent** — every row is a well-formed note regardless of which route produced it

**Scope:** This is a significant architectural evolution, likely its own phase. Build router scaffolding + brain dump handler first as proof-of-concept, then add URL handler, then generalize. Not a quick enhancement.

**Constraints identified:**
- CF Workers subrequest budget (50 free tier): brain dump route with 5 notes ≈ 20-25 subrequests. Feasible but bounded.
- Model cost: Sonnet ~10x Haiku. Acceptable for personal system with few brain dumps per week.
- Latency: brain dump route may take 15-25 seconds. All in `ctx.waitUntil()` — acceptable.
- Sibling note grouping: `metadata.split_group_id` + `is-part-of` links. No schema migration needed.
- Both Telegram and MCP `capture_note` should use the same router.

**What this supersedes:** The earlier decision "Chunk generation vs capture-time splitting: different problems" remains valid — chunks fix retrieval granularity, splitting fixes graph identity. But capture-time splitting is now part of the router architecture, not a standalone concern. The `decompose_note` MCP tool idea is also subsumed — the router handles decomposition at capture time with a capable model, rather than requiring a post-hoc MCP call.

## capture_note is a smart gate — the server owns the LLM pipeline

**Decision (2026-03-10):** `capture_note` is the single input gate for all notes. It is a **smart gate** — the server runs the full LLM pipeline internally (embed → related notes → classify → re-embed → store). The user sends raw text; the system handles everything.

**Why smart gate over validated gate:** An alternative was considered where `capture_note` would accept pre-structured input from the user's own agent, with ContemPlace only validating schema and generating embeddings. This would lower the barrier (no OpenRouter LLM cost for the user). But the server needs LLM access anyway — embeddings require an API call, and the gardener's semantic matching uses embeddings. The incremental cost of also running the capture LLM (Haiku, ~$0.001/note) is negligible. And the smart gate guarantees consistent quality regardless of which agent — or no agent — the user brings.

**Implications:**
- `capture_note` is the **write API**. There is no "raw insert" path for external callers. The Telegram bot, MCP agents, import tools, future channels — all use `capture_note`.
- The smart capture router (issue #27) enhances what happens *inside* `capture_note`, not outside it. The router is an upgrade to the gate, not a bypass.
- The SYSTEM_FRAME is an internal implementation detail, not a public specification that agents must conform to. The server owns classification quality. (Publishing the spec for transparency is a separate concern — issue #47.)
- **Structured mode** (accepting pre-classified input from capable agents) could be added later as an optional second path. Not required for the core product.
- **Trust model:** The server doesn't trust external input — it processes everything through its own pipeline. Quality is guaranteed by construction.

**Design questions opened:**
- Input quality contract: what exactly does `capture_note` guarantee? (Issue #45)
- Worker topology: should Telegram delegate to MCP instead of duplicating the pipeline? (Issue #46)
- SYSTEM_FRAME as public spec: value for agent guidance even if smart gate is primary (Issue #47)

## MCP tool descriptions as the agent guidance layer

**Decision (2026-03-10):** Enrich MCP `TOOL_DEFINITIONS` descriptions to guide connecting agents, rather than publishing the SYSTEM_FRAME or adding a guidance endpoint. The tool description is the only context an MCP-connected agent receives about how to use each tool.

**Why:** When Claude Code CLI (or any MCP agent) connects, it sees only the tool names, descriptions, and parameter schemas. The original `capture_note` text parameter said "Raw text to capture, max 4000 characters" — giving the agent no reason to avoid composing polished text, which defeats the capture pipeline's voice correction and "transcription not interpretation" principle.

**Design principles applied:**
- **One directive per description.** For `capture_note`: "pass the user's raw words without cleaning up." Avoid checklist paralysis — a wall of instructions makes agents second-guess simple captures.
- **Say WHAT the server does, not HOW.** "The server handles all structuring" is behavioral guidance. The two-pass embedding, SYSTEM_FRAME/capture voice split, and fallback logic are implementation details.
- **Replace text, don't append.** Token budget held roughly constant (~1,530 tokens for all 8 tools). Longer descriptions compound in cost — they're re-sent on every request.
- **Enum glosses, not taxonomy essays.** Filter parameters get brief parenthetical hints: `plan (future action, aspirations, wishes)`. Enough to disambiguate without defining the full classification rules.
- **Don't add "search first" to capture_note.** Dedup is the gardener's job (similarity linker), not the agent's. The core principle — "the user must never think about the system" — extends to agents acting on the user's behalf.

**What this leaves for later:** Issue #47 (publishing SYSTEM_FRAME as a public spec) and issue #45 (formal input quality contract) remain open as potential Level 2/3 escalations if the tool descriptions prove insufficient.

## capture_note parameter: raw_input, not text

**Decision (2026-03-11):** Renamed the `capture_note` parameter from `text` to `raw_input`. The tool description now explicitly names the required parameter: "Required parameter: raw_input (the user's verbatim words)."

**Why:** Real-world testing with Claude Code CLI showed the agent pattern-matched on the description ("Pass the user's raw input") and guessed `raw_input` as the parameter name. The parameter was actually called `text`, so the first call failed. The name `raw_input` is strictly better: it tells the agent what to put in (verbatim user words), matches the `notes.raw_input` DB column, and aligns with the description language. Parameter names are documentation — they should be self-describing.

**Lesson:** Description language and parameter names must reinforce each other. When an agent sees a tool for the first time, it reads the description to infer parameter names before loading the full schema. If the description says "raw input" but the parameter is called "text", the agent will guess wrong.

## match_chunks RPC: must DROP before CREATE when changing return type

**Decision (2026-03-10):** `CREATE OR REPLACE FUNCTION` cannot change the return type of an existing function. When extending return columns, `DROP FUNCTION IF EXISTS` must precede `CREATE FUNCTION`.

**Why:** Migration `20260310000003_fix_match_chunks.sql` initially used `CREATE OR REPLACE` to add `note_type`, `note_intent`, `note_tags` columns to `match_chunks`. PostgreSQL rejected this with `cannot change return type of existing function (SQLSTATE 42P13)`. Fixed by adding `DROP FUNCTION IF EXISTS match_chunks` before `CREATE FUNCTION`. Safe because `note_chunks` table was empty at migration time.

## Capture tuning from real-world usage testing (2026-03-11)

Three SYSTEM_FRAME changes based on a 6-note test battery using real Obsidian vault content with deliberately degraded voice input.

**1. `duplicate-of` link type added.** When a note covers substantially the same content as an existing note (same topic, detail, angle), the capture agent now links with `duplicate-of` instead of `supports`. The note is still created — deduplication is a gardening concern, not a capture concern. Previously, identical-title notes were linked as `supports`, giving the caller no signal that deduplication might be warranted.

**2. Voice correction strengthened for real-word substitutions.** The hardest class of voice error is a real word that's wrong in context (e.g., "cymbal" when the user means "cimbalom"). The correction instructions now explicitly tell the LLM: if a common word is phonetically similar to a domain-specific term in the related notes, and surrounding context favors the domain term, prefer it. This won't catch every case — Haiku may still miss subtle ones — but the instruction makes the expectation explicit.

**3. Lookup intent clarified.** `lookup` type notes were getting `intent: reference`, but a research question ("look into whether X works") has no URL and isn't saving someone else's work. Added explicit guidance: lookup notes typically get `plan` or `remember` intent, not `reference`.

## Capture tuning round 2 (2026-03-11)

Follow-up from Battery 2 testing. Two prompt refinements.

**1. `duplicate-of` heuristic strengthened.** Battery 2 Test 1 confirmed the LLM didn't fire `duplicate-of` despite same concept/angle — it defaulted to `supports`. Added a concrete observable test: "if you would give the new note the same or nearly identical title as the related note, it is a duplicate. Use `duplicate-of`, not `supports`." The title-matching heuristic gives the LLM something to check rather than asking it to judge abstract sameness.

**2. `lookup` type detection broadened.** "Figure out whether" didn't trigger `lookup` in Battery 2 (classified as `idea`/`create` instead), while "look into whether" did in Battery 1. Removed the "Not for things to make or build" exclusion — a research question about something buildable is still a lookup if the framing is investigative. Added "figure out whether Y" to the examples. Key signal is now the opening verb phrase, not the domain.

**Known limitation documented: real-word voice errors without corpus support.** "Guitar" for "citera" went uncorrected because no citera note exists in the corpus. The voice correction cross-references related notes, but can only correct to terms that appear in the context. When the domain-specific term isn't in the corpus at all, the LLM would need its own training knowledge to make the inference — which is unreliable for obscure terms. This is accepted as a known limitation.

## Product vision refinement: the problem ContemPlace solves (2026-03-11)

Articulated the core problem statement through dogfooding and preparing to share the project publicly. Three pillars:

**1. Portable context.** AI agents build memory about you in proprietary, isolated gardens — non-portable and non-trivial to extract. ContemPlace inverts this: your memory lives in a database you own, any MCP-capable tool reads and writes it, accumulated context travels with you.

**2. Emergent structure.** Notes cluster around themes over time. Some nodes gain gravitational weight (many connections, recent activity). Maps of content form naturally as gravitational centers. The system doesn't impose organization; it emerges from linked, gardened notes. Closer to community detection than folder hierarchies.

**3. Low friction as a prerequisite, not a feature.** The system works *because* it doesn't ask you to organize. This is non-negotiable for the target user (high-throughput thinking, low organizational patience).

These are now documented in README.md (Philosophy section) and CLAUDE.md (Product Intent section).

## Multilingual input: open question (2026-03-11)

`text-embedding-3-small` is multilingual — Hungarian works fine in a monolingual corpus. The concern is mixed-language retrieval: two notes about the same concept in different languages will have lower cosine similarity than same-language pairs. Metadata augmentation (`[Type: idea] [Intent: plan] [Tags: ...]`) is English regardless of body language, which partially bridges the gap.

**Hypothesis:** Cross-language degradation is non-catastrophic for practical use. Untested — issue #57 tracks a concrete test plan.

**Design direction if degradation is significant:** Normalize output language in the structured note (always English title/body/tags), preserve original in `raw_input`. Language normalization as a capture voice rule, not a code change. Fits the existing architecture: raw_input is sacred, the structured note is already the LLM's interpretation.

## Agent-driven capture: editorial contract needed (2026-03-11)

A new capture mode emerged: an LLM agent commits useful insights into ContemPlace after a work session. This differs from pass-through capture (user's raw words) — the agent makes editorial decisions about what's worth remembering.

The agent needs guidance beyond the structural SYSTEM_FRAME: what to capture (atomic ideas worth finding in three months), what to skip (session logs, task status), how to format (one idea per call, preserve user's framing). This is the editorial contract — tracked in issue #47.

`get_capture_guidance` MCP tool would return both structural spec and editorial guidance. The editorial layer could live in `capture_profiles` alongside the capture voice — editable without deploy.

## Phase 2c-A: extract handleMcpRequest + timing-safe auth (2026-03-11)

**Decision:** Refactor the MCP Worker's monolithic `fetch()` handler into a thin HTTP wrapper (CORS, routing, auth) and an exported `handleMcpRequest(request, env)` function that handles JSON-RPC dispatch. Fix timing-vulnerable string comparison in auth.

**Why:** OAuthProvider integration (Phase 2c issue C) needs the JSON-RPC dispatch logic as a standalone function. Both the static token bypass and OAuthProvider will call `handleMcpRequest` — the wrapper decides which auth path, the dispatch is shared. Extracting now, while behavior is unchanged, keeps the OAuth PR focused on new functionality.

**Auth fix:** `validateAuth` previously used `token !== env.MCP_API_KEY` — a timing-vulnerable comparison that leaks token length information. Replaced with `timingSafeEqual` using `crypto.subtle.timingSafeEqual` (Workers runtime) with a manual XOR-loop fallback for Node test environments. Added `isStaticTokenRequest(request, env): boolean` for the future static-token bypass path.

**Test split:** `mcp-index.test.ts` (previously 31 tests covering everything) split into `mcp-dispatch.test.ts` (27 tests — JSON-RPC protocol and tool dispatch against `handleMcpRequest` directly) and `mcp-index.test.ts` (9 tests — HTTP wrapper: auth, routing, CORS). Total MCP unit tests: 185.

## Phase 2c-C: resolveExternalToken over wrapper for static bypass (2026-03-11)

**Decision:** Use the OAuthProvider library's `resolveExternalToken` callback for static token bypass instead of wrapping OAuthProvider with a custom fetch handler.

**Why:** The original plan (issue #61, plan doc) proposed a wrapper: check `isStaticTokenRequest()` first, bypass OAuthProvider entirely for static callers, delegate to OAuthProvider for everyone else. Specialist review discovered `resolveExternalToken` — the library's built-in hook for validating tokens not found in its internal KV store. When a Bearer token doesn't match the internal `userId:grantId:secret` format, this callback fires. The hex `MCP_API_KEY` has no colons, so the library skips KV lookup entirely and calls the callback immediately.

**Benefits over wrapper:**
- No dual routing — OAuthProvider is the sole default export
- CORS handled uniformly by the library (origin-mirroring) on all paths
- `ctx.props` consistently available for both OAuth and static callers
- OPTIONS preflight handled by library for all routes — no manual handling needed

**Behavioral changes from the switch:**
- Wrong token returns 401 (OAuthProvider) instead of 403 (old validateAuth)
- CORS uses origin-mirroring (`Access-Control-Allow-Origin: <origin>`) instead of wildcard `*`
- GET /mcp returns 401 (API route, needs auth) instead of 404 (old routing)

**Consent page:** ~~Open gate, no login.~~ **Updated 2026-03-11 (PR #67):** Now protected by `CONSENT_SECRET` passphrase. See "Phase 2c-D: CONSENT_SECRET over Cloudflare Access" below.

## Phase 2c-C: CIMD deferred (2026-03-11)

**Decision:** Leave `clientIdMetadataDocumentEnabled: false` (the default). Do not enable Client ID Metadata Documents yet.

**Why:** No current MCP client uses CIMD. Enabling it requires the `global_fetch_strictly_public` compatibility flag in wrangler.toml, which changes the Worker's fetch behavior globally. The risk isn't justified for a feature no client needs today. Enable it when a client actually requires it.

## Phase 2c-D: CONSENT_SECRET over Cloudflare Access (2026-03-11)

**Decision:** Secure the OAuth consent page with a `CONSENT_SECRET` passphrase (Option B) instead of Cloudflare Access (Option A).

**Why:** The consent page was an open gate — anyone who knew the Worker URL could register a client via DCR, visit `/authorize`, approve, and get a valid OAuth token with full read/write DB access. Four options were evaluated:

- **(A) Cloudflare Access:** Strong, zero code change, but adds external dependency. Setup is dashboard-only. Upgrade path if needed.
- **(B) CONSENT_SECRET:** Self-contained, proportionate. 128-bit secret makes brute force infeasible. Typed once per client per 30-day token lifetime.
- **(C) Restrict DCR:** Breaks ChatGPT, Cursor, Claude Code CLI (all require DCR). Not viable alone.
- **(D) A + C:** Defense in depth but overkill for single-user.

Option B chosen because: zero external dependencies, everything lives in Worker code and secrets, full client compatibility preserved, and the consent page is visited rarely enough that per-approval entry is not a burden. DCR stays open (harmless without consent page access). No per-session cookie (adds signing complexity for marginal convenience). Cloudflare Access documented as the upgrade path if the system becomes multi-user or faces active targeting.

## Capture quality batch 1: prompt fixes over hybrid pipeline (2026-03-12)

**Decision:** Fix 5 capture agent quality issues (#68, #73, #52, #51, #74) via SYSTEM_FRAME prompt strengthening and capture voice tuning, not the full hybrid pre-pass/LLM/post-pass pipeline proposed in #68.

**Context:** Real-world usage surfaced a cluster of quality issues: hallucinated answers for question inputs, misclassification of questions as `idea` instead of `lookup`, dropped primary-subject tags, missed entity extraction in short inputs, and body truncation of longer inputs. All shared a root cause: the single-pass LLM was near its quality ceiling for edge cases.

**Why not the hybrid pipeline:** The three-layer architecture (pre-pass → LLM → post-pass) would fix the same problems more reliably but at significantly more complexity. The current issues affect ~10-15% of captures. Prompt fixes are cheap, immediately deployable, and testable via the semantic test suite. If they prove insufficient, the hybrid pipeline is the next step (reserved for Phase 3 / smart capture router #27).

**Changes made:**
- Anti-hallucination body rule in SYSTEM_FRAME: questions must be preserved as questions, never answered
- Broader `lookup` definition: interrogative intent, not just command phrasing
- Tag limit raised from 2-5 to 2-7 with subject-first priority
- Entity extraction emphasis: proper nouns extracted regardless of input length
- Body length scaling: 1-3 sentences short, up to 8 for longer inputs
- Schema bug fixed: `duplicate-of` added to `links.link_type` CHECK constraint (was silently dropping all duplicate-of links)

**Validation:** 60/60 semantic tests pass (15 new F/G/H clusters covering all fixed issues). All question-type fixtures correctly classified as `lookup` with preserved question form.

**Risk:** Body length relaxation may produce less atomic notes for medium-length inputs. Tag count inflation possible with wider 2-7 range. Both monitored post-deploy.

## Conviction-type input: no special handling needed (2026-03-12)

**Decision:** First-person beliefs about process, design, and values ("I believe documentation is part of the deliverable") are a valid content pattern for ContemPlace. No special type, tag convention, or capture pipeline change needed — the existing framework handles them naturally.

**Why:** The capture agent classifies these as `reflection` (first-person insight) with `remember` or `reflect` intent, which is correct. Tags surface the specific topic (documentation, project-management, product-design), not a generic "belief" category. The body preserves the first-person stance. Semantic search retrieves them accurately — "what are my beliefs about documentation" surfaces the right notes without any conviction-specific tag.

A dedicated `belief` tag was considered and rejected. It would only add value for the access pattern "list all my beliefs regardless of topic" — which is not how people query their own convictions. The natural query is topical ("what do I think about testing?"), and the existing embedding + search handles this. Adding a classification burden (is this a belief? a preference? a lesson?) contradicts the project's core principle: emergent structure over imposed structure.

**Validation:** Added as permanent Cluster I in `tests/semantic.test.ts` — 4 conviction fixtures with assertions on type, intent, tags, body preservation, intra-cluster linking, and cross-topic retrieval. These test a content pattern no existing cluster covers (first-person declarative beliefs vs topical content in clusters A-H).

## Single capture path via Service Bindings (2026-03-12)

**Decision:** The Telegram Worker will delegate capture to the MCP Worker via a Cloudflare Service Binding instead of running its own copy of the capture pipeline. One capture process, multiple gateways.

**Context:** Issue #46. The Telegram Worker and MCP Worker duplicated ~530 lines of capture logic (capture.ts, embed.ts, shared DB functions, shared types). Parity tests (24 tests across 3 files) enforced sync, but a real-world links bug demonstrated that architectural duplication — not just code duplication — is the root problem. The `duplicate-of` link type was defined in the parser and SYSTEM_FRAME but missing from the DB CHECK constraint, causing silent link insertion failures. The bug affected both Workers equally, but the architectural duplication meant the fix had to be applied and verified in two places. More critically, the planned smart capture router (#27) would require implementing input-type detection and specialized handlers in two places — untenable.

**Why not shared library (Option B)?** A shared library eliminates code duplication but not architectural duplication. The orchestration (embed → find related → LLM → re-embed → insert → link → log) would still be assembled independently in each Worker. A bug in the assembly isn't caught by parity tests on individual functions. Option A eliminates the entire category of divergence risk.

**Why not merge Workers (Option D)?** OAuthProvider owns the MCP Worker's entire fetch handler. Telegram webhook auth and OAuth 2.1 are fundamentally different protocols. Merging them couples failure modes and shares the 50-subrequest free-tier budget.

**Implementation:** The MCP Worker exports a `CaptureService` class extending `WorkerEntrypoint` with a `capture(rawInput, source)` method. The Telegram Worker declares a Service Binding in `wrangler.toml` and calls `env.CAPTURE_SERVICE.capture(text, 'telegram')` — direct RPC, no HTTP, no auth overhead. Both the MCP `capture_note` tool handler and the Telegram adapter call the same internal function.

**CaptureResult contract:** One rich result designed for all gateways — includes id, title, body, tags, corrections, source_ref, and links with resolved titles. (Originally included type/intent/entities — removed in #110 and #113.) Telegram formats it as HTML. MCP returns it as JSON. Future gateways use the same result.

**Coupling assessment:** For a single-user system on CF Workers, the operational coupling risk is negligible. Workers don't have traditional downtime — deploys are atomic (~1-2s), and CF routes to the previous version during deployment. Service Bindings are in-process, platform-managed. The logical coupling is desirable: capture behavior changes everywhere at once.

**What goes away:** `src/capture.ts`, `src/embed.ts`, shared functions in `src/db.ts`, 3 parity test files (24 tests), `processCapture` in `src/index.ts` (~107 lines). The Telegram Worker becomes a thin webhook adapter (~20 lines of capture logic).

**Open questions:** (1) Whether the gardener's `embed.ts` should also use a Service Binding or keep its own copy given its batch-oriented pattern. (2) Whether the MCP Worker should be renamed to reflect its broader role (e.g., `contemplace-core`).

**Implemented (2026-03-12, PR #90).** `WorkerEntrypoint` coexists with OAuthProvider — named export (`CaptureService`) alongside default export (OAuthProvider-wrapped fetch). `mcp/src/pipeline.ts` is the single source of truth, called by both `CaptureService.capture()` and `handleCaptureNote`. Telegram Worker is now ~180 lines total with enriched HTML reply (emoji indicators for type, intent, link types, entity types). `compatibility_date` bumped to `2024-04-03` on both Workers. Deploy script reordered to 7 steps (MCP Worker before Telegram Worker). ~650 lines deleted, 24 parity tests removed, 313 unit tests remain.

## No input gatekeeping — the graph self-curates via density

**Decision (2026-03-12):** ContemPlace accepts everything the user sends. There is no boundary enforcement for "what belongs here" — no rejection of low-value inputs, no routing to other systems, no type-based filtering at capture time.

**Why:** The core principle is "the user must never think about the system itself." Asking "should I put this in ContemPlace or somewhere else?" is exactly the kind of friction the system exists to eliminate. An errand note ("buy kitchen tiles") that never gets linked to anything simply has no gravity in the graph — it's invisible unless directly searched. No harm done. The system's linking and enrichment mechanisms naturally surface high-value notes (many connections, recent activity) and let low-value notes sink.

**What self-curation looks like:**
- Notes with no inbound links, no `refined_tags`, and no recent activity have zero gravitational weight
- Similarity linking only fires above threshold (0.70) — isolated notes stay isolated
- Tag normalization only matches notes against the SKOS vocabulary — notes with no matchable tags get no `refined_tags`
- Agents retrieving via `search_notes` rank by cosine similarity — low-relevance notes don't surface

**What this means for the capture agent:** The agent classifies everything (type, intent, tags, entities) regardless of perceived "importance." It does not refuse inputs or warn about low-value content. The classification is honest — an errand is `intent: plan`, not dressed up as something grander.

**The PKM boundary is a user convention, not a system rule.** The user's note "PKM is for insights that travel across contexts, not project backlogs" describes their personal capture philosophy. It guides what they choose to send, not what the system accepts. An agent following `get_capture_guidance` (#47) should internalize this as editorial judgment, not as a validation gate.

**Stale note review (#82) is the safety net.** If the graph accumulates noise over time, periodic review surfaces dead-end notes for cleanup. This is a pull mechanism (user asks when ready), not a push mechanism (system rejects at capture time).

## Structure emergence is already built — the gap is surfacing, not detection

**Decision (2026-03-12):** The mechanisms for emergent structure are complete and working: capture-time linking (5 link types), gardener similarity linking (`is-similar-to` above 0.70), SKOS tag normalization (`refined_tags`), and chunk generation for long notes. No new detection mechanisms are needed. The next step is surfacing — helping the user (via their agent) see what clusters have formed.

**Why this matters now:** The design questions (#93, #94) asked "how does structure emerge?" and "how do higher-order artifacts like Maps of Content get created?" The answer is that emergence is already happening — notes link to each other at capture time, the gardener adds similarity links nightly, tags converge via SKOS normalization. What's missing is not a new pipeline step but a way for the user to discover what emerged.

**Three surfacing mechanisms, in order of effort:**

1. **Agent-organic (zero system changes):** During any conversation, an MCP-connected agent can call `search_notes`, `get_related`, and `list_recent` to discover clusters. If the agent notices density ("these 8 notes all reference kitchen renovation"), it can point this out and offer to summarize. This works today — it just depends on the agent being aware enough to look. Issue #47 (`get_capture_guidance`) can include editorial guidance: "when exploring a topic, check for cluster density."

2. **User-initiated MOC assembly (zero system changes):** The user says "show me everything about kitchen renovation." The agent queries, assembles a summary with links, and presents it. This is a conversation pattern, not a feature. If the user wants to persist it, the agent can `capture_note` the summary as a new note with `type: idea` and `intent: remember`.

3. **Gardener density detection (new gardener step, deferred):** The nightly gardener could compute cluster metrics (e.g., connected components above N nodes, or nodes with >K inbound links) and log them to `enrichment_log` as `type: 'cluster_detected'`. An MCP tool (`list_clusters` or similar) could surface these. This is a meaningful feature but not urgent — the organic approach works first.

**MOCs are query patterns, not stored artifacts.** A Map of Content is what you get when an agent assembles related notes into a coherent view. It doesn't need to be stored because it's derivable from the graph at any time and is always current. If a MOC needs to be persistent (shared externally, referenced by other notes), it can be captured as a regular note — no new artifact type or table needed.

**Exception: persistent behavioral artifacts.** Some derived artifacts need to persist across sessions — "user's tone of voice," "capture editorial guidance," "personal context." These are already handled by existing mechanisms: `capture_profiles` (voice/style), `concepts` (SKOS vocabulary), and the proposed `get_capture_guidance` tool (#47). They're not MOCs — they're configuration, and they have dedicated storage.

**What's deferred:** Gardener density detection (option 3 above). Maturity lifecycle — the `maturity` column exists but computing it requires real graph patterns to emerge. Wait for the corpus to grow before defining stages or scoring rules. Issue #82 (stale note review) will provide signal on whether the graph is actually compounding value.

## Storage philosophy resolved: structured notes win (2026-03-13)

**Decision:** Structured atomic notes with an organizational layer are the correct storage model for ContemPlace. Raw storage (Philosophy B) and dropping atomicity (Philosophy C) were both rejected. The organizational layer stays because it serves retrieval, discovery, and export — not because it's tradition.

**Why:** Three philosophies were evaluated across three design sessions (#93):

- **Philosophy A (current — confirmed):** Atomic structured notes with metadata (tags, links, entities, corrections, title). The organizational layer provides costless token scanning via titles at retrieval time, export convenience, and enables emergent features (hub nodes, gravitational discovery index).
- **Philosophy B (raw storage — rejected):** The user explicitly wants the organizational layer and gardener enrichment. Pure vector embeddings are insufficient for the user's PKM mental model (MOCs, density-based discovery, tag-based exploration).
- **Philosophy C (drop atomicity — rejected):** Atomicity is a quality gate, not just a size gate. LLM classification fidelity degrades with input complexity. Multi-topic inputs produce worse titles, tags, links, and embeddings.

**Key principles established:**

1. **User voice is sacred.** The capture LLM must not compress, hallucinate, add inferred meanings, or change input destructively. The body is transcription, not synthesis. Trust erodes when the system puts words in the user's mouth.
2. **User is curator and gatekeeper.** No automatic capture. The user decides what goes in. Guard rails and warnings are fine, but the user is the quality gate. The system trusts the user is smart and capable.
3. **Atomic notes are the optimized input type.** The system handles everything else gracefully but produces lesser results for non-atomic input. This is documented guidance, not architectural enforcement.
4. **Low friction, aware curator.** Refined from the original "never think about the system" principle. The user understands what the system is optimized for and acts accordingly. The system makes capture easy, not invisible.

**Capture LLM role clarified:**
- **Keeps:** title (retrieval scanning), corrections (voice/typo/entity), entity extraction (proper nouns), tags (keyword retrieval), linking (graph building + user feedback)
- **Drops:** compression, interpretation, added conclusions, inferred meanings

**What's under investigation (separate issues):**
- Drop type, intent, modality (#104) — 90% decided, needs impact analysis
- SKOS vs free tags (#105) — maintenance burden may outweigh value
- Typed links vs simple links (#106) — link types may not justify classification complexity
- Note accretion (#103) — notes maturing over time, architecturally distant

## Capture LLM: drop length constraint (2026-03-13)

**Decision:** Remove the body length constraint from the SYSTEM_FRAME. Let the note body be as long as it needs to be.

**Why:** The body length rules ("1-5 sentences," later "1-3 short, up to 8 long") were causing the LLM to compress and truncate, which conflicts with the "transcription not interpretation" principle. The user's voice should be preserved faithfully. If the input is long, the body is long. Atomicity is about idea scope (one idea per note), not character count.

## Product principle refinement: low friction, aware curator (2026-03-13)

**Decision:** The core product principle evolves from "the user must never think about the system" to "low friction, aware curator."

**Why:** The original principle implied the system should handle any input invisibly. Three design sessions revealed this is both impossible (no single LLM can reliably decompose brain dumps) and undesirable (the user values being an active curator). The refined principle: the system makes capture easy and low-friction, the user knows what it's optimized for (atomic notes in their own voice), and the user's editorial judgment keeps the system hygienic.

**What changes:** The system should be explicit about what makes a good note. Non-optimal input should produce a warning, not a rejection (#109). The MCP agent training pattern (#107) teaches connecting agents what the system expects.

## MCP agent training pattern (2026-03-13)

**Decision:** The system should store its own capture guidance as queryable content in the database. An agent connecting for the first time calls a training tool and receives: what the system is, what it expects, what the user prefers. Custom skills become invocable after training.

**Why:** This supersedes #47 (publish SYSTEM_FRAME as spec). A static spec is less powerful than a living, updatable, queryable guidance layer. The `capture_profiles` table already stores editable capture voice — this pattern extends it to include user preferences, tone of voice, and custom skill definitions. The training tool assembles from all sources and serves as a portable onboarding device for any MCP-capable agent.

**Design direction:** Tone of voice preferences stored as regular atomic notes (queryable via semantic search, naturally evolving). System expectations in `capture_profiles`. Custom skills could reference specific notes as skill definitions. Contradictions over time resolve via timestamps (newer wins). Tracked in #107.

## Complex input is the user's responsibility (2026-03-13)

**Decision:** The system is optimized for atomic notes. Complex inputs (brain dumps, multi-topic streams, lists) are the user's responsibility to pre-process — either manually or via an LLM agent using MCP tools.

**Why:** The smart capture router (#27) originally envisioned the system auto-decomposing brain dumps. Three design sessions revealed this is fragile (LLM decomposition introduces extra failure points), and the user already has capable agents (Claude.ai via OAuth MCP, Claude Code via static token) that can do this interactively. The user curates before capture — this is the "aware curator" principle in action.

**What remains of #27:** URL detection and specialized handling at capture time (URLs are confirmed as worth extra care). Non-optimal input detection (warn, don't reject). The scope is much narrower than originally envisioned.

**Input channels already cover the workflow:**
- **Telegram** — low-friction, on-the-go, optimized for quick atomic captures
- **OAuth MCP (Claude.ai, ChatGPT)** — agent-mediated capture for complex input; the agent helps decompose before sending to `capture_note`
- **Static token MCP (Claude Code)** — same agent-mediated capture from the terminal

## Drop type, intent, and modality from capture pipeline (2026-03-13)

**Decision:** Remove `type` (idea/reflection/source/lookup), `intent` (reflect/plan/create/remember/reference/log), and `modality` (text/link/list/mixed) from the capture pipeline. Stop classifying, stop storing, stop exposing as filters.

**Why:** Investigation (#104) examined every consumer of these fields. The only non-redundant signals were reflection detection (personal processing vs general note) and the plan→create→log lifecycle (temporal orientation). Neither justifies ~40 lines of taxonomy rules in SYSTEM_FRAME, ongoing prompt-tuning burden (multiple past issues were type/intent misclassification), or 10-field LLM output. `source` type is fully redundant with `source_ref IS NOT NULL`. `modality` had zero consumers. Tags and embeddings carry sufficient signal for retrieval.

**Embedding impact:** Stored embeddings are augmented with `[Type: X] [Intent: Y] [Tags: ...] text`. After removal, augmentation becomes `[Tags: ...] text`. This creates a vector space mismatch between old and new notes. Options: accept the drift (type/intent prefixes are a small fraction of total text), re-embed all existing notes, or fresh start. Decision on migration path deferred to implementation (#110).

**What stays:** title, body, tags, entities, links, corrections, source_ref — all serve retrieval or user feedback with clear value.

## Atomic note definition (2026-03-14)

**Decision:** Define "atomic note" as a three-layer specification, based on PKM literature research (Luhmann, Matuschak, Ahrens, Tietze, Forte, Milo) and corpus analysis of 20 existing ContemPlace notes.

**The definition (Layer 2 — working definition):** An atomic note captures one idea in the user's own voice — something that earns a single claim as its title without needing "and" to connect two separate points. Properties: one central claim or question, self-contained, voice-preserving, complete but not padded.

**Title model:** Claim titles are the primary model (title states the note's position). Question titles are secondary (for exploratory input). Topic labels are explicitly discouraged — they signal multi-idea notes and are retrieval-hostile.

**Operational atomicity test:** If the note needs two claim titles to be honest, it's two notes. This "and" test gives the LLM and detection heuristics something concrete to evaluate.

**No hard size limits.** Word count is a weak proxy for idea count (Tietze: "atomicity ≠ granularity"). A long note can be atomic; a short note can contain two ideas. Sweet spot from corpus analysis: 20–150 words, 1–4 sentences. Presented as descriptive, not prescriptive.

**Atomicity governs capture events, not note lifecycle.** Each `capture_note` call should contain one idea. The stored note may grow through accretion (#103) as new captures refine it — that's a gardening concern.

**Non-atomic input is captured, never rejected.** Soft warnings when detection heuristics fire (2+ signals required to reduce voice-input false positives). The "low friction, aware curator" principle: warn, don't gate.

**Three layers for different consumers:** Layer 1 (one sentence, for tool descriptions): "One idea, stated clearly, in the user's own voice." Layer 2 (working definition, for agent training and capture voice). Layer 3 (full specification with detection heuristics, for SYSTEM_FRAME and `docs/capture-agent.md`).

**Body length rule replaced.** The previous "1-3 short, up to 8 long" heuristic replaced with a principle: "enough to land the idea, no more." Shorter is better than padded, but completeness beats brevity when the idea requires it.

**Source:** Issue #108. Literature basis: Matuschak's "titles are like APIs" (strongest framework), Tietze's atomicity-as-direction (not rigid law), Ahrens's self-containment, Luhmann's A6-constrained practice (~150-250 words). Corpus analysis: excellent notes cluster at 120-330 chars with claim titles; the one too-broad note had 4+ ideas and a compound label title.

## Drop type/intent/modality from capture pipeline (2026-03-14)

**Decision:** Remove `type`, `intent`, and `modality` fields from the entire capture pipeline — LLM contract, schema, code, and tests.

**Why:** These classification facets added cognitive overhead to the LLM prompt without delivering proportional retrieval or organizational value. Type was a 4-way enum that didn't influence any downstream behavior. Intent was a 6-way enum that overlapped with tags. Modality was never used. All three occupied prompt space and test surface without improving search results or user experience. The decision was validated through storage philosophy analysis (#93) and confirmed in #104.

**Implementation:** Clean-slate v3 schema — consolidated 10 migration files into one that never had these columns. SYSTEM_FRAME reduced from 10-field to 7-field JSON contract. Embedding format simplified from `[Type: X] [Intent: Y] [Tags: ...] text` to `[Tags: ...] text`. All 81 curated notes re-captured from `raw_input` to rebuild the corpus in the new vector space. All tests updated and passing.

**Source:** Issue #110, PR #114. Decision chain: #93 → #104 → #110.

## Fragment-first capture: atomicity governs synthesis, not capture (2026-03-14)

**Decision:** The fundamental capture unit is the idea fragment, not the atomic note. Fragments are whatever the user sends — diverse in type, variable in completeness, unpressured to be atomic. Atomic-like structures (focused, single-claim, well-linked) emerge from fragments through the gardening and synthesis layers, not from capture-time enforcement.

**What this reverses:** The 2026-03-13 storage philosophy decision recorded "Atomic notes are the optimized input type" and "Philosophy C (drop atomicity — rejected)." After literature research (Sosa's accretion theory, Ahrens' clustering, Milo's MOCs, Johnson's slow hunches) and reflection on actual capture behavior, the position shifted. Atomicity was an aspiration for the capture event that added friction without matching how the user actually captures. What the user sends are idea fragments — self-reflection, quotes, book notes, observations, questions, workflow suggestions.

**Why:** Three realizations drove the shift:
1. The user's natural capture style is fragmented and diverse. Pressuring fragments into atomic shape adds friction at the moment when friction matters most.
2. Ideas accrete from fragments (Sosa's "ideasimals"). A system that only stores completed atoms misses the intermediate stage where fragments are combining but haven't yet cohered.
3. The real value isn't in atomic capture — it's in what the system builds from accumulated fragments. Synthesis, clustering, and MOC-like structures are the product. Fragments are the raw material.

**The trust contract:** The system earns trust by guaranteeing: (1) no contamination — synthesis never contains inferred statements in the user's voice, (2) no garbage — everything traces to real fragments, (3) full traceability — every synthesized statement cites source fragments, (4) analytical not creative — the system organizes and connects, it doesn't generate new ideas or add meaning the fragments don't contain. The system is a faithful mirror, not a co-author.

**What changes in practice:**
- The capture pipeline stays the same — the LLM still produces title/body/tags/links. What changes is the framing: the pipeline structures fragments, it doesn't enforce atomicity.
- Non-atomic detection heuristics reframe as multi-fragment indicators — useful quality signals for the capture LLM, not input quality warnings to the user.
- The gardener gains a future synthesis phase: cluster detection → MOC generation → incremental re-evaluation. Tracked in #116.
- Maturity labels (seedling/budding/evergreen) are rejected. Maturity is a computed analytical proxy from density, clustering, and link patterns — not a per-note label.
- The system never reaches a final state. It's a living organism that changes with every captured fragment.

**Product reframe:** The user doesn't enjoy the administrative process of organizing notes — they want the results. ContemPlace's promise: frictionless fragment capture on the input side, trusted synthesis on the output side. You get the results without the process.

**Source:** Issue #116. Literature basis in #116 comment. Decision chain: #93 → #103 → #116.

## Drop SKOS tag normalization — free tags are sufficient

**Decision (2026-03-14):** Drop the SKOS controlled vocabulary layer entirely. Keep capture-time free tags (2–7 per fragment). Remove the `concepts` table, `note_concepts` junction, `notes.refined_tags` column, the gardener's tag normalization phase, and the `list_unmatched_tags` / `promote_concept` MCP tools.

**Why:** Investigation (#105) against the live corpus (81 notes) showed the SKOS layer produces output that nothing consumes:
- 50 unmatched tags — the controlled vocabulary covers less than half the tag surface.
- `laser-cutting` appears unmatched despite being in seed data — the system doesn't maintain itself.
- No retrieval tool reads `refined_tags` or queries `note_concepts`. All search is embedding-based.
- The similarity linker and embedding augmentation both use raw `notes.tags`, not `refined_tags`.
- Embedding search already handles synonym collapse — vector similarity does what SKOS was built for.

The curation burden (monitoring unmatched tags, promoting concepts, maintaining alt_labels) conflicts with the user's stated preference: "I want the garden, not the weeding." The fragment-first philosophy (#116) favors emergent structure over imposed taxonomy.

**What stays:** Capture-time free tags serve two purposes that don't require normalization: human-readable feedback in the Telegram reply, and embedding augmentation input (`[Tags: ...] text`).

**What this supersedes:** The SKOS vocabulary normalizer decision (2026-03-10) and its three sub-decisions (vocabulary scope, matching strategy, refined_tags semantics). Those were sound engineering given the premise that controlled vocabulary adds retrieval value. The premise turned out to be wrong — embeddings already solve the problem SKOS was meant to address.

**Source:** Issue #105. Implementation in #122 (bundled with #117). Decision chain: #93 → #105 → #122.

## Simplify link types: keep only `contradicts`, genericize the rest (2026-03-14)

**Decision:** Reduce capture-time link types from 5 (`extends`, `contradicts`, `supports`, `is-example-of`, `duplicate-of`) to 2: `contradicts` (intellectual tension) and `related` (everything else). Gardener's `is-similar-to` stays as-is.

**Why:** Empirical analysis of the live corpus (224 links across 81 notes) showed that `supports` accounts for 82.5% of all capture-time links. The LLM defaults to the loosest bucket rather than making fine-grained distinctions. Meanwhile, no retrieval code path filters by link type — the types are decorative metadata.

The exception is `contradicts` (6 links, 2.8%). All 6 were reviewed and found genuinely high-quality: "Sometimes the weeding is the garden" contradicts "I want the garden, not the gardening." These surface intellectual tension that vector similarity alone cannot detect — similar embeddings mean similar topic, not opposing positions. This is the only link type that adds information beyond proximity.

**Evidence by type:**
| Type | Count | % | Quality assessment |
|---|---|---|---|
| `supports` | 174 | 82.5% | Catch-all default. Indistinguishable from "related" |
| `extends` | 22 | 10.4% | Mostly reasonable but blurs with `supports` |
| `is-example-of` | 9 | 4.3% | Mixed quality — some miscategorized |
| `contradicts` | 6 | 2.8% | All correct. Uniquely valuable |
| `duplicate-of` | 0 | 0% | Never used. Gardener `is-similar-to` with scores is more reliable for dedup |

**What stays:**
- Capture-time linking (the LLM still identifies which related notes to link)
- `contradicts` type (surfaces tension that embeddings can't)
- `related` type (new generic, replaces `extends`/`supports`/`is-example-of`/`duplicate-of`)
- Gardener's `is-similar-to` (unchanged — auto-detected, score-based)

**What simplifies:**
- SYSTEM_FRAME: 5 type definitions → 1 meaningful distinction ("if in tension, `contradicts`; otherwise `related`")
- Parser validation: 5 valid types → 3 (`contradicts`, `related`, `is-similar-to`)
- Schema CHECK constraint: 9 types → fewer
- Telegram reply emoji: 5 type-specific icons → 1 for contradiction, default for rest
- Migration reclassifies existing `extends`/`supports`/`is-example-of`/`duplicate-of` → `related`

**Source:** Issue #106. Implementation bundled with #117 and #122 in a single schema simplification pass. Decision chain: #93 → #106.

## Drop entity extraction from capture — defer to gardening (2026-03-14)

**Decision:** Remove entity extraction from the capture pipeline. The `notes.entities` DB column stays (new notes get empty arrays), but the LLM no longer extracts entities at capture time.

**Why:** Entity extraction was unused infrastructure. No retrieval tool, no MCP handler, no downstream consumer ever queried the structured `entities` data. The 5-type taxonomy (`person`, `place`, `tool`, `project`, `concept`) produced inconsistent classifications (#71) — the LLM struggled to distinguish `tool` from `project`, and `concept` was a catch-all that overlapped with tags.

The value propositions that originally justified entity extraction all point to gardening-time extraction rather than capture-time:

1. **Corrections dictionary** — cross-referencing entity names with voice corrections to build a persistent spelling/recognition dictionary. This requires corpus-wide context (all prior corrections for the same entity), which is available at gardening time but not at capture time.
2. **Synthesis clustering** — grouping fragments by shared entities for MOC-like summaries. The gardener already has the full graph and can extract entities with better context than the capture LLM sees (5 related notes vs. full corpus).
3. **Entity deduplication** — "Andy Matuschak" vs "Matuschak" vs "Andy M." collapsing to one canonical entity. This is inherently a corpus-wide operation.

Removing entity extraction from capture simplifies the LLM contract from 7 fields to 6, reduces SYSTEM_FRAME by ~10 lines of entity rules, and eliminates a class of parser validation that was handling inconsistent LLM output.

**What stays:** The `notes.entities` column remains in the schema. Existing notes retain their entities. New notes get `[]`. The `notes_entities_idx` GIN index stays. A future gardener phase can populate entities with full corpus context — tracked in a new issue.

**Source:** Issue #113. Decision chain: #93 → #113.

## Drop chunking infrastructure — fragments are the natural retrieval units (2026-03-14)

**Decision:** Remove the chunking infrastructure entirely: `note_chunks` table, `match_chunks` RPC, `search_chunks` MCP tool, gardener chunk generation phase, and all associated code and tests. Implementation bundled with the schema simplification pass (#117 + #122 + #124).

**Why:** Chunking was built for long notes that don't exist and won't exist under the fragment-first philosophy. The 1500-char threshold has never been triggered. The corpus (99 notes) has a median body length of 158 chars; the longest is 1333 chars. No note has ever been chunked.

Lowering the threshold doesn't help — even at 800 chars, only 1 note qualifies. Fragment-first capture actively pushes against long notes. The system doesn't accrete notes into longer ones (#103 was superseded by fragment-first). Import paths (#13, #14) are deferred and speculative.

**Even in the synthesis future, chunking doesn't earn its keep.** The synthesis layer (#120) will produce MOC-like cluster summaries — longer notes that reference source fragments. But chunking those MOCs wouldn't improve retrieval: the source fragments are already individually searchable via `search_notes` at the right granularity. A chunk of a MOC is partial synthesis — less useful than either the full MOC (for cluster overview) or the original fragment (for specific detail). The fragment layer IS the chunk layer.

**What gets removed:**
- `note_chunks` table + `match_chunks` RPC function (schema migration)
- `search_chunks` MCP tool definition + handler (`mcp/src/tools.ts`)
- `searchChunks` DB function (`mcp/src/db.ts`)
- Chunk generation phase in gardener (`gardener/src/chunk.ts`, chunk DB ops in `gardener/src/db.ts`, orchestration in `gardener/src/index.ts`)
- Unit tests (`tests/gardener-chunk.test.ts`, chunk-related cases in `tests/mcp-dispatch.test.ts`, `tests/mcp-tools.test.ts`)

**Re-adding is low cost.** The code is self-contained and can be copied from git history if a future input path (imports, synthesis) produces content that needs chunk-level retrieval.

**Source:** Issue #112. Decision chain: #93 → #112, informed by #120 (synthesis layer design).

## v4 schema simplification bundle (2026-03-14)

**Decision:** Bundle four schema simplifications into a single migration and release: drop SKOS vocabulary (#122), simplify link types (#124), remove chunking infrastructure (#127), and drop maturity/importance_score columns (#117). Implemented in PR #131, tagged as `v4.0.0`.

**Why bundle:** All four changes were independently decided (see ADRs above) and had no cross-dependencies, but each required a migration and a code deployment. Bundling into one migration avoids intermediate schema states, reduces deploy cycles, and lets the test suite validate the combined result. The risk of a combined change is low because all four are subtractive — removing unused infrastructure, not adding new behavior.

**What changed:**
- **Schema:** Dropped 3 tables (`concepts`, `note_concepts`, `note_chunks`), 3 columns on `notes` (`refined_tags`, `maturity`, `importance_score`), 2 RPC functions (`match_chunks`, `batch_update_refined_tags`). Link types CHECK constraint changed from 9 types to 3 (`contradicts`, `related`, `is-similar-to`). Existing `extends`/`supports`/`is-example-of`/`duplicate-of` links reclassified to `related` via migration UPDATE.
- **MCP Worker:** 8 → 5 tools. Removed `search_chunks`, `list_unmatched_tags`, `promote_concept` tool definitions and handlers. SYSTEM_FRAME updated for 2 capture link types (`contradicts`, `related`).
- **Gardener Worker:** Removed tag normalization phase, chunk generation phase, `embed.ts`, `normalize.ts`, `chunk.ts`. Removed `OPENROUTER_API_KEY`, `EMBED_MODEL`, `GARDENER_TAG_MATCH_THRESHOLD` config dependencies. The gardener now runs similarity linking only.
- **Tests:** Deleted 4 test files (`gardener-chunk.test.ts`, `gardener-normalize.test.ts`, `gardener-embed.test.ts`, `gardener-tag-norm.test.ts`). Updated 7 test files. 210 tests pass across 12 files.
- **Net:** +110 / -2,759 lines.

**Source:** Issue #128, PR #131. Decision chain: #93 → #105/#106/#112/#117 → #122/#124/#127 → #128.

## archive_note with grace-window hard delete — no update, no merge (2026-03-16)

**Decision:** Implement one MCP tool — `archive_note` — with time-based dual behavior. No `update_note` tool. No `merge_notes` tool. Close #88, #89, #98. Reframe #87 as `archive_note`.

**The reasoning from first principles:**

Everything in ContemPlace is computed from `raw_input`. Title, body, tags, links, embeddings — all derived by the pipeline. The only "real" data is what the user originally said. This means:

1. **Update makes no sense.** Editing computed fields (title, body, tags) fights the pipeline — any re-processing overwrites the edit. Editing `raw_input` and re-running the pipeline is just delete + recapture. The user doesn't want to revise fragments in place; they capture something new that supersedes, or they delete and try again.

2. **Merge makes no sense.** Which `raw_input` survives? Concatenating two creates a multi-fragment input the system isn't built for. Keeping one and archiving the other is just archive + keep — no merge tool required. Duplicates resolve naturally: newer captures overwhelm old ones during synthesis/retrieval, or the user archives the one they don't want.

3. **Delete is the only operation that follows.** Two real use cases: (a) on-the-go correction — capture, see bad result, remove it, recapture; (b) retrieval-time curation — encounter stale/wrong/test junk, ask the agent to remove it.

**Why soft delete (archive) instead of hard delete:**

The threat model isn't "I'll accidentally delete my own note." It's "I connect an MCP client I don't fully trust, and it has a tool that can destroy data irreversibly." The MCP surface is an access layer for potentially untrusted agents. A rogue or overzealous agent with hard delete access could destroy the entire corpus. With soft delete, the worst case is mass archival — fixable with one SQL UPDATE.

Soft delete via `archived_at` is a **blast radius limiter**, not packrat instinct. The system trusts the user as curator, but it doesn't have to trust every agent the user connects.

**Grace-window hybrid:**

The tool checks the note's `created_at` against a configurable threshold (default: 10 minutes, env var `HARD_DELETE_WINDOW_MINUTES`):

| Note age | Behavior | Rationale |
|---|---|---|
| < grace window | Hard delete (`DELETE`, CASCADE cleans links + enrichment_log) | You're still in the capture session, correcting in real time. The fragment barely existed. |
| ≥ grace window | Soft delete (`SET archived_at = now()`) | The note has been in the graph, may have been seen, linked, or referenced. Recoverable. |

This keeps the on-the-go correction loop clean (no ghost rows for immediate mistakes) while protecting established notes from irreversible damage. A rogue agent that calls `archive_note` on old notes can only soft-delete them. A rogue agent calling it on very recent notes can hard-delete them, but those are notes it likely just created — minutes of data, not the corpus.

**Hard delete stays manual.** Direct DB access (`DELETE FROM notes WHERE id = '...'`) for when the user wants to truly purge. No agent gets this capability.

**Unarchive is also manual.** `UPDATE notes SET archived_at = NULL WHERE id = '...'` or mass recovery: `UPDATE notes SET archived_at = NULL WHERE archived_at IS NOT NULL`. No MCP tool needed.

**What already supports this in the schema:**
- `archived_at` column exists on `notes`
- `ON DELETE CASCADE` on `links.from_id`, `links.to_id`, `enrichment_log.note_id`
- All RPC functions (`match_notes`, `find_similar_pairs`) already filter `WHERE archived_at IS NULL`

**Return value** communicates which path was taken: `{ deleted: true }` for hard delete, `{ archived: true, id: "..." }` for soft delete — so the calling agent and user know what happened.

**Source:** Issues #87, #88, #89, #98. First-principles design session 2026-03-16.

## archive_note implementation decisions from specialist review (2026-03-16)

**Context:** The ADR above was a first-principles hypothesis. Before implementation, two specialist review agents evaluated the design against industrial best practices, MCP API design norms, and real-world PKM systems (Notion, Obsidian, Roam, Apple Notes, Bear, Standard Notes). These decisions were surfaced by the review and adopted during implementation (PR #140).

### Idempotent soft delete

**Decision:** Calling `archive_note` on an already-archived note returns `{ archived: true, id: "..." }` (success), not "Note not found."

**Why:** A flaky network causes the agent to retry. If the first call succeeds (archives the note) and the retry gets "not found," the agent reports an error to the user for an operation that actually succeeded. Making soft delete idempotent eliminates this failure mode. Implementation: `fetchNoteForArchive` queries without the `archived_at IS NULL` filter and checks three states — not found, already archived, active.

For hard-deleted notes, idempotency is impossible (the row is gone), so "not found" on retry is the only possible response. This is acceptable because it only affects notes less than 11 minutes old — the retry window where a note was just hard-deleted is tiny.

### Filter links to archived notes in get_related

**Decision:** `fetchNoteLinks` filters out links where the other note is archived. If note A (active) has a link to note B (archived), `get_related(A)` does not show that link.

**Why:** Both specialist reviewers flagged this as the top implementation concern. Without this filter, `get_related` returns links pointing to notes that `get_note` says don't exist — a dangling reference at the API level. The fix: the title-lookup query inside `fetchNoteLinks` adds `.is('archived_at', null)`, and links where no title was resolved (because the other note is archived) are excluded from the response. Gardener-created `is-similar-to` links to archived notes self-clean on the next nightly run (clean-slate strategy).

### Grace window boundary: strict less-than

**Decision:** The comparison is `ageMs < windowMs` — a note exactly at the boundary (e.g., exactly 11 minutes old) goes to soft archive, not hard delete.

**Why:** When the outcome is ambiguous, choose the less destructive path. Soft archive is recoverable; hard delete is not.

### Default grace window: 11 minutes

**Decision:** `HARD_DELETE_WINDOW_MINUTES` defaults to 11, not 10.

**Why:** User preference. It's prime.

### Archived notes invisible across all MCP tools

**Decision:** `fetchNote`, `listRecentNotes`, and the title-lookup query inside `fetchNoteLinks` all add `.is('archived_at', null)`. Archived notes are invisible to `get_note`, `list_recent`, `get_related`, and `search_notes` (which already filtered via the `match_notes` RPC).

**Why:** The original ADR noted that RPC functions already filtered `archived_at IS NULL`, but the direct Supabase client queries in `db.ts` did not. Without this fix, archived notes would still appear in `get_note` and `list_recent` responses — defeating the purpose of archival. Unarchive remains a manual DB operation (`UPDATE notes SET archived_at = NULL WHERE id = '...'`), consistent with the ADR's design that recovery is an admin action, not an agent action.

### No audit log entry for archive/delete

**Decision:** Archive and delete events are logged to the Cloudflare Workers console (`console.log` with structured JSON), not to the `enrichment_log` table.

**Why:** For hard delete, an `enrichment_log` entry would be CASCADE-deleted along with the note — useless. For soft delete, the `archived_at` timestamp on the note itself is sufficient forensic evidence in a single-user system. Console logs survive regardless of database state and follow the existing structured logging pattern throughout the codebase.

**Source:** Specialist review during #87 implementation, 2026-03-16.

## Telegram /undo — source-scoped, grace-window-only hard delete (2026-03-16)

**Decision:** The `/undo` Telegram command only hard-deletes the most recent Telegram capture within the grace window. It refuses if the grace period has passed or if no Telegram captures exist. No soft-archive path.

**Three design constraints narrowed this to a single behavior:**

1. **Source-scoped.** `/undo` only targets notes with `source = 'telegram'`. A note captured via MCP or another agent is invisible to `/undo`. The user shouldn't be surprised by undoing something they did in a different context.

2. **Grace-window-only.** If the most recent Telegram note is beyond the grace window (default 11 min), `/undo` refuses: "The grace period has passed. To archive a note, use an MCP session." No soft archive — the name is "undo," not "archive." If the user has left the capture session, context has shifted, and the safety of a full MCP session (where the agent can show the note, ask for confirmation, use `archive_note` with UUID) is appropriate.

3. **Always the most recent.** No UUID, no history walking. `/undo` targets exactly one note — the most recent active Telegram capture. This matches the real use case: "I just sent something and it came out wrong."

**Rejected alternatives:**
- **Inline keyboard buttons on capture replies** — visual clutter on 100% of messages for a 1% use case. Buttons become stale after the grace window passes.
- **`/archive <uuid>`** — requires the user to have the UUID, which they'd need to copy from an MCP session. Defeats the purpose of a quick Telegram undo.
- **Source-agnostic undo** — would let Telegram undo an MCP capture, crossing modality boundaries and creating confusion about which system did what.
- **Soft archive via `/undo`** — names matter. "Undo" means "take back what I just did." Archiving old notes is a deliberate curation act that belongs in an MCP session with full context.

**Implementation:** `CaptureService.undoLatest()` on the MCP Worker, called via Service Binding RPC. Uses `fetchMostRecentBySource(db, 'telegram')` — a new DB helper that queries by source with `archived_at IS NULL`. Bot commands (`/start`, `/undo`) registered via Telegram's `setMyCommands` API.

**Source:** Issue #142, PR #143.

## archive_note renamed to remove_note — names are behavioral contracts (2026-03-16)

**Decision:** Rename the `archive_note` MCP tool to `remove_note`. The old name promised archival but could permanently delete recent notes — an agent reading just the name would never expect that.

**Why:** The `/undo` design session crystallized a principle: names are behavioral contracts. `/undo` was scoped to grace-window-only because "undo" means "take back what I just did," not "archive old stuff." Applying the same lens to `archive_note` revealed the same problem in reverse — "archive" implies recoverable storage, but notes within the grace window are permanently deleted.

`remove_note` is neutral. "Remove from the active knowledge graph" honestly covers both paths. The description carries the time-dependent mechanics: permanent deletion for recent notes, soft archive for older ones.

**What changed:** Tool name `archive_note` → `remove_note`. Handler `handleArchiveNote` → `handleRemoveNote`. Tool description rewritten to lead with the time-dependent behavior. Internal DB functions (`archiveNote`, `hardDeleteNote`, `fetchNoteForArchive`) unchanged — they accurately describe their DB-level operations.

**Source:** Session reflection on naming contracts, 2026-03-16. New design principle #10 in `docs/philosophy.md`.

## Cluster exploration: weighted graph fusion with flat overlapping clusters (2026-03-17)

**Decision:** Cluster fragments using weighted graph fusion — a single similarity graph where edge weight combines cosine similarity (embeddings), Jaccard similarity (tags), explicit link presence, and eventually Jaccard similarity (entities). Run Louvain community detection via Graphology (TypeScript-native). Flat clusters with overlap and a resolution parameter for granularity. No hierarchy, no nesting.

**Why:** A literature review (#148) surveyed community detection algorithms, multi-view clustering, tag co-occurrence methods, and hierarchy vs flat for PKM systems. The Zettelkasten tradition rejects imposed hierarchy — fragments naturally belong to multiple topics. ContemPlace's "emergent structure, not imposed structure" philosophy aligns with flat clusters + resolution parameter for zoom, not a fixed tree. Weighted graph fusion is the simplest multi-signal approach (transparent, tunable), with Similarity Network Fusion and consensus clustering available as future iterations if needed.

Louvain via Graphology is the practical algorithm choice — the only production-quality TypeScript implementation with weighted edge support that works in V8 (CF Workers runtime). Custom implementation remains an option if Louvain proves insufficient. Leiden (theoretically better) has no JS port.

**Key design constraints:**
- Multi-membership from day one — hard assignment rejected as false
- Resolution parameter exposed to consumers — agents pick the zoom level
- LLM-assisted cluster labels at gardening time — dashboard-browseable without MCP
- Gravity is recency-weighted, not just size — new clusters should surface
- Entities (fourth signal) silently absent when empty, slots in when #125 ships
- Stay on CF Workers free tier

**Source:** #144 research session, 2026-03-17. Literature review completed (#148). Validated against #145 empirical findings.

## Cluster computation as a gardening operation (2026-03-17)

**Decision:** Cluster detection runs at gardening time (nightly cron), not on-demand in the MCP tool. Results stored in DB. The `list_clusters` MCP tool reads pre-computed clusters.

**Why:** Two considerations drove this. First, the user wants clusters browseable from a dashboard without an MCP agent — that requires pre-computed results in the DB. Second, building separate on-demand computation and then rebuilding for the gardener is duplicate work. For a corpus of hundreds of notes, Graphology + Louvain is milliseconds — well within the nightly gardener's budget. If cheap enough, could eventually become a post-capture operation.

**Source:** #144 design discussion, 2026-03-17.

## Entities column retained for gardener use and clustering (2026-03-17)

**Decision:** Keep the `entities` JSONB column on `notes`. Do not drop it (#129 closed).

**Why:** The gardener-maintained entity dictionary (#125) will populate it via batch extraction from `raw_input`. Entities also serve as the fourth dimension in the clustering weighted graph — Jaccard entity co-occurrence is orthogonal to embeddings, tags, and links. The formula `w(a,b) = α·cosine + β·jaccard_tags + γ·link_exists + δ·jaccard_entities` accommodates absent entities (δ·0 = 0) without code changes. The GIN index stays for future entity-based retrieval.

**Source:** #144 research session, 2026-03-17. #129 closed with this resolution.

## All linking thresholds are untested and need empirical validation (2026-03-17)

**Decision:** Elevate threshold assessment (#149) from a clustering dependency to a key product feature. The three thresholds (MATCH_THRESHOLD 0.60, GARDENER_SIMILARITY_THRESHOLD 0.70, MCP_SEARCH_THRESHOLD 0.35) were set during proof-of-concept for an earlier embedding format and have never been empirically validated.

**Why:** The #145 tag clustering investigation showed 82% coverage with hybrid tags + links, but this math depends on link density, which depends on thresholds that were never tuned. The embedding format changed from `[Type: X] [Intent: Y] [Tags: ...] text` to `[Tags: ...] text` in v3.1, and thresholds weren't revisited. The gardener produces only 25 `is-similar-to` links at 0.70 — likely too sparse. Rather than optimize clustering on top of unvalidated signals, validate the signals first.

Each linking mechanism has a distinct purpose: capture-time links are LLM-reasoned semantic judgments (how ideas relate), gardener-time links are mathematical proximity (bridging temporal gaps). If clustering needs denser links than capture quality does, a separate clustering-time similarity pass may be warranted.

**Source:** #144 research session, 2026-03-17. #91 and #146 folded into #149.

## Cosine-only clustering as starting implementation (2026-03-17)

**Decision:** Implement the gardener clustering pipeline (#144) with cosine similarity only. The full weighted fusion formula (α·cosine + β·jaccard_tags + γ·links + δ·entities) becomes an incremental upgrade path — each signal added after its quality is validated via the experiment script.

**Why:** The #152 experiment ran 6 weight configurations against the live corpus (164 notes, 13,366 pairs). Pure cosine at resolution 1.0 produced 3 coherent clusters that map to real domains: ContemPlace/PKM (74 notes), making/instruments (57 notes), pen-plotting/art (33 notes). Adding tags shifted a few boundary notes but didn't restructure — only 5.4% of note pairs share any tag, so Jaccard is near-zero for most edges. Adding gardener links moved only 9 notes vs the cosine baseline. The other signals reinforce what cosine already captures rather than adding new information.

Starting cosine-only reduces implementation complexity, removes the need to tune weight ratios before there's data to tune against, and lets each signal quality improvement (#151 tags, #147 normalization, #125 entities) be validated independently by re-running the experiment script before adding it to production.

**Source:** #152 experiment results, 2026-03-17.

## Multi-resolution Louvain as the overlap model (2026-03-17)

**Decision:** Model cluster overlap by running Louvain at multiple resolutions (e.g., 0.5, 1.0, 1.5, 2.0) and comparing membership across them. Notes that change cluster assignment across resolutions are the overlap candidates. No fuzzy algorithms, no custom overlap detection.

**Why:** The #152 experiment showed that 134 of 164 notes change cluster assignment across resolutions. At resolution 1.0, 66 notes have >30% of their edge weight outside their own community. Modularity is low (0.27–0.32) — the corpus has soft boundaries, expected for a commonplace book where ideas cross domains.

Multi-resolution comparison is the simplest approach that captures real overlap. The pen-plotting cluster (C2) is especially porous — most notes pull toward making (C1) — and these are genuinely cross-domain notes (plotter postcards connect to correspondence, plotter enclosures connect to laser cutting). Running at 2–3 resolutions and reporting membership across them gives useful overlap information without fuzzy algorithms.

**Source:** #152 experiment results, 2026-03-17.

## Tag Jaccard is near-zero — tag quality is a clustering prerequisite (2026-03-17)

**Decision:** Do not include tag Jaccard in the clustering formula until tag quality improves (#151, #147). With current tag generation, the signal is too weak to contribute.

**Why:** The #152 experiment quantified the problem: 478 unique tags across 164 notes, but only 5.4% of note pairs share any tag. Tag fragmentation is visible — `pen-plotting` vs `plotter` vs `generative-art` for the same domain, `knowledge-capture` vs `knowledge-management` vs `note-taking` as near-synonyms. Adding tag Jaccard at α=0.4, β=0.5 produced 4 clusters vs 3 for cosine-only — a modest improvement driven by a few high-frequency tags like `contemplace`, not by general tag quality.

This confirms the design memo's signal quality caveat: current signals are proof-of-concept. Tag quality improvements (#151) and normalization (#147) are prerequisites for tags to carry useful clustering signal.

**Source:** #152 experiment results, 2026-03-17.

## Automated backup: GitHub Actions + supabase db dump (2026-03-18)

**Decision:** Daily automated backups via GitHub Actions running `supabase db dump`, stored in a private GitHub repository. Cloudflare Worker backup rejected. Supabase Pro plan deferred.

**Why:** The Supabase free tier provides automated daily backups but they are not user-accessible — no download, no restore from the dashboard. `raw_input` is irreplaceable by design, so an independent backup path is essential. Investigation (#96) surveyed five approaches:

- **CF Worker backup: dead end.** V8 isolates cannot run `pg_dump` or any native binary. Reimplementing dump logic in JavaScript would miss RPC functions, indexes, and constraints.
- **Supabase Pro ($25/mo):** Dashboard-accessible backups with 7-day retention. Not justified at current scale (~200 notes, ~1.4MB) — revisit when corpus reaches 100K+ notes or instant restore justifies the cost.
- **Local cron:** Works but requires the machine to be on. CI is more reliable for daily scheduled work.
- **GitHub Actions + CLI dump:** Officially documented by Supabase, handles pgvector correctly, costs nothing (free tier: 2000 min/mo), stores in git (free retention via history).

**Product angle:** Backup as a user-configurable feature, not just internal infrastructure. The workflow template we build becomes part of the setup guide — any ContemPlace fork can enable daily backups by adding one GitHub Secret. This strengthens the product's core promise: your memory lives in a database you own, with a recovery story you control.

**Source:** Issue #96 investigation, #159 implementation. Supabase docs: [Automated backups using GitHub Actions](https://supabase.com/docs/guides/deployment/ci/backups).

## Gardener similarity linking — purpose defined (2026-03-18)

**Decision:** The gardener's similarity linking exists to complete the graph that capture-time linking structurally cannot. Two specific blind spots:

1. **Backward blindness.** Capture-time linking only looks backward — a new note evaluates existing notes, but earlier notes never evaluate later arrivals. Monday's fragment never initiates a link to Tuesday's. The gardener compares all pairs regardless of creation order.

2. **Context window truncation.** The capture pipeline presents only the top 5 candidates to the LLM. In a dense topic, candidates 6–15 might all deserve links but the LLM never sees them. The gardener's `find_similar_pairs` returns all pairs above threshold with no fixed candidate window.

A supplementary mechanism difference: capture-time matching compares raw text against augmented stored embeddings, while the gardener compares augmented against augmented. Shared tags produce a cosine boost the capture pipeline doesn't see.

**Why:** Five capture audits (2026-03-15 through 2026-03-18) consistently showed gardener links concentrated in dense obsidian-import clusters and absent from Telegram captures. The gardener produced only 36 `is-similar-to` links across 175 notes — too sparse to contribute to clustering. Articulating the purpose precisely was necessary before empirically tuning thresholds (#149, #158), so success and failure could be tested against a concrete goal rather than a vague sense of "more links."

**Source:** #149 investigation session, 2026-03-18. Goal statement in `docs/architecture.md` → "Gardener pipeline → Goal."

## Gardener threshold lowered from 0.70 to 0.65 (2026-03-18)

**Decision:** Lower `GARDENER_SIMILARITY_THRESHOLD` from 0.70 to 0.65 in `gardener/wrangler.toml`.

**Why:** Threshold analysis (#158) against 186 notes showed 0.70 captures only 38 pairs — mostly near-duplicates concentrated in dense obsidian-import clusters. The 0.65–0.70 band contains 79 clearly-related pairs on human review (audio plugins ↔ Sound Soup, ContemPlace design philosophy pairs, F-tag photography pairs). Telegram fragments are systematically excluded at 0.70 (only 6 within-source pairs) but gain meaningful connections at 0.65 (26 pairs). Triples link candidates from 38 → 117. Fully reversible — the gardener rebuilds all `is-similar-to` links from scratch each run.

**Source:** #149 investigation, #158 threshold analysis script. Specialist review confirmed.

## Capture threshold confirmed at 0.35 (2026-03-18)

**Decision:** Keep `MATCH_THRESHOLD` at 0.35 as deployed. Reconcile documentation that incorrectly stated the default was 0.60.

**Why:** The code default in `mcp/src/config.ts` is 0.60, but `mcp/wrangler.toml` `[vars]` sets `MATCH_THRESHOLD = "0.35"`, which takes precedence. The system has been running at 0.35 throughout its operational life. Capture audits consistently show the LLM links selectively and accurately — the LLM is the quality gate, not the threshold. The lower value gives the LLM a generous candidate pool, which it filters well.

**Source:** #149 investigation. MATCH_THRESHOLD discrepancy discovered during #158 specialist review.

## get_related ordering: capture-time first, then confidence descending (2026-03-18)

**Decision:** Sort links in `fetchNoteLinks` so capture-time links appear before gardener links, with gardener links sorted by confidence (cosine score) descending.

**Why:** Capture-time links are LLM-reasoned and typed (`contradicts`, `related`) — higher signal than gardener links (`is-similar-to`), which are mathematical proximity without reasoning about *why*. The architecture defines gardener links as supplementary: they "complete the similarity graph that capture-time linking structurally cannot." Pure confidence-descending ordering would invert this hierarchy because capture-time links have `confidence: null` (no cosine score stored). Ordering matters more as gardener link volume increases at the lower 0.65 threshold.

**Source:** #149 investigation. Derived from architecture.md § Gardener Goal.

## Backup implementation: separate private repo, public schema only (2026-03-18)

**Decision:** Implementation choices for the automated backup workflow (#159):

1. **Storage target: separate private GitHub repo.** Not an orphan branch in the main repo (data dumps could be exposed if the main repo is public), not GitHub Artifacts (90-day expiration), not R2 (unnecessary complexity for v1). Git history provides natural retention and deduplication.
2. **Data dump scoped to `--schema public`.** The initial implementation dumped all schemas, which included Supabase internal tables (`auth`, `storage`) that failed with "permission denied" on restore. Scoping to `public` produces a clean dump that restores without errors.
3. **Verification via loose grep.** `pg_dump` quotes identifiers (`"public"."notes"`, not `COPY public.notes`), so verification checks use loose string matching. Checks confirm: non-empty files, pgvector present, both RPC functions present, notes data present, `capture_profiles` seed present.
4. **No `deploy.sh` integration.** The issue spec suggested an advisory check ("backup workflow not detected"). Skipped — the backup is orthogonal to the deploy pipeline and the setup guide covers it clearly.

**Why:** Discovered during implementation and restore testing. The `--schema public` fix was the most significant — it turned a documented workaround into a clean solution. The quoting issue was caught by the first GitHub Actions run (schema dump is produced by Supabase's pg_dump Docker image, which quotes all identifiers).

**Source:** #159 implementation, restore round-trip test on throwaway Supabase project (2026-03-18).

## Gardener clustering: cosine-only Louvain with shared pair fetch (2026-03-18)

**Decision:** Implement cluster detection as a second gardener phase using Graphology's Louvain `.detailed()` with cosine-only edge weights. Fetch all pairs at `GARDENER_COSINE_FLOOR` (0.40) once and share between similarity linking (filtered >= 0.65) and clustering (all pairs). Store pre-computed results in a `clusters` table with clean-slate-per-run semantics.

**Why:** The #152 experiment validated that cosine similarity alone produces coherent clusters (3 real domains at resolution 1.0 across 164 notes). Tags contribute marginal signal (5.4% pair overlap), and links reinforce rather than reshape cosine structure. Starting cosine-only keeps the implementation simple; tags, links, and entities become upgrade paths as signal quality improves (#151, #147, #125). Shared pair fetch saves one RPC round-trip per gardener run. Clustering failure is isolated via try/catch — it never affects the core similarity linker.

**Source:** #153 (implementation spec), #156 (PR 1 of 2), #152 (experiment validation). PR #164.

## Gravity formula: recency-weighted size (2026-03-18)

**Decision:** Cluster gravity = `size × avg(1 / (1 + age_days))`. Intentionally biases toward clusters with recent activity.

**Why:** A small cluster about something you're actively working on should outrank a large stale cluster. Pure size ranking would bury current work under historical accumulation. The `1/(1+age)` decay function gives today's note full weight (1.0) and a year-old note ~0.003. This matches the product philosophy: ContemPlace surfaces what's currently on your mind, not just what's historically dense.

**Source:** #153 design spec. Confirmed during specialist review of PR #164.

## Labels from tag aggregation, not LLM (2026-03-18)

**Decision:** Cluster labels are derived from top-3 most frequent tags across members. No LLM calls. Format: `"tag1 / tag2 / tag3"`. Fallback: `"Cluster (N notes)"` when no tags exist.

**Why:** The gardener stays LLM-free — all computation is deterministic and mathematical. Tag labels are sufficient for browsing (verified against live clusters: "pen-plotting / printmaking / generative-art" is immediately meaningful). LLM-generated narrative labels are an upgrade path but add cost, latency, and non-determinism to a nightly batch that should be cheap and reliable.

**Source:** #153 design spec. Live verification against 186-note corpus confirmed label quality.

## Threshold evaluation methodology: full overlap, not just sampling (2026-03-18)

**Decision:** When evaluating gardener threshold changes, always run full-corpus overlap analysis (all gardener pairs vs all capture pairs) alongside random-note sampling.

**Why:** A 10-note random sample of `get_related` results showed 100% gardener/capture duplication, which would have led to a false conclusion that the gardener adds no new signal. Full overlap analysis revealed 13 genuinely new connections out of 117 (11.1% novelty rate) — all in the 0.65–0.70 band, invisible at the old 0.70 threshold. The new connections break down by failure mode: 9 from context-window truncation (dense topics where the top-5 candidate window was too narrow), 4 from backward blindness (earlier notes that couldn't evaluate later arrivals). Random sampling under-represents sparse signal — it naturally lands in dense clusters where capture was thorough.

**Source:** #149 qualitative evaluation, 2026-03-18. The `scripts/threshold-analysis.ts` script covers distribution and sweep; the overlap analysis was done ad-hoc via direct DB queries and should be added to the script for future threshold reviews.

## list_clusters: resolution passthrough, not validation (2026-03-18)

**Decision:** The `list_clusters` MCP tool passes the resolution parameter through to the DB query as-is — no validation against available values, no clamping to [1.0, 1.5, 2.0]. If you ask for resolution 0.7, you get back an empty result.

**Why:** The available resolutions are configured via `GARDENER_CLUSTER_RESOLUTIONS` and can change without redeploying the MCP Worker. Hardcoding validation in the tool would create a coupling between gardener config and MCP config. The tool description lists the defaults ("Available: 1.0, 1.5, 2.0") as guidance, and agents follow it. An empty result for a non-existent resolution is a clear enough signal.

**Source:** #157 implementation. Kept simple to match the pattern of other tools that don't validate enum values.

## Tag signal is the highest-value clustering upgrade (2026-03-18)

**Decision:** Tag Jaccard similarity (#151/#147) is the next signal to add to the clustering edge weights, ahead of explicit links or entities.

**Why:** Live exploration of the 186-note corpus revealed that semantically related notes with shared tags but different embedding contexts (e.g., "Lightroom backup" at 0.32 cosine vs. "device loss contingency" at 0.33 cosine vs. "ContemPlace backup" at 0.45 cosine — all sharing the `backup` tag) fall below the cosine floor and remain unclustered. Tag Jaccard would boost these edges above the clustering threshold. The #152 experiment showed only 5.4% of note pairs share any tag, so the signal is sparse but precisely targeted at the gap cosine-only misses. Links reinforce existing structure rather than bridging gaps; entities aren't populated yet (#125).

**Source:** Live cluster exploration during #157 verification. Backup notes (Lightroom, device loss, ContemPlace) as concrete example.

## Agent onboarding must be explicit — tool descriptions alone don't work (2026-03-19)

**Decision:** Implicit onboarding via MCP tool descriptions is insufficient. Agents need an explicit training step. This confirms the direction in the "MCP agent training pattern" ADR (2026-03-13) with field evidence.

**Why:** Lived experience across multiple agent sessions showed that every agent connecting to ContemPlace starts blind — they do not read tool descriptions unprompted. They must be explicitly told to read them. This rules out the hope that well-written tool descriptions could serve as a lightweight training mechanism, and confirms that #107's explicit `get_training` tool (or equivalent) is necessary. A secondary proposal — storing orientation instructions as regular notes retrievable via search ("check my notes on how to use ContemPlace") — provides a fallback path that works without a dedicated tool.

**Source:** Captured fragment f88c7fcc (2026-03-19, Telegram). Analysis and design implications documented in #107 comment.

## Recent fragments: hybrid time-bounded count, not pure count (2026-03-19)

**Decision:** The recent fragments context for capture should use a hybrid approach — last N fragments within a time window — not a pure count-based fetch.

**Why:** A pure count-based approach (last 5 fragments regardless of age) returns stale context when the user hasn't captured recently. If the last capture was 72 hours ago, those 5 fragments share no session context with the current input and are contextually meaningless. The value of temporal context is precisely its temporality — it represents what the user is thinking about *right now*, in this capture session. Stale fragments aren't temporal context; they're just old notes.

The hybrid approach fetches the last N fragments that fall within a configurable time window (minimum ~5 minutes to catch burst captures, maximum ~1 day to cover a working session). Outside the window, the section is empty — which is the correct answer. "No recent context" is better than "irrelevant old context," especially given the tag bleed risk (#151 interaction).

**Tradeoff:** Slightly more complex query and configuration (count + window vs. just count). But the alternative — pure count — is simpler at the cost of being wrong in the common case where sessions are separated by hours or days.

**Source:** PR #191 review. The initial implementation used pure count; reworked to hybrid approach with `RECENT_FRAGMENTS_WINDOW_MINUTES` (default 60).

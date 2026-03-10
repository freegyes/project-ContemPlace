# Design decisions

This document captures the key decisions behind ContemPlace's architecture, the tradeoffs involved, and lessons learned from real usage. Many of these were refined through specialist reviews during the project bootstrap (see `reviews/` directory).

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

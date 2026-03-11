# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

ContemPlace is a cloud-hosted personal memory system. Telegram → Cloudflare Worker → structured note in Postgres (pgvector) → confirmation back to Telegram. An MCP server (Phase 2a, complete) exposes the note graph to AI agents via semantic search. Phase 2b (next) adds a gardening pipeline for nightly enrichment.

It is not a notes app. Notes are written by the capture agent, not the user. Users send raw input and receive confirmations. The raw input is always preserved alongside the structured note.

## Stack

| Layer | Technology |
|---|---|
| Database | Supabase (Postgres 16 + pgvector) |
| Compute | Cloudflare Workers (TypeScript, V8 runtime) |
| Capture interface | Telegram bot (webhook-based, not polling) |
| AI gateway | OpenRouter (`https://openrouter.ai/api/v1`), OpenAI-compatible SDK |
| Embeddings | `openai/text-embedding-3-small` — 1536 dimensions (default, no truncation). Configurable via `EMBED_MODEL` env var. |
| Capture LLM | `anthropic/claude-haiku-4-5` — configurable via `CAPTURE_MODEL` env var |

## Architecture

Cloudflare Workers handles the Telegram webhook. Supabase is the database only — no Edge Functions.

The capture flow is **async**: the Worker returns 200 to Telegram immediately, then processes in the background via `ctx.waitUntil()`. This eliminates Telegram retry issues and keeps the bot responsive regardless of LLM latency.

**System frame / capture voice split:** The system prompt is split into two parts:
- **System frame** (`SYSTEM_FRAME` constant in `src/capture.ts`) — structural contract: JSON schema, field enums, entity/link rules, voice correction instructions. Lives in code. Do not put stylistic rules here.
- **Capture voice** (stored in `capture_profiles` DB table, fetched at runtime) — title style, body rules, traceability, tone, examples. User-editable without code deployment. Any capture interface (Telegram, MCP, CLI) fetches the same profile.

```
Telegram → Cloudflare Worker → verify signature → check chat ID whitelist → dedup check → return 200
                                └→ ctx.waitUntil():
                                     embed raw text + fetch capture voice (parallel)
                                     → find related notes
                                     → LLM (system frame + capture voice)
                                     → re-embed with metadata augmentation (fallback to raw on failure)
                                     → DB insert (note + links)
                                     → enrichment log + Telegram reply (parallel)
```

## Project Layout

```
src/
  index.ts           # Worker entry point (webhook handler + async dispatch)
  config.ts          # Env var reading with defaults (all model strings and thresholds live here)
  capture.ts         # Capture agent (SYSTEM_FRAME, buildSystemPrompt, LLM call, parseCaptureResponse exported)
  embed.ts           # Embedding helpers (embedText, buildEmbeddingInput)
  telegram.ts        # Telegram API helpers (sendMessage, sendChatAction)
  db.ts              # Supabase client + DB operations (insertNote, logEnrichments, getCaptureVoice, findRelatedNotes)
  types.ts           # TypeScript interfaces (Telegram, capture result, DB row types, Intent, Modality, Entity)
mcp/
  wrangler.toml      # MCP Worker config (name: mcp-contemplace)
  tsconfig.json
  src/
    index.ts         # HTTP wrapper (CORS, routing, auth) + exported handleMcpRequest (JSON-RPC dispatch)
    tools.ts         # Tool definitions + handlers (search_notes, search_chunks, get, list, capture, list_unmatched_tags, promote_concept)
    auth.ts          # Bearer token auth (validateAuth, isStaticTokenRequest — constant-time comparison)
    config.ts        # Config loading with secret validation
    db.ts            # DB read/write functions (fetchNote, listRecentNotes, searchNotes, insertNote, …)
    embed.ts         # embedText, buildEmbeddingInput (copy of src/embed.ts)
    capture.ts       # parseCaptureResponse, runCaptureAgent (copy of src/capture.ts)
    types.ts         # MCP-specific TypeScript interfaces
gardener/
  wrangler.toml      # Gardener Worker config (name: contemplace-gardener, cron: 0 2 * * *)
  tsconfig.json
  src/
    index.ts         # scheduled() + fetch() exports — orchestrates tag normalization + similarity linking + chunk generation
    config.ts        # Config loading (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, thresholds, optional OPENROUTER_API_KEY)
    db.ts            # Similarity DB ops + tag normalization DB ops + chunk generation DB ops
    embed.ts         # embedText, batchEmbedTexts — OpenRouter via openai SDK (copy of src/embed.ts pattern)
    normalize.ts     # Tag matching logic: lexicalMatch, semanticMatch, cosineSimilarity, resolveNoteTags
    similarity.ts    # buildContext() — auto-generates link context from shared tags + entities
    chunk.ts         # splitIntoChunks, buildChunkEmbeddingInput — paragraph-boundary splitting for long notes
    alert.ts         # sendAlert() — best-effort Telegram failure notification
    auth.ts          # validateTriggerAuth() — Bearer token auth for /trigger endpoint
    types.ts         # Gardener-specific TypeScript interfaces (Concept, NoteForTagNorm, NoteForChunking, etc.)
scripts/
  deploy.sh          # Automated 6-step deploy pipeline (schema → typecheck → unit tests → Telegram Worker → Gardener Worker → smoke tests)
supabase/
  config.toml
  migrations/
    20260309000000_v2_schema.sql   # Current schema (v2 — full drop-and-recreate from v1)
  seed/
    seed_concepts.sql              # SKOS starter vocabulary (~30 concepts, 4 schemes — run manually in SQL Editor)
tests/
  parser.test.ts              # Unit tests for src/capture.ts parseCaptureResponse (17 tests, no network)
  smoke.test.ts               # Smoke tests against the live Telegram Worker
  mcp-auth.test.ts            # Unit tests for mcp/src/auth.ts
  mcp-config.test.ts          # Unit tests for mcp/src/config.ts
  mcp-embed.test.ts           # Unit tests for mcp/src/embed.ts + parity with src/embed.ts
  mcp-parser.test.ts          # Parity tests for mcp/src/capture.ts vs src/capture.ts (17 tests)
  mcp-tools.test.ts           # Unit tests for all 8 MCP tool handlers (mocked deps, no network)
  mcp-dispatch.test.ts        # Unit tests for handleMcpRequest JSON-RPC dispatch (27 tests, no network)
  mcp-index.test.ts           # Unit tests for MCP HTTP wrapper — auth, routing, CORS (9 tests)
  mcp-smoke.test.ts           # Smoke tests against the live MCP Worker
  semantic.test.ts            # Semantic correctness suite — tagging, linking, search quality (45 tests, hits live stack)
  gardener-similarity.test.ts # Unit tests for buildContext() and UUID ordering deduplication (13 tests)
  gardener-normalize.test.ts  # Unit tests for tag matching: lexicalMatch, semanticMatch, resolveNoteTags (23 tests)
  gardener-embed.test.ts      # Parity tests for gardener/src/embed.ts vs src/embed.ts + mcp/src/embed.ts (3 tests)
  gardener-config.test.ts     # Unit tests for gardener/src/config.ts loadConfig (12 tests)
  gardener-alert.test.ts      # Unit tests for sendAlert() — Telegram alerting (10 tests)
  gardener-trigger.test.ts    # Unit tests for /trigger endpoint auth + routing (13 tests)
  gardener-chunk.test.ts      # Unit tests for splitIntoChunks and buildChunkEmbeddingInput (16 tests)
  gardener-integration.test.ts # Integration test: capture → gardener /trigger → get_related (live stack)
docs/                # Detailed documentation (architecture, capture agent, schema, decisions, roadmap)
wrangler.toml        # Telegram Worker Cloudflare config
package.json
tsconfig.json
```

## Environment Variables

Deployed secrets via `wrangler secret put`. Local dev and tests via `.dev.vars` (single source of truth).

```
# Required — no defaults
TELEGRAM_BOT_TOKEN          # from BotFather
TELEGRAM_WEBHOOK_SECRET     # openssl rand -hex 32
OPENROUTER_API_KEY          # from openrouter.ai
SUPABASE_URL                # from Supabase dashboard → Project Settings → API
SUPABASE_SERVICE_ROLE_KEY   # from Supabase dashboard → Project Settings → API
ALLOWED_CHAT_IDS            # comma-separated Telegram chat IDs allowed to use the bot

# Configurable — defaults in src/config.ts
CAPTURE_MODEL               # default: anthropic/claude-haiku-4-5
EMBED_MODEL                 # default: openai/text-embedding-3-small
MATCH_THRESHOLD             # default: 0.60 (must be a float between 0 and 1)

# MCP Worker secrets (set via: wrangler secret put <NAME> -c mcp/wrangler.toml)
MCP_API_KEY                 # generate with: openssl rand -hex 32

# MCP Worker configurable — defaults in mcp/src/config.ts
MCP_SEARCH_THRESHOLD        # default: 0.35 — used only by search_notes. Lower than MATCH_THRESHOLD
                             # because stored embeddings are metadata-augmented; bare query vectors
                             # score 0.41–0.49 against them, well below the 0.60 capture threshold.

# Gardener Worker secrets (set via: wrangler secret put <NAME> -c gardener/wrangler.toml)
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are shared with the Telegram Worker above.
TELEGRAM_BOT_TOKEN            # optional — same as capture Worker; enables failure alerts to Telegram
TELEGRAM_ALERT_CHAT_ID        # optional — chat ID to receive failure alerts (same as ALLOWED_CHAT_IDS)
GARDENER_API_KEY              # optional — enables POST /trigger endpoint (generate with: openssl rand -hex 32)

# Gardener Worker configurable — defaults in gardener/wrangler.toml [vars]
GARDENER_SIMILARITY_THRESHOLD  # default: 0.70 — augmented-vs-augmented cosine similarity.
                                # Distinct from MATCH_THRESHOLD (0.60, raw query vs. augmented store)
                                # and MCP_SEARCH_THRESHOLD (0.35, bare NL query vs. augmented store).
GARDENER_TAG_MATCH_THRESHOLD   # default: 0.55 — bare tag string vs. concept definition embedding.
                                # Fourth independent threshold. Tune via unmatched_tag log feedback.

# Test-only
WORKER_URL                  # deployed Telegram Worker URL, for smoke tests
TELEGRAM_CHAT_ID            # your personal chat ID, for smoke tests
MCP_WORKER_URL              # deployed MCP Worker URL, for mcp-smoke tests
GARDENER_WORKER_URL         # deployed Gardener Worker URL, for gardener-integration tests
```

## Key Commands

```bash
# ── Telegram Worker ───────────────────────────────────────────────────────────
# Deploy the Telegram Worker
wrangler deploy

# Set a Telegram Worker secret
wrangler secret put TELEGRAM_BOT_TOKEN

# Local dev server
wrangler dev

# Apply database migrations
supabase db push

# Run parser unit tests (local, no network)
npx vitest run tests/parser.test.ts

# Run smoke tests (against live Telegram Worker)
npx vitest run tests/smoke.test.ts

# Typecheck
npx tsc --noEmit

# ── MCP Worker ────────────────────────────────────────────────────────────────
# Deploy the MCP Worker
wrangler deploy -c mcp/wrangler.toml

# Set an MCP Worker secret
wrangler secret put MCP_API_KEY -c mcp/wrangler.toml

# Run all MCP unit tests (local, no network)
npx vitest run tests/mcp-auth.test.ts tests/mcp-config.test.ts tests/mcp-embed.test.ts tests/mcp-parser.test.ts tests/mcp-tools.test.ts tests/mcp-dispatch.test.ts tests/mcp-index.test.ts

# Run MCP smoke tests (against live MCP Worker — requires MCP_WORKER_URL + MCP_API_KEY in .dev.vars)
npx vitest run tests/mcp-smoke.test.ts

# Run semantic correctness suite (live stack — tagging, linking, search; ~70s; cleans up after itself)
npx vitest run tests/semantic.test.ts

# ── Gardener Worker ───────────────────────────────────────────────────────────
# Deploy the Gardener Worker
wrangler deploy -c gardener/wrangler.toml

# Set Gardener Worker secrets (SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY required)
wrangler secret put SUPABASE_URL -c gardener/wrangler.toml
wrangler secret put SUPABASE_SERVICE_ROLE_KEY -c gardener/wrangler.toml
wrangler secret put TELEGRAM_BOT_TOKEN -c gardener/wrangler.toml        # optional — failure alerts
wrangler secret put TELEGRAM_ALERT_CHAT_ID -c gardener/wrangler.toml    # optional — failure alerts
wrangler secret put GARDENER_API_KEY -c gardener/wrangler.toml          # optional — enables /trigger endpoint

# Typecheck the Gardener Worker
npx tsc --noEmit -p gardener/tsconfig.json

# Run Gardener unit tests (local, no network)
npx vitest run tests/gardener-similarity.test.ts tests/gardener-normalize.test.ts tests/gardener-embed.test.ts tests/gardener-config.test.ts tests/gardener-alert.test.ts tests/gardener-trigger.test.ts tests/gardener-chunk.test.ts

# Run Gardener integration test (live stack — captures notes, triggers gardener, checks get_related)
# Requires MCP_WORKER_URL, MCP_API_KEY, GARDENER_WORKER_URL, GARDENER_API_KEY in .dev.vars
npx vitest run tests/gardener-integration.test.ts

# Trigger a gardener run locally against the live DB (symlink gardener/.dev.vars → .dev.vars first)
# ln -s ../.dev.vars gardener/.dev.vars
npx wrangler dev -c gardener/wrangler.toml --test-scheduled
# then: curl "http://localhost:8787/__scheduled?cron=0+2+*+*+*"
```

## Hard Constraints

1. **Embedding dimension is 1536**. Default output of `text-embedding-3-small`, no `dimensions` parameter. Changing after first insert requires a full table rewrite and re-embed of all notes.
2. **All AI calls via OpenRouter** at `https://openrouter.ai/api/v1`. Use the `openai` npm package with `baseURL` override.
3. **All DB access uses `SUPABASE_SERVICE_ROLE_KEY`**, never the anon key.
4. **Use `<=>` operator** for cosine distance in pgvector (not `<->` which is L2). In RPC functions created via migrations, use `OPERATOR(extensions.<=>)` — PostgREST cannot resolve pgvector operators via `search_path` alone.
5. **`source` field is always set** at insert — never null.
6. **Register Telegram webhook after deploying the Worker**, not before.
7. **Model strings and behavioral thresholds are env vars**, read via `src/config.ts`. Never hardcode a model string at a call site.
8. **Return 200 to Telegram immediately**, process capture in `ctx.waitUntil()`.
9. **Always store the user's raw input** in `notes.raw_input` alongside the LLM-generated title and body.
10. **Two-pass embedding**: first embed uses raw text (for finding related notes); second embed uses `buildEmbeddingInput()` with metadata augmentation (for storage). If the second embed fails, fall back to the raw embedding — never lose the note.
11. **RPC functions must be in the `public` schema** with `set search_path = 'public, extensions'`. Functions in the `extensions` schema are not visible to PostgREST's `.rpc()` by default. Use explicit `public.table_name` references and `OPERATOR(extensions.<=>)` for pgvector operators — the connection pooler's execution context does not reliably resolve these via `search_path`.
12. **Stylistic prompt rules (title style, body rules, traceability) must come from `capture_profiles` table**, never hardcoded in source. Edit the DB row to tune capture behavior without redeploying.
13. **JSONB columns (`entities`, `metadata`) contain LLM-generated content** — never interpolate their values into raw SQL strings.

## Capture Logic (v2)

1. Worker receives Telegram webhook POST
2. Verify `x-telegram-bot-api-secret-token` header — return 403 if missing/wrong
3. Parse body, guard non-text messages (sticker, photo, voice, etc.) — return 200
4. Check `message.chat.id` against `ALLOWED_CHAT_IDS` whitelist — return 200 silently if not allowed
5. Dedup check: insert `update_id` into `processed_updates` — if `23505` unique violation, return 200
6. **Return 200 to Telegram** (everything below runs in `ctx.waitUntil()`)
7. In parallel: embed raw message text, fetch capture voice from `capture_profiles`, send `typing` action
8. Call `match_notes(embedding, threshold, count=5)` for related notes
9. Call capture LLM with (system frame + capture voice) + raw message + related notes (with type/intent metadata) + today's date
10. Parse JSON response, validate all 10 fields with logged fallback defaults
11. Re-embed with metadata augmentation (`buildEmbeddingInput`). On failure, fall back to raw embedding and log `augmented_embed_fallback`
12. Insert note into `notes` with augmented embedding, `raw_input`, `intent`, `modality`, `entities`, `corrections`, `embedded_at`; insert links into `links`
13. In parallel: insert two `enrichment_log` rows (capture + embedding); send HTML-formatted confirmation to Telegram
14. Telegram reply format: bold title, separator line, body, italic `type · intent · tags` line, optional Linked/Corrections/Source/Entities lines. Message capped at 4096 chars.
15. On any error in steps 7–13: send generic error to Telegram, log full details to console

## Capture Agent Output Format

The LLM returns this JSON and nothing else:

```json
{
  "title": "...",
  "body": "...",
  "type": "idea|reflection|source|lookup",
  "tags": ["...", "..."],
  "source_ref": null,
  "corrections": ["garbled → corrected"] | null,
  "intent": "reflect|plan|create|remember|reference|log",
  "modality": "text|link|list|mixed",
  "entities": [{"name": "...", "type": "person|place|tool|project|concept"}],
  "links": [
    { "to_id": "<uuid>", "link_type": "extends|contradicts|supports|is-example-of|duplicate-of" }
  ]
}
```

**Type rules:** `reflection` = first-person personal insight (explicit signal required); `lookup` = investigative prompt only; `source` = external URL included; `idea` = default.

**Intent rules (6 values):** `reflect` = processing experience/feeling; `plan` = future action, aspirations, wishes; `create` = specific thing to make; `remember` = storing a fact/detail; `reference` = external content (URL present or explicitly saving someone else's work); `log` = recording what happened. `remember` vs `reference`: use `remember` when no URL, `reference` when URL present. `wish` was merged into `plan`.

**Type and intent are independent facets** — a `source` note can have `plan` intent, a `reflection` can have `remember` intent.

**Link types:** `extends` = builds on/deepens; `contradicts` = challenges; `supports` = reinforces or parallel/sibling idea toward same goal; `is-example-of` = concrete instance; `duplicate-of` = covers substantially the same content as an existing note (note is still created; deduplication is a gardening concern).

**Entity extraction:** proper nouns only, explicitly in the input — not from related notes, not from training data. Use corrected name from `corrections` field if applicable.

## Schema (v2)

8 tables total:
- `notes` — core notes with 9 new v2 columns (intent, modality, entities, corrections, summary, refined_tags, categories, metadata, importance_score, maturity, archived_at, embedding, embedded_at, content_tsv)
- `links` — 9 link types (5 capture-time + 4 gardening-time); includes context, confidence, created_by
- `concepts` — SKOS controlled vocabulary (scheme, pref_label, alt_labels, definition, embedding)
- `note_concepts` — junction: notes ↔ concepts
- `note_chunks` — RAG chunks for long notes (deferred to gardening pipeline)
- `enrichment_log` — audit trail per note per enrichment type
- `capture_profiles` — user-editable stylistic prompt rules; seeded with 'default' profile
- `processed_updates` — Telegram dedup

RPC functions in `public` schema: `match_notes` (hybrid vector + full-text, 8 params), `match_chunks` (chunk-level vector search, returns note metadata), `batch_update_refined_tags` (JSONB batch update), `find_similar_pairs` (self-join cosine similarity).

## Registering the Telegram Webhook

After deploying the Worker:

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://contemplace.YOUR_SUBDOMAIN.workers.dev" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  -d 'allowed_updates=["message"]'
```

Verify: `curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"`

## Phase Scope

- **Phase 1 (complete):** Schema (notes, links, processed_updates), Telegram bot, Cloudflare Worker with async capture, chat ID whitelist, single capture mode, confirmation replies.
- **Phase 1.5 (complete):** Schema v2 (8 tables), metadata-augmented embeddings, `intent`/`modality`/`entities` extraction, capture voice in DB, enrichment log, expanded link types, parser unit tests. Deployed and verified via smoke tests.
- **Phase 2a (complete):** MCP server — separate Cloudflare Worker exposing 8 tools (`search_notes`, `search_chunks`, `get_note`, `list_recent`, `get_related`, `capture_note`, `list_unmatched_tags`, `promote_concept`) over JSON-RPC 2.0. Bearer token auth. Tagged `v2.0.0`.
- **Phase 2b (complete):** Gardening pipeline — nightly similarity linker, SKOS tag normalization, chunk generation. Maturity scoring deferred. Tagged `v2.5.0`.
- **Phase 3 (deferred):** Associative trails, type inheritance (`note_types`), location extraction.

## Deploy

Everything is automated. One command:

```bash
bash scripts/deploy.sh
```

**Prerequisite:** The Supabase project must be linked (`supabase link --project-ref <ref>`). All secrets must be in `.dev.vars`.

The script runs in order:
1. `supabase db push --linked` — applies pending migrations via the Supabase connection pooler (no direct port 5432 access required)
2. `tsc --noEmit` — typecheck
3. `vitest run tests/parser.test.ts` — 17 parser unit tests (local, no network)
4. `wrangler deploy` — deploys the Worker
5. `vitest run tests/smoke.test.ts` — end-to-end smoke tests against live Worker

Use `--skip-smoke` to skip step 5 and test manually.

## Product Intent

**Core principle:** The user must never think about the system itself. They are free to think what they think and capture it anytime, anywhere, easily, without stressing about administration, routing, or what happens on the other side. They trust that the DB will contain it in an easily retrievable, useful manner. This is the foundational design principle — every architectural decision evaluates against it.

**The problem ContemPlace solves:** Every AI agent builds memory about you in its own proprietary garden — isolated, non-portable, and non-trivial to even extract. Switching to a new tool means starting from zero. ContemPlace inverts this: your memory lives in a database you own, any MCP-capable agent can read and write it, and your accumulated context travels with you. You stop being locked into any single agent's ecosystem.

**Emergent structure, not imposed structure.** Notes cluster around themes over time. Some nodes gain gravitational weight — many connections, recent activity. The user can explore what's currently on their mind, trace how ideas evolved, and generate visual representations. The system doesn't impose organization; organization emerges from the accumulation of linked, gardened notes. This is closer to maps of content (MOCs) than to folders or categories.

### What is ContemPlace?

The irreducible core is the **database + MCP surface**. That is the product. Everything else — the Telegram bot, the smart capture router, import tools, a dashboard — is an optional module.

Three layers, each with a clear job:

1. **Input** — get stuff into the database. Can be the Telegram bot (zero-friction capture on the go), the smart capture router (future: auto-detects input type), or any MCP-capable agent the user brings (Claude CLI, custom scripts, other tools). The `capture_note` MCP tool is the universal input gate — the Telegram bot is one client of it.
2. **Enrichment** — the gardening pipeline. This is the quality guarantee. No matter how raw or messy the input, gardening produces: normalized tags, similarity links, chunks for retrieval. It's what makes the database *useful* rather than just full.
3. **Retrieval** — agents query the enriched graph via MCP. Vector search, chunk search, semantic tools. This is where the value compounds. The primary access pattern is agent-driven, not human-driven.

### Input quality: capture_note is a smart gate

`capture_note` is the **write API**. There is no other supported input path. The server runs the full LLM pipeline internally — the user sends raw text, the system handles embedding, classification, linking, and storage. Quality is guaranteed by construction: every note exits the pipeline with all 10 structured fields, an embedding, and preserved raw input. The gardener can work with any note that passed through the gate.

The smart capture router (issue #27) enhances what happens *inside* `capture_note` — routing different input types to specialized handlers. It's an upgrade to the gate, not a bypass.

### Design implications (under active review)

This architectural clarity is recent. Several existing decisions need revisiting:
- The Telegram Worker and MCP Worker duplicate capture logic (#46). If MCP is the universal gate, the Telegram Worker should delegate rather than duplicate.
- The smart capture router (#27) should enhance the MCP surface, not just the Telegram Worker.
- The input quality contract needs formal definition (#45).
- The SYSTEM_FRAME could be published as a spec for agent guidance (#47).

These questions need thorough strategic thinking before implementation. The current architecture works but was designed with Telegram as the primary input.

The `raw_input` column preserves the user's exact words. The structured note (title, body, tags, links) is the LLM's interpretation — useful for retrieval, but the raw input is the irreplaceable source of truth and must never be discarded.

## Design Philosophy

The system is built for rapid iteration. All behavioral parameters (models, thresholds, prompts) should be changeable without code modifications where practical. When a change requires redeployment, it should be a one-line config change, not a code refactor. The architecture should never prevent the owner from tuning the system's behavior based on real usage.

**Specialist review before implementation.** Before writing code for a non-trivial feature, launch specialist review agents (Plan agents) to evaluate the design — surface edge cases, identify missing prerequisites, flag architectural concerns, and challenge assumptions. This catches design mistakes that are expensive to fix mid-implementation (e.g., missing DB columns that scope deletes depend on, seed data conflicts, threshold interactions). The review should cover: schema readiness, API surface, error handling strategy, idempotency, and interaction with existing pipeline steps. Only start coding after the review findings are addressed.

**Validate against reality before declaring done.** Unit tests passing is necessary but not sufficient. Before a feature is considered ready to merge, deploy to the live stack and run an end-to-end simulation that approximates real-world usage — capture real notes, trigger real pipelines, verify real DB state. This catches things unit tests cannot: platform limits (CF Workers subrequest budget), missing runtime dependencies (seed data, secrets), schema mismatches, and integration failures between Workers. If a feature touches the gardener or MCP tools, write or extend an integration test that exercises the full cycle against the deployed Workers.

## Version Control Conventions

This repo uses a branch-per-feature workflow with semantic version tags. **Always follow this pattern.**

**Branching:**
- `main` is always stable and deployable. Never commit directly to main for feature work.
- Feature branches: `feat/<short-name>` (e.g. `feat/phase-2-gardening`, `feat/mcp-server`)
- Hotfix branches: `fix/<short-name>` for urgent production fixes
- Create a branch, commit there, open a PR, merge to main.

**Pull Requests:**
- Every non-trivial change goes through a PR, even solo. The PR body documents what changed and why.
- Include a test plan checklist in the PR body.
- After merging, delete the feature branch.

**Commit messages (Conventional Commits):**
- `feat:` — new feature or phase
- `fix:` — bug fix
- `chore:` — maintenance (deps, config, tooling)
- `docs:` — documentation only
- `refactor:` — no behavior change
- `test:` — tests only

**Tagging (Semantic Versioning):**
- `v<major>.<minor>.<patch>` — tagged on `main` after merging a meaningful phase or feature
- Phase releases: `v1.0.0` (Phase 1), `v1.5.0` (Phase 1.5), `v2.0.0` (Phase 2), etc.
- Patch tags for hotfixes: `v1.5.1`, etc.
- Tag immediately after merging, before starting the next branch:
  ```bash
  git tag v<version>
  git push origin v<version>
  ```

**Issues:**
- Open a GitHub Issue before starting significant work. Reference it in commit messages with `refs #<n>`.
- Phase progress is tracked via GitHub Milestones — not in this file.
  - [Phase 2b — Gardening pipeline](https://github.com/freegyes/project-ContemPlace/milestone/1)
  - [Phase 2c — OAuth 2.1](https://github.com/freegyes/project-ContemPlace/milestone/2)

## Documentation Framework

Each layer owns a specific type of information. **Never duplicate across layers** — that's how things go stale.

### What lives where

| Layer | Owns | Updated when |
|---|---|---|
| **GitHub Issues** | Everything in-flight: bugs, questions, ideas, design explorations. When resolved, close with a comment explaining the outcome. | Continuously — during every session |
| **GitHub Milestones** | Phase-level progress. Issues attach to the milestone they belong to. Real-time view without any file needing updating. | When issues open/close |
| **`docs/decisions.md`** | Architecture Decision Records (ADRs). Timestamped, immutable. When a decision changes, add a new entry — never edit old ones. | At decision time |
| **`docs/roadmap.md`** | Narrative of what each phase delivered and what's next. | When a feature ships or a phase closes |
| **`docs/schema.md`** | All tables, RPC functions, indexes, columns. | When schema or RPC functions change |
| **`docs/architecture.md`** | Workers, data flow, embedding strategy, error handling. | When architecture changes |
| **`docs/capture-agent.md`** | Classification taxonomy, linking logic, voice correction. | When capture behavior changes |
| **`CLAUDE.md`** | Stable AI context: architecture, hard constraints, key files, conventions. No current state, no issue indexes, no phase status. | When architecture or conventions change |
| **`README.md`** | Front door: status table, tool list, test count, project layout, quick start. | When any user-visible surface changes |

### Rules

1. **Repo files describe stable facts.** Architecture, constraints, conventions. Not "what's currently open" or "what's next."
2. **GitHub is the single source of truth for status.** Phase progress → milestones. Open questions → issues. Never mirror these into a file.
3. **ADRs are immutable.** Add a new entry when a decision changes; never update old ones. The timestamp matters.
4. **When something comes up during a session** — bug, question, idea, concern — open an issue immediately, then keep going. Never defer to "I'll note that later."
5. **Documentation is part of the deliverable, not a follow-up task.** A feature is not done until the docs reflect it. Code changes without corresponding doc updates are incomplete work — the same as shipping without tests. This applies to every PR, not just phase closings.
6. **Proactive housekeeping at every organic breakpoint.** After completing a PR, merging, closing an issue, or finishing a logical chunk of work — automatically do the documentation sweep before moving on. Do not ask whether to do this. It is always expected:
   - Update `docs/` files that describe anything touched by the change (`architecture.md`, `schema.md`, `capture-agent.md`, `roadmap.md`)
   - Update `README.md` if the status table, tool list, test count, project layout, or quick start is affected
   - Update `CLAUDE.md` if architecture, constraints, file layout, commands, or conventions changed
   - Record any new architectural decisions in `docs/decisions.md`
   - Comment on relevant GitHub issues with outcomes or status updates
   - Close resolved issues with a resolution comment
   - Clean up stale branches

### Phase-close ritual

When a phase PR merges:
1. Update `docs/roadmap.md` — add a "Delivered" section for the phase
2. Update the README status table — move the phase from 🔜 to ✅
3. Close the GitHub milestone
4. Tag `main` with the version (`v2.0.0`, `v2.5.0`, etc.)
5. Open a new milestone for the next phase, attach relevant issues

### Issue label taxonomy

| Label | When to use |
|---|---|
| `bug` | Something is broken or wrong |
| `enhancement` | New feature or improvement |
| `question` | Open design decision — not necessarily actionable yet |
| `test` | Test cases, behavioral validation, quality verification |
| `security` | Auth, privacy, data exposure concerns |
| `product` | Product vision, principles, what-is-this questions |
| `module` | A new optional interaction layer or import tool |
| `docs` | Documentation, README, contributor guide |
| `phase-2b` / `phase-2c` / `phase-3` | Phase scoping |

Labels are managed via `gh label create` — no UI required.


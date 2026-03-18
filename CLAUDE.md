# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

ContemPlace is a modern commonplace book that auto-gardens into an MCP-connected PKM system. Capture idea fragments from Telegram or any MCP client — the system structures, embeds, and links them into a searchable knowledge graph in Postgres (pgvector). A nightly gardening pipeline surfaces similarity connections.

It is not a notes app. Notes are written by the capture agent, not the user. Users send raw input and receive confirmations. The raw input is always preserved alongside the structured fragment.

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

**Single capture path:** The Telegram Worker delegates capture to the MCP Worker via a Cloudflare Service Binding (in-process RPC, no HTTP hop). The capture pipeline lives in `mcp/src/pipeline.ts` — one source of truth for all gateways.

**System frame / capture voice split:** The system prompt is split into two parts:
- **System frame** (`SYSTEM_FRAME` constant in `mcp/src/capture.ts`) — structural contract: JSON schema, field enums, link rules, voice correction instructions. Lives in code. Do not put stylistic rules here.
- **Capture voice** (stored in `capture_profiles` DB table, fetched at runtime) — title style, body rules, traceability, tone, examples. User-editable without code deployment. Any capture interface (Telegram, MCP, CLI) fetches the same profile.

```
Telegram → Telegram Worker → verify signature → check chat ID whitelist → /start → /undo → dedup check → return 200
                              └→ /undo: env.CAPTURE_SERVICE.undoLatest() → hard-delete most recent Telegram capture in grace window
                              └→ capture: ctx.waitUntil():
                                   typing indicator
                                   → Service Binding RPC to MCP Worker (env.CAPTURE_SERVICE.capture)
                                   → MCP Worker runs pipeline.ts:
                                       embed raw text + fetch capture voice (parallel)
                                       → find related notes → LLM → re-embed → DB insert → log
                                   → format HTML reply with emoji indicators
                                   → send Telegram reply
```

## Project Layout

```
src/
  index.ts           # Worker entry point (webhook handler, /undo command, Service Binding calls to MCP Worker, HTML reply formatting)
  config.ts          # Env var reading (Telegram + Supabase only — model/threshold config lives in MCP Worker)
  telegram.ts        # Telegram API helpers (sendMessage, sendChatAction)
  db.ts              # Supabase client + dedup only (createSupabaseClient, tryClaimUpdate)
  types.ts           # TypeScript interfaces (Telegram types, CaptureServiceStub, ServiceCaptureResult)
mcp/
  wrangler.toml      # MCP Worker config (name: mcp-contemplace)
  tsconfig.json
  src/
    index.ts         # OAuthProvider setup, CaptureService entrypoint (capture + undoLatest), McpApiHandler, resolveExternalToken bypass
    pipeline.ts      # Single source of truth for capture logic — called by Service Binding RPC + capture_note tool
    oauth.ts         # Consent page HTML renderer + AuthHandler (GET/POST /authorize)
    tools.ts         # Tool definitions + handlers (search_notes, get_note, list_recent, get_related, capture_note, remove_note)
    auth.ts          # Bearer token auth (validateAuth, isStaticTokenRequest, timingSafeEqual — constant-time comparison)
    config.ts        # Config loading with secret validation
    db.ts            # DB read/write functions (fetchNote, listRecentNotes, searchNotes, insertNote, …)
    embed.ts         # embedText, buildEmbeddingInput
    capture.ts       # SYSTEM_FRAME, parseCaptureResponse, runCaptureAgent
    types.ts         # MCP-specific TypeScript interfaces (Env, ServiceCaptureResult, CaptureResult, etc.)
gardener/
  wrangler.toml      # Gardener Worker config (name: contemplace-gardener, cron: 0 2 * * *)
  tsconfig.json
  src/
    index.ts         # scheduled() + fetch() exports — orchestrates similarity linking
    config.ts        # Config loading (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, thresholds)
    db.ts            # Similarity DB ops
    similarity.ts    # buildContext() — auto-generates link context from shared tags
    alert.ts         # sendAlert() — best-effort Telegram failure notification
    auth.ts          # validateTriggerAuth() — Bearer token auth for /trigger endpoint
    types.ts         # Gardener-specific TypeScript interfaces
scripts/
  deploy.sh          # Automated deploy pipeline (schema → typecheck → unit tests → MCP Worker → Telegram Worker → bot commands → Gardener Worker → smoke tests)
  cluster-experiment.ts  # Clustering experiment — weighted graph + Louvain against live corpus (read-only, run via `npx tsx`)
supabase/
  config.toml
  migrations/
    20260314000000_v3_schema.sql   # Base schema (v3 — clean-slate, no type/intent/modality)
    20260315000000_v4_simplification.sql  # Schema simplification (drop SKOS, chunking, simplify links)
tests/
  parser.test.ts              # Unit tests for mcp/src/capture.ts parseCaptureResponse (no network)
  undo.test.ts                # Unit tests for /undo command (grace window, source filter, errors)
  smoke.test.ts               # Smoke tests against the live Telegram Worker
  mcp-auth.test.ts            # Unit tests for mcp/src/auth.ts
  mcp-config.test.ts          # Unit tests for mcp/src/config.ts
  mcp-embed.test.ts           # Unit tests for mcp/src/embed.ts
  mcp-tools.test.ts           # Unit tests for all MCP tool handlers (mocked deps, no network)
  mcp-dispatch.test.ts        # Unit tests for handleMcpRequest JSON-RPC dispatch (no network)
  mcp-index.test.ts           # Unit tests for OAuthProvider config + resolveExternalToken
  mcp-oauth.test.ts           # Unit tests for consent page rendering, AuthHandler, CONSENT_SECRET validation
  mcp-smoke.test.ts           # Smoke tests against the live MCP Worker
  semantic.test.ts            # Semantic correctness suite — tagging, linking, search quality (hits live stack)
  gardener-similarity.test.ts # Unit tests for buildContext() and UUID ordering deduplication
  gardener-config.test.ts     # Unit tests for gardener/src/config.ts loadConfig
  gardener-alert.test.ts      # Unit tests for sendAlert() — Telegram alerting
  gardener-trigger.test.ts    # Unit tests for /trigger endpoint auth + routing
  gardener-integration.test.ts # Integration test: capture → gardener /trigger → get_related (live stack)
.claude/
  settings.json         # Project-level permissions (Edit/Write on working directories — inherited by worktrees)
  commands/
    orchestrate.md      # Custom command: orchestrator mode — parallel cmux workspaces + git worktrees
    extract-fragments.md  # Custom command: topic-driven Obsidian re-capture sessions — search vault, decompose, re-voice, interactive capture
    harvest-ideas.md      # Custom command: search corpus for actionable product ideas, cross-reference with issues
    audit-captures.md     # Custom command: capture quality audit — body fidelity, title style, linking, retrieval
    work-on-issue.md      # Custom command: full issue workflow — gather → review → plan → implement → verify → ship
    reflect.md            # Custom command: session-closing ritual — review pushbacks, improve commands/docs/memory
docs/                # Detailed documentation (architecture, capture agent, schema, decisions, roadmap)
wrangler.toml        # Telegram Worker Cloudflare config
package.json
tsconfig.json
```

## Environment Variables

Deployed secrets via `wrangler secret put`. Local dev and tests via `.dev.vars` (single source of truth).

```
# Telegram Worker — required, no defaults
TELEGRAM_BOT_TOKEN          # from BotFather
TELEGRAM_WEBHOOK_SECRET     # openssl rand -hex 32
SUPABASE_URL                # from Supabase dashboard → Project Settings → API (for dedup only)
SUPABASE_SERVICE_ROLE_KEY   # from Supabase dashboard → Project Settings → API (for dedup only)
ALLOWED_CHAT_IDS            # comma-separated Telegram chat IDs allowed to use the bot
# Note: OPENROUTER_API_KEY, CAPTURE_MODEL, EMBED_MODEL, MATCH_THRESHOLD moved to MCP Worker.
# The Telegram Worker delegates capture via Service Binding — it no longer needs AI/model config.

# MCP Worker secrets (set via: wrangler secret put <NAME> -c mcp/wrangler.toml)
MCP_API_KEY                 # generate with: openssl rand -hex 32
CONSENT_SECRET              # protects OAuth consent page; generate with: openssl rand -hex 16

# MCP Worker configurable — defaults in mcp/wrangler.toml [vars] or mcp/src/config.ts
# MATCH_THRESHOLD            # deployed: 0.35 (set in mcp/wrangler.toml [vars]). Code default 0.60
#                             # is overridden by the toml value. Raw query vs. augmented store.
#                             # The LLM is the quality gate — the low threshold gives it a generous
#                             # candidate pool, and it links selectively.
MCP_SEARCH_THRESHOLD        # default: 0.35 — used only by search_notes. Lower than MATCH_THRESHOLD
                             # because stored embeddings are metadata-augmented; bare query vectors
                             # score 0.41–0.49 against them.
HARD_DELETE_WINDOW_MINUTES  # default: 11 — grace window for remove_note and /undo. Notes younger
                             # than this are permanently deleted; older notes are soft-archived
                             # (remove_note) or refused (/undo).

# Gardener Worker secrets (set via: wrangler secret put <NAME> -c gardener/wrangler.toml)
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are shared with the Telegram Worker above.
TELEGRAM_BOT_TOKEN            # optional — same as capture Worker; enables failure alerts to Telegram
TELEGRAM_ALERT_CHAT_ID        # optional — chat ID to receive failure alerts (same as ALLOWED_CHAT_IDS)
GARDENER_API_KEY              # optional — enables POST /trigger endpoint (generate with: openssl rand -hex 32)

# Gardener Worker configurable — defaults in gardener/wrangler.toml [vars]
GARDENER_SIMILARITY_THRESHOLD  # default: 0.65 — augmented-vs-augmented cosine similarity.
                                # Lowered from 0.70 (2026-03-18, #149) — 0.70 produced only 38 pairs
                                # and systematically excluded Telegram fragments. 0.65 triples candidates
                                # to 117 with quality confirmed by human review.
                                # Distinct from MATCH_THRESHOLD (0.35, raw query vs. augmented store)
                                # and MCP_SEARCH_THRESHOLD (0.35, bare NL query vs. augmented store).

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
npx vitest run tests/mcp-auth.test.ts tests/mcp-config.test.ts tests/mcp-embed.test.ts tests/mcp-tools.test.ts tests/mcp-dispatch.test.ts tests/mcp-index.test.ts tests/mcp-oauth.test.ts

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
npx vitest run tests/gardener-similarity.test.ts tests/gardener-config.test.ts tests/gardener-alert.test.ts tests/gardener-trigger.test.ts

# Run Gardener integration test (live stack — captures notes, triggers gardener, checks get_related)
# Requires MCP_WORKER_URL, MCP_API_KEY, GARDENER_WORKER_URL, GARDENER_API_KEY in .dev.vars
npx vitest run tests/gardener-integration.test.ts

# Trigger a gardener run locally against the live DB (symlink gardener/.dev.vars → .dev.vars first)
# ln -s ../.dev.vars gardener/.dev.vars
npx wrangler dev -c gardener/wrangler.toml --test-scheduled
# then: curl "http://localhost:8787/__scheduled?cron=0+2+*+*+*"

# ── Clustering Experiment ─────────────────────────────────────────────────────
# Run weighted graph clustering against live corpus (read-only, no writes)
npx tsx scripts/cluster-experiment.ts

# With custom cosine floor threshold
npx tsx scripts/cluster-experiment.ts --floor=0.40
```

## Hard Constraints

1. **Embedding dimension is 1536**. Default output of `text-embedding-3-small`, no `dimensions` parameter. Changing after first insert requires a full table rewrite and re-embed of all notes.
2. **All AI calls via OpenRouter** at `https://openrouter.ai/api/v1`. Use the `openai` npm package with `baseURL` override.
3. **All DB access uses `SUPABASE_SERVICE_ROLE_KEY`**, never the anon key. All three Workers validate at startup that the key is a service_role JWT — using the anon key throws immediately with an actionable error.
4. **Use `<=>` operator** for cosine distance in pgvector (not `<->` which is L2). In RPC functions created via migrations, use `OPERATOR(extensions.<=>)` — PostgREST cannot resolve pgvector operators via `search_path` alone.
5. **`source` field is always set** at insert — never null.
6. **Register Telegram webhook after deploying the Worker**, not before.
7. **Model strings and behavioral thresholds are env vars**, read via `src/config.ts`. Never hardcode a model string at a call site.
8. **Return 200 to Telegram immediately**, process capture in `ctx.waitUntil()`.
9. **Always store the user's raw input** in `notes.raw_input` alongside the LLM-generated title and body.
10. **Two-pass embedding**: first embed uses raw text (for finding related notes); second embed uses `buildEmbeddingInput()` with metadata augmentation (for storage). If the second embed fails, fall back to the raw embedding — never lose the note.
11. **RPC functions must be in the `public` schema** with `set search_path = 'public, extensions'`. Functions in the `extensions` schema are not visible to PostgREST's `.rpc()` by default. Use explicit `public.table_name` references and `OPERATOR(extensions.<=>)` for pgvector operators — the connection pooler's execution context does not reliably resolve these via `search_path`.
12. **Stylistic prompt rules (title style, body rules, traceability) must come from `capture_profiles` table**, never hardcoded in source. Edit the DB row to tune capture behavior without redeploying.
13. **JSONB columns (`entities`, `metadata`) contain LLM-generated or system-generated content** — never interpolate their values into raw SQL strings.

## Corpus Re-capture Checklist

When rebuilding the corpus from `raw_input` (e.g., after schema changes that affect embeddings):

1. **Pre-flight:** Verify `SYSTEM_FRAME` in `mcp/src/capture.ts` is current
2. **Pre-flight:** Verify `capture_profiles` DB row reflects the latest voice rules — update it BEFORE the batch, not after
3. **Pre-flight:** Verify migration seed matches the live DB row (so future deploys stay in sync)
4. **Disable Telegram webhook** before schema changes
5. **Apply schema** → deploy Workers in order (MCP → Telegram → Gardener)
6. **Re-register webhook**
7. **Re-capture** in chronological order (oldest first) so `match_notes` builds the link graph progressively
8. **Trigger gardener** for similarity links
9. **Run all test suites** — smoke, integration, semantic

Script note: Python's default `urllib` user-agent gets blocked by Cloudflare bot protection (error 1010). Always set a custom `User-Agent` header when hitting CF Workers from scripts.

## Capture Logic (v4)

1. Worker receives Telegram webhook POST
2. Verify `x-telegram-bot-api-secret-token` header — return 403 if missing/wrong
3. Parse body, guard non-text messages (sticker, photo, voice, etc.) — return 200
4. Check `message.chat.id` against `ALLOWED_CHAT_IDS` whitelist — return 200 silently if not allowed
5. `/undo` check: if exact match, call `env.CAPTURE_SERVICE.undoLatest()` via Service Binding — hard-delete most recent Telegram capture in grace window, refuse otherwise. Return 200. No dedup needed (no note created).
6. Dedup check: insert `update_id` into `processed_updates` — if `23505` unique violation, return 200
7. **Return 200 to Telegram** (everything below runs in `ctx.waitUntil()`)
8. In parallel: embed raw message text, fetch capture voice from `capture_profiles`, send `typing` action
9. Call `match_notes(embedding, threshold, count=5)` for related notes
10. Call capture LLM with (system frame + capture voice) + raw message + related notes + today's date
11. Parse JSON response, validate all 6 fields with logged fallback defaults
12. Re-embed with metadata augmentation (`buildEmbeddingInput`). On failure, fall back to raw embedding and log `augmented_embed_fallback`
13. Insert note into `notes` with augmented embedding, `raw_input`, `corrections`, `embedded_at`; insert links into `links`
14. In parallel: insert two `enrichment_log` rows (capture + embedding); send HTML-formatted confirmation to Telegram
15. Telegram reply format: bold title, separator line, body, italic `tags` line, optional Linked/Corrections/Source lines. Message capped at 4096 chars.
16. On any error in steps 8–14: send generic error to Telegram, log full details to console

## Capture Agent Output Format

The LLM returns this JSON and nothing else:

```json
{
  "title": "...",
  "body": "...",
  "tags": ["...", "..."],
  "source_ref": null,
  "corrections": ["garbled → corrected"] | null,
  "links": [
    { "to_id": "<uuid>", "link_type": "contradicts|related" }
  ]
}
```

**Link types:** `contradicts` = challenges or stands in tension with a prior note; `related` = any other meaningful connection (builds on, reinforces, exemplifies, etc.).

## Schema (v4)

5 tables total:
- `notes` — core notes with entities, corrections, summary, categories, metadata, archived_at, embedding, embedded_at, content_tsv
- `links` — 3 link types: `contradicts`, `related` (capture-time), `is-similar-to` (gardening-time); includes context, confidence, created_by
- `enrichment_log` — audit trail per note per enrichment type
- `capture_profiles` — user-editable stylistic prompt rules; seeded with 'default' profile
- `processed_updates` — Telegram dedup

RPC functions in `public` schema: `match_notes` (hybrid vector + full-text, 6 params), `find_similar_pairs` (self-join cosine similarity).

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
- **Phase 2a (complete):** MCP server — separate Cloudflare Worker exposing tools over JSON-RPC 2.0. Also hosts `CaptureService` entrypoint for Service Binding RPC (PR #90, issue #46) — single capture pipeline for all gateways. Tagged `v2.0.0`.
- **Phase 2b (complete):** Gardening pipeline — nightly similarity linker. Originally included SKOS tag normalization and chunk generation, both removed in v4.0.0 (#128). Tagged `v2.5.0`.
- **Phase 2c (complete):** OAuth 2.1 for MCP server. Authorization Code + PKCE via `@cloudflare/workers-oauth-provider`, DCR enabled, `resolveExternalToken` for static token bypass, consent page protected by `CONSENT_SECRET`. Verified with Claude.ai web connector. Cursor/ChatGPT verification deferred (#102). Tagged `v3.0.0`.
- **v3.1.0 (complete):** Drop type/intent/modality from capture pipeline (#110). Clean-slate v3 schema. 10-field → 7-field → 6-field LLM contract (entities removed from capture in #113). Embedding format simplified to `[Tags: ...] text`. Corpus re-captured from raw_input.
- **v4.0.0 (complete):** Schema simplification bundle (#128, PR #131). Dropped 3 tables (concepts, note_concepts, note_chunks), 3 columns (refined_tags, maturity, importance_score), 2 RPC functions (match_chunks, batch_update_refined_tags). Link types simplified from 9 → 3 (contradicts, related, is-similar-to). MCP tools reduced from 8 → 5. Gardener simplified to similarity linking only.
- **remove_note (complete):** MCP tool for note removal with time-dependent behavior (#87, PR #140). Notes < 11 min: permanently deleted. Older: soft archive. All existing tools now filter `archived_at IS NULL`. Renamed from `archive_note` — the old name promised archival but could permanently delete.
- **Telegram /undo (complete):** `/undo` command hard-deletes most recent Telegram capture within grace window (#142, PR #143). Source-scoped (Telegram only), grace-window-only (refuses after 11 min). Bot commands registered automatically by `deploy.sh`.
- **Cluster exploration (active design phase):** Louvain community detection via Graphology. Experiment (#152) validated cosine-only as starting point — 3 coherent clusters at resolution 1.0 across 164 notes. Multi-resolution overlap model (134/164 notes change cluster across resolutions). Tags and links are an upgrade path pending quality improvements (#151, #147). Gardener-time computation, `list_clusters` MCP tool reads pre-computed results. Implementation next (#144).
- **Phase 3 (deferred):** Associative trails, location extraction.

## Deploy

Everything is automated. One command:

```bash
bash scripts/deploy.sh
```

**Prerequisite:** The Supabase project must be linked (`supabase link --project-ref <ref>`). All secrets must be in `.dev.vars`.

The script runs in order:
1. `supabase db push --linked` — applies pending migrations via the Supabase connection pooler (no direct port 5432 access required)
2. `tsc --noEmit` — typecheck all 3 Workers
3. `vitest run` — parser + gardener unit tests (local, no network)
4. `wrangler deploy -c mcp/wrangler.toml` — deploys MCP Worker (must go first — Service Binding target)
5. `wrangler deploy` — deploys Telegram Worker
6. `setMyCommands` — registers bot commands (`/start`, `/undo`) with Telegram
7. `wrangler deploy -c gardener/wrangler.toml` — deploys Gardener Worker
8. `vitest run tests/smoke.test.ts` — end-to-end smoke tests against live Worker

Use `--skip-smoke` to skip step 8 and test manually.

## Product Intent

**Core principle: low friction, aware curator.** The system makes capture easy and low-friction. The user captures idea fragments in their own voice and acts as the gatekeeper and curator. The system trusts the user is smart and capable. Guard rails and warnings are fine, but the user's editorial judgment keeps the system hygienic. Every architectural decision evaluates against this.

**The problem ContemPlace solves:** Every AI agent builds memory about you in its own proprietary garden — isolated, non-portable, and non-trivial to even extract. Switching to a new tool means starting from zero. ContemPlace inverts this: your memory lives in a database you own, any MCP-capable agent can read and write it, and your accumulated context travels with you. You stop being locked into any single agent's ecosystem.

**Emergent structure, not imposed structure.** Fragments cluster around themes over time. Some nodes gain gravitational weight — many connections, recent activity. The user can explore what's currently on their mind, trace how ideas evolved, and discover cross-domain connections. The system doesn't impose organization; organization emerges from the accumulation of linked, gardened fragments. Cluster detection (#144) uses Louvain community detection via Graphology — starting with cosine similarity only, with tag Jaccard, explicit links, and entities as incremental upgrades as signal quality improves. Flat clusters with overlap via multi-resolution (notes that change cluster across resolutions are overlap candidates). Whether narrative MOC-like synthesis is needed on top of cluster exploration is an open question (#120).

### What is ContemPlace?

A commonplace book that becomes a PKM system. You use it as you would a commonplace book — send whatever is on your mind, no processing obligation. Under the hood, the system turns your accumulation into organized, queryable knowledge through gardening (similarity links, cluster detection) and retrieval via MCP. The MCP surface makes your memory portable across any agent.

The irreducible core is the **database + MCP surface + gardening pipeline**. The Telegram bot, import tools, and a dashboard are optional input/presentation layers.

Three layers, each with a clear job:

1. **Input** — get stuff into the database. The Telegram bot for quick on-the-go capture. Any MCP-capable agent (Claude.ai via OAuth, Claude Code via static token, custom scripts) for agent-mediated capture. The `capture_note` MCP tool is the universal input gate — the Telegram bot is one client of it.
2. **Enrichment** — the gardening pipeline. Similarity links surface connections automatically. It's what turns the commonplace book into a PKM system — making the database *useful* rather than just full.
3. **Retrieval** — agents query the enriched graph via MCP. Vector search, semantic tools. This is where the value compounds. The primary access pattern is agent-driven, not human-driven.

### Input quality: capture_note is a smart gate

`capture_note` is the **write API**. There is no other supported input path. The server runs the full LLM pipeline internally — the user sends raw text, the system handles embedding, structuring, linking, and storage. Quality is guaranteed by construction: every fragment exits the pipeline with structured fields, an embedding, and preserved raw input. The gardener can work with any fragment that passed through the gate.

The system captures idea fragments — whatever the user sends, in their own voice. A fragment can be a focused thought, a rough observation, a question, a quote. Focused fragments (one claim, self-contained, voice-preserving) produce the best immediate structuring, but all fragments are valuable raw material for accumulation and synthesis. Title model: claim primary, question secondary, topic labels never. Complex inputs (brain dumps, multi-topic streams) are the user's choice to pre-process — the system captures everything faithfully. See `docs/capture-agent.md`, #116.

### Capture LLM contract

**Keeps:** title (retrieval scanning), corrections (voice/typo fixes), tags, linking. All serve retrieval or user feedback.

**Must not:** compress input, hallucinate, add inferred meanings, change input destructively, add conclusions the user didn't express. The body is transcription, not synthesis. `raw_input` is the irreplaceable source of truth.

### Trust contract

The system is a faithful mirror, not a co-author. This applies to the capture pipeline, cluster labels, and any future synthesis:
- **No contamination.** Never put inferred statements in the user's voice.
- **No garbage.** Everything in the system traces to something the user actually said.
- **Full traceability.** Every structured or synthesized statement cites source fragments.
- **Analytical, not creative.** The system organizes and connects. It doesn't generate new ideas, draw novel conclusions, or add meaning the fragments don't contain.

### Design implications

The single capture path is implemented (PR #90, issue #46): the Telegram Worker delegates to the MCP Worker via Service Binding. The MCP agent training pattern (#107) will make capture guidance queryable — agents call a training tool and learn what the system expects.

The `raw_input` column preserves the user's exact words. The structured fragment (title, body, tags, links) is the LLM's interpretation — useful for retrieval, but the raw input is the irreplaceable source of truth and must never be discarded.

Cluster exploration (#144) is next for implementation: the gardener will detect clusters via cosine-only Louvain community detection (validated by #152 experiment), storing pre-computed results for a `list_clusters` MCP tool. Multi-resolution overlap via comparing cluster membership across resolutions. Tags, links, and entities are upgrade paths as signal quality improves (#151, #147, #125). Whether narrative MOC-like synthesis (#120) is needed on top of this is an open question — cluster browsing may be sufficient. The trust contract constrains any synthesis — it must be analytical and traceable, never inferential.

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
| **`docs/usage.md`** | The experience layer: what daily use looks like — capture, retrieval, curation, gardener. The "so what" document for someone who just deployed. | When user-facing behavior changes |
| **`docs/philosophy.md`** | Product design principles: fragment-first capture, trust contract, emergent clustering, user voice. The "why" behind architectural choices. | When product principles change |
| **`docs/capture-agent.md`** | Capture pipeline behavior, linking logic, voice correction. | When capture behavior changes |
| **`CLAUDE.md`** | Stable AI context: architecture, hard constraints, key files, conventions. No current state, no issue indexes, no phase status. | When architecture or conventions change |
| **`README.md`** | Product front door: what it is, how it works, trust and control, FAQ, documentation index. No bash commands, no config tables. | When any user-visible surface changes |
| **`docs/setup.md`** | Full deploy guide: prerequisites, secrets, Worker deployment, configuration tables, env var reference. | When deploy process or config changes |
| **`docs/development.md`** | Test commands, project layout, file-by-file breakdown, contributor reference. | When tests, layout, or dev workflow changes |

### Rules

1. **Repo files describe stable facts.** Architecture, constraints, conventions. Not "what's currently open" or "what's next."
2. **GitHub is the single source of truth for status.** Phase progress → milestones. Open questions → issues. Never mirror these into a file.
3. **ADRs are immutable.** Add a new entry when a decision changes; never update old ones. The timestamp matters.
4. **When something comes up during a session** — bug, question, idea, concern — open an issue immediately, then keep going. Never defer to "I'll note that later."
5. **Documentation is part of the deliverable, not a follow-up task.** A feature is not done until the docs reflect it. Code changes without corresponding doc updates are incomplete work — the same as shipping without tests. This applies to every PR, not just phase closings.
6. **Proactive housekeeping at every organic breakpoint.** After completing a PR, merging, closing an issue, or finishing a logical chunk of work — automatically do the documentation sweep before moving on. Do not ask whether to do this. It is always expected:
   - **Start with decisions.** Ask: "What did we decide during this work?" Specialist reviews, implementation trade-offs, and user feedback all produce decisions. An ADR for the original design does not cover decisions made during implementation — those are separate entries. `docs/decisions.md` is append-only; new entries are expected and normal.
   - Update `docs/` files that describe anything touched by the change (`architecture.md`, `schema.md`, `capture-agent.md`, `roadmap.md`)
   - Update `README.md` if the status table, tool list, test count, project layout, or quick start is affected
   - Update `CLAUDE.md` if architecture, constraints, file layout, commands, or conventions changed
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


# CLAUDE.md

This file provides guidance to Claude Code when working with code in this repository.

## What This Is

ContemPlace is a modern commonplace book that auto-gardens into an MCP-connected PKM system. Capture idea fragments from Telegram or any MCP client — the system structures, embeds, and links them into a searchable knowledge graph in Postgres (pgvector). A nightly gardening pipeline surfaces similarity connections and detects topic clusters.

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

The capture flow is **async**: the Worker returns 200 to Telegram immediately, then processes in the background via `ctx.waitUntil()`.

**Single capture path:** The Telegram Worker delegates capture to the MCP Worker via a Cloudflare Service Binding (in-process RPC, no HTTP hop). The capture pipeline lives in `mcp/src/pipeline.ts` — one source of truth for all gateways.

**System frame / capture voice split:** The system prompt is split into two parts:
- **System frame** (`SYSTEM_FRAME` constant in `mcp/src/capture.ts`) — structural contract: JSON schema, field enums, link rules, voice correction instructions. Lives in code.
- **Capture voice** (stored in `capture_profiles` DB table, fetched at runtime) — title style, body rules, traceability, tone, examples. User-editable without code deployment.

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

For the full capture step-by-step, see `docs/capture-agent.md`. For architecture details, see `docs/architecture.md`.

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
    tools.ts         # Tool definitions + handlers (search_notes, get_note, list_recent, get_related, capture_note, remove_note, list_clusters)
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
    index.ts         # scheduled() + fetch() exports — orchestrates similarity linking + clustering + entity extraction
    clustering.ts    # Louvain community detection via Graphology (multi-resolution, gravity, tag labels)
    entities.ts      # Entity extraction prompt, response parsing, corpus-wide dedup/resolution
    ai.ts            # OpenRouter client for entity extraction (optional — only when OPENROUTER_API_KEY set)
    config.ts        # Config loading (thresholds, cosineFloor, clusterResolutions, entityConfig)
    db.ts            # Similarity + cluster + entity dictionary DB ops
    similarity.ts    # buildContext() — auto-generates link context from shared tags
    alert.ts         # sendAlert() — best-effort Telegram failure notification
    auth.ts          # validateTriggerAuth() — Bearer token auth for /trigger endpoint
    types.ts         # Gardener-specific TypeScript interfaces
scripts/
  deploy.sh          # Automated deploy pipeline (schema → typecheck → unit tests → MCP Worker → Telegram Worker → bot commands → Gardener Worker → smoke tests)
  cluster-experiment.ts  # Clustering experiment — weighted graph + Louvain against live corpus (read-only, run via `npx tsx`)
  threshold-analysis.ts  # Threshold analysis — pairwise distribution, gardener sweep, source stratification (read-only, run via `npx tsx`)
supabase/
  config.toml
  migrations/        # Schema migrations (v3 base + v4 simplification + clusters + entity dictionary)
tests/               # See docs/development.md for the full test file breakdown
.claude/
  settings.json         # Project-level permissions (Edit/Write/Bash on working directories — inherited by worktrees)
  commands/
    orchestrate.md      # Custom command: orchestrator mode — triage, parallel cmux workspaces + git worktrees
    analyze.md            # Custom command: extract project insights from user-provided input
    extract-fragments.md  # Custom command: topic-driven Obsidian re-capture sessions
    harvest-ideas.md      # Custom command: search corpus for actionable product ideas
    audit-captures.md     # Custom command: capture quality audit
    work-on-issue.md      # Custom command: full issue workflow — gather → review → plan → implement → verify → ship
    reflect.md            # Custom command: session-closing ritual — review pushbacks, improve commands/docs/memory
docs/                # Detailed documentation (architecture, capture agent, schema, decisions, roadmap, setup, development, philosophy, usage)
.github/
  workflows/
    backup.yml       # Automated daily Supabase backup to a private GitHub repo
wrangler.toml        # Telegram Worker Cloudflare config
package.json
tsconfig.json
```

## Environment Variables

Deployed secrets via `wrangler secret put`. Local dev and tests via `.dev.vars` (single source of truth). Full reference with generation commands: `docs/setup.md`.

Three Workers, each with their own secrets scope:
- **Telegram Worker** — `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ALLOWED_CHAT_IDS`
- **MCP Worker** (set via `-c mcp/wrangler.toml`) — `MCP_API_KEY`, `CONSENT_SECRET`, plus `OPENROUTER_API_KEY`, `SUPABASE_*` keys. Configurable thresholds in `mcp/wrangler.toml [vars]`.
- **Gardener Worker** (set via `-c gardener/wrangler.toml`) — `SUPABASE_*` keys, optional `TELEGRAM_BOT_TOKEN`, `GARDENER_API_KEY`, `OPENROUTER_API_KEY` (enables entity extraction). Configurable thresholds in `gardener/wrangler.toml [vars]`.

Threshold values and their comparison bases are documented inline in the respective `wrangler.toml` files and `config.ts` modules. Do not hardcode values in docs — always read from config.

## Key Commands

```bash
# Deploy everything (schema → typecheck → tests → all 3 Workers → smoke tests)
bash scripts/deploy.sh              # full deploy
bash scripts/deploy.sh --skip-smoke # skip smoke tests

# Typecheck
npx tsc --noEmit                           # Telegram + MCP Workers
npx tsc --noEmit -p gardener/tsconfig.json # Gardener Worker

# Unit tests (local, no network)
npx vitest run tests/parser.test.ts tests/undo.test.ts                    # Telegram Worker
npx vitest run tests/mcp-{auth,config,embed,tools,dispatch,index,oauth}.test.ts  # MCP Worker
npx vitest run tests/gardener-{similarity,config,clustering,alert,trigger,entities}.test.ts  # Gardener

# Live tests (require deployed Workers + secrets in .dev.vars)
npx vitest run tests/smoke.test.ts              # Telegram Worker
npx vitest run tests/mcp-smoke.test.ts          # MCP Worker
npx vitest run tests/semantic.test.ts           # Semantic correctness (~70s)
npx vitest run tests/gardener-integration.test.ts  # Full cycle

# Analysis scripts (read-only, no writes)
npx tsx scripts/cluster-experiment.ts
npx tsx scripts/threshold-analysis.ts
```

For the full command reference including secret setup, webhook registration, and gardener triggering, see `docs/development.md` and `docs/setup.md`.

## Hard Constraints

1. **Embedding dimension is 1536**. Default output of `text-embedding-3-small`, no `dimensions` parameter. Changing after first insert requires a full table rewrite and re-embed of all notes.
2. **All AI calls via OpenRouter** at `https://openrouter.ai/api/v1`. Use the `openai` npm package with `baseURL` override.
3. **All DB access uses `SUPABASE_SERVICE_ROLE_KEY`**, never the anon key. All three Workers validate at startup that the key is a service_role JWT.
4. **Use `<=>` operator** for cosine distance in pgvector (not `<->` which is L2). In RPC functions, use `OPERATOR(extensions.<=>)`.
5. **`source` field is always set** at insert — never null.
6. **Model strings and behavioral thresholds are env vars**, read via config modules. Never hardcode a model string or threshold at a call site.
7. **Return 200 to Telegram immediately**, process capture in `ctx.waitUntil()`.
8. **Always store the user's raw input** in `notes.raw_input` alongside the LLM-generated title and body.
9. **Two-pass embedding**: first embed uses raw text (for finding related notes); second embed uses `buildEmbeddingInput()` with metadata augmentation (for storage). If the second embed fails, fall back to the raw embedding — never lose the note.
10. **RPC functions must be in the `public` schema** with `set search_path = 'public, extensions'`. Use explicit `public.table_name` references and `OPERATOR(extensions.<=>)` for pgvector operators.
11. **Stylistic prompt rules must come from `capture_profiles` table**, never hardcoded in source.
12. **JSONB columns contain LLM-generated content** — never interpolate their values into raw SQL strings.

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

**Link types:** `contradicts` = challenges or stands in tension; `related` = any other meaningful connection. `is-similar-to` is gardener-generated only.

## Schema (v4)

7 tables: `notes`, `links`, `clusters`, `enrichment_log`, `capture_profiles`, `processed_updates`, `entity_dictionary`.
RPC functions: `match_notes` (hybrid vector + full-text), `find_similar_pairs` (self-join cosine similarity).
Full schema reference: `docs/schema.md`.

## Product Intent

**Core principle: low friction, aware curator.** The user captures idea fragments in their own voice and acts as the curator. The system trusts the user is smart and capable.

**The problem:** Every AI agent builds memory in its own proprietary garden — isolated, non-portable. ContemPlace inverts this: your memory lives in a database you own, any MCP-capable agent can read and write it.

**Three layers:** Input (`capture_note` MCP tool — the universal write API), Enrichment (gardening pipeline — similarity links + cluster detection), Retrieval (MCP search tools — where value compounds).

**Trust contract:** The system is a faithful mirror, not a co-author. No contamination (never put inferred statements in the user's voice), no garbage (everything traces to user input), full traceability, analytical not creative. See `docs/philosophy.md`.

**Capture LLM contract:** Keeps title, corrections, tags, linking. Must not compress input, hallucinate, add inferred meanings, or add conclusions the user didn't express. The body is transcription, not synthesis. `raw_input` is the irreplaceable source of truth.

## Version Control Conventions

- `main` is always stable and deployable. Feature branches: `feat/<name>`, hotfixes: `fix/<name>`, investigation: `investigate/<name>`.
- Every non-trivial change goes through a PR with a test plan checklist.
- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`.
- Semantic version tags on `main` after meaningful milestones.
- Open a GitHub Issue before starting significant work. Reference with `refs #<n>`.

## Design Principles

- **Rapid iteration.** All behavioral parameters (models, thresholds, prompts) should be changeable without code modifications where practical.
- **Specialist review before implementation.** Before writing code for a non-trivial feature, launch Plan agents to evaluate the design — surface edge cases, identify missing prerequisites, flag architectural concerns.
- **Validate against reality.** Unit tests are necessary but not sufficient. Deploy to the live stack and run end-to-end simulation before declaring done.
- **Documentation is part of the deliverable.** A feature is not done until docs reflect it. The `/work-on-issue` command encodes the full workflow including doc sweeps.

## Documentation Locations

| What | Where |
|---|---|
| Architecture, data flow, embedding strategy | `docs/architecture.md` |
| Capture pipeline behavior, linking, voice correction | `docs/capture-agent.md` |
| Schema: tables, RPC functions, indexes | `docs/schema.md` |
| Architecture Decision Records (immutable, append-only) | `docs/decisions.md` |
| What each phase delivered and what's next | `docs/roadmap.md` |
| Design principles and trust contract | `docs/philosophy.md` |
| Daily usage: capture, retrieval, curation | `docs/usage.md` |
| Full deploy guide, secrets, env var reference | `docs/setup.md` |
| Test commands, project layout, file breakdown | `docs/development.md` |

Repo files describe stable facts. GitHub Issues are the source of truth for status. ADRs are immutable — add new entries, never edit old ones.

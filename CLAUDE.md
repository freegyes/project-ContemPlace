# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

ContemPlace is a cloud-hosted personal memory system. Telegram → Cloudflare Worker → structured note in Postgres (pgvector) → confirmation back to Telegram. Phase 2 (next) adds a gardening pipeline and MCP server so AI agents can retrieve notes by semantic similarity.

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
    index.ts         # JSON-RPC 2.0 HTTP handler — routes to 5 tool handlers
    tools.ts         # Tool definitions + handlers (handleSearchNotes, handleGetNote, etc.)
    auth.ts          # Bearer token auth (validateAuth)
    config.ts        # Config loading with secret validation
    db.ts            # DB read/write functions (fetchNote, listRecentNotes, searchNotes, insertNote, …)
    embed.ts         # embedText, buildEmbeddingInput (copy of src/embed.ts)
    capture.ts       # parseCaptureResponse, runCaptureAgent (copy of src/capture.ts)
    types.ts         # MCP-specific TypeScript interfaces
scripts/
  deploy.sh          # Automated 5-step deploy pipeline
supabase/
  config.toml
  migrations/
    20260309000000_v2_schema.sql   # Current schema (v2 — full drop-and-recreate from v1)
  seed/
    seed_concepts.sql              # Initial SKOS domain concepts (run manually in SQL Editor)
tests/
  parser.test.ts         # Unit tests for src/capture.ts parseCaptureResponse (17 tests, no network)
  smoke.test.ts          # Smoke tests against the live Telegram Worker
  mcp-auth.test.ts       # Unit tests for mcp/src/auth.ts
  mcp-config.test.ts     # Unit tests for mcp/src/config.ts
  mcp-embed.test.ts      # Unit tests for mcp/src/embed.ts + parity with src/embed.ts
  mcp-parser.test.ts     # Parity tests for mcp/src/capture.ts vs src/capture.ts (17 tests)
  mcp-tools.test.ts      # Unit tests for all 5 MCP tool handlers (mocked deps, no network)
  mcp-index.test.ts      # Unit tests for MCP HTTP routing and JSON-RPC protocol
  mcp-smoke.test.ts      # Smoke tests against the live MCP Worker
docs/                # Detailed documentation (architecture, capture agent, schema, decisions, roadmap)
wrangler.toml        # Telegram Worker Cloudflare config
package.json
tsconfig.json
reviews/             # Specialist review notes from project bootstrap (do not delete)
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

# Test-only
WORKER_URL                  # deployed Telegram Worker URL, for smoke tests
TELEGRAM_CHAT_ID            # your personal chat ID, for smoke tests
MCP_WORKER_URL              # deployed MCP Worker URL, for mcp-smoke tests
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
npx vitest run tests/mcp-auth.test.ts tests/mcp-config.test.ts tests/mcp-embed.test.ts tests/mcp-parser.test.ts tests/mcp-tools.test.ts tests/mcp-index.test.ts

# Run MCP smoke tests (against live MCP Worker — requires MCP_WORKER_URL + MCP_API_KEY in .dev.vars)
npx vitest run tests/mcp-smoke.test.ts
```

## Hard Constraints

1. **Embedding dimension is 1536**. Default output of `text-embedding-3-small`, no `dimensions` parameter. Changing after first insert requires a full table rewrite and re-embed of all notes.
2. **All AI calls via OpenRouter** at `https://openrouter.ai/api/v1`. Use the `openai` npm package with `baseURL` override.
3. **All DB access uses `SUPABASE_SERVICE_ROLE_KEY`**, never the anon key.
4. **Use `<=>` operator** for cosine distance in pgvector (not `<->` which is L2).
5. **`source` field is always set** at insert — never null.
6. **Register Telegram webhook after deploying the Worker**, not before.
7. **Model strings and behavioral thresholds are env vars**, read via `src/config.ts`. Never hardcode a model string at a call site.
8. **Return 200 to Telegram immediately**, process capture in `ctx.waitUntil()`.
9. **Always store the user's raw input** in `notes.raw_input` alongside the LLM-generated title and body.
10. **Two-pass embedding**: first embed uses raw text (for finding related notes); second embed uses `buildEmbeddingInput()` with metadata augmentation (for storage). If the second embed fails, fall back to the raw embedding — never lose the note.
11. **RPC functions must be in the `public` schema** with `set search_path = 'public, extensions'`. Functions in the `extensions` schema are not visible to PostgREST's `.rpc()` by default.
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
    { "to_id": "<uuid>", "link_type": "extends|contradicts|supports|is-example-of" }
  ]
}
```

**Type rules:** `reflection` = first-person personal insight (explicit signal required); `lookup` = investigative prompt only; `source` = external URL included; `idea` = default.

**Intent rules (6 values):** `reflect` = processing experience/feeling; `plan` = future action, aspirations, wishes; `create` = specific thing to make; `remember` = storing a fact/detail; `reference` = external content (URL present or explicitly saving someone else's work); `log` = recording what happened. `remember` vs `reference`: use `remember` when no URL, `reference` when URL present. `wish` was merged into `plan`.

**Type and intent are independent facets** — a `source` note can have `plan` intent, a `reflection` can have `remember` intent.

**Link types:** `extends` = builds on/deepens; `contradicts` = challenges; `supports` = reinforces or parallel/sibling idea toward same goal; `is-example-of` = concrete instance.

**Entity extraction:** proper nouns only, explicitly in the input — not from related notes, not from training data. Use corrected name from `corrections` field if applicable.

## Schema (v2)

8 tables total:
- `notes` — core notes with 9 new v2 columns (intent, modality, entities, corrections, summary, refined_tags, categories, metadata, importance_score, maturity, archived_at, embedding, embedded_at, content_tsv)
- `links` — 8 link types (4 capture-time + 4 gardening-time); includes context, confidence, created_by
- `concepts` — SKOS controlled vocabulary (scheme, pref_label, alt_labels, definition, embedding)
- `note_concepts` — junction: notes ↔ concepts
- `note_chunks` — RAG chunks for long notes (deferred to gardening pipeline)
- `enrichment_log` — audit trail per note per enrichment type
- `capture_profiles` — user-editable stylistic prompt rules; seeded with 'default' profile
- `processed_updates` — Telegram dedup

RPC functions in `public` schema: `match_notes` (hybrid vector + full-text, 8 params), `match_chunks`.

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
- **Phase 2a (complete):** MCP server — separate Cloudflare Worker exposing 5 tools (`search_notes`, `get_note`, `list_recent`, `get_related`, `capture_note`) over JSON-RPC 2.0. Bearer token auth. 140 local unit tests, plus smoke tests against the live Worker.
- **Phase 2b (next):** Gardening pipeline — nightly similarity links, tag normalization via SKOS, chunk generation, maturity scoring. Tracked in GitHub issue #2.
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

ContemPlace is an always-on place to capture unedited thoughts and notes via low-friction communication interfaces (Telegram in Phase 1, potentially Slack, email, voice, web in the future). The user sends raw thinking without worrying about structure or formatting. The system stores it fast, structures it automatically, and never asks the user to clarify or edit.

The stored notes become a semantic context layer for downstream use. The primary use case: inviting an LLM agent (via MCP in Phase 2) to act as a creative review partner, research collaborator, or thinking companion — with access to the user's accumulated notes, retrievable by semantic similarity. The agent finds relevant context automatically. The user never has to copy-paste prior thinking into a prompt.

The capture logic (embed → find related → LLM → store) is intentionally decoupled from any specific input channel. Adding a new channel means writing a new entry point that calls the same pipeline. The `source` field records provenance.

The `raw_input` column preserves the user's exact words. The structured note (title, body, tags, links) is the LLM's interpretation — useful for retrieval, but the raw input is the irreplaceable source of truth and must never be discarded.

## Design Philosophy

The system is built for rapid iteration. All behavioral parameters (models, thresholds, prompts) should be changeable without code modifications where practical. When a change requires redeployment, it should be a one-line config change, not a code refactor. The architecture should never prevent the owner from tuning the system's behavior based on real usage.

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
- Phase 2 is tracked in issues #2 (gardening pipeline) and #3 (MCP server).
- Labels: `enhancement` for features, `bug` for bugs, `phase-2` / `phase-3` for roadmap items.

## Review Trail

Specialist reviews from project bootstrap live in `reviews/`. Read them before making architectural decisions. Key files:
- `reviews/02-security.md` — secrets management, webhook verification, RLS audit
- `reviews/03-integrations.md` — integration gotchas and failure modes
- `reviews/04-schema.md` — corrected schema with full SQL
- `reviews/05-implementation-plan.md` — sequenced build plan for Phase 1
- `reviews/06-implementation-plan-v2.md` — Phase 1.5 implementation plan (schema + enriched capture)
- `reviews/07-v2-schema.md` through `reviews/12-v2-testing.md` — specialist reviews for v2

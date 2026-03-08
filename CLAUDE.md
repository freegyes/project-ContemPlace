# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

ContemPlace is a cloud-hosted personal memory system. Telegram → Cloudflare Worker → structured note in Postgres (pgvector) → confirmation back to Telegram. Phase 2 adds an MCP server so AI agents can retrieve notes by semantic similarity.

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

Cloudflare Workers handles the Telegram webhook. Supabase is the database only — no Edge Functions in Phase 1.

The capture flow is **async**: the Worker returns 200 to Telegram immediately, then processes in the background via `ctx.waitUntil()`. This eliminates Telegram retry issues and keeps the bot responsive regardless of LLM latency.

```
Telegram → Cloudflare Worker → verify signature → check chat ID whitelist → dedup check → return 200
                                └→ ctx.waitUntil(): embed → find related → LLM → DB insert → send Telegram reply
```

## Project Layout

```
src/
  index.ts           # Worker entry point (webhook handler + async dispatch)
  config.ts          # Env var reading with defaults (all model strings and thresholds live here)
  capture.ts         # Capture agent (system prompt, LLM call, JSON parsing)
  embed.ts           # Embedding helper
  telegram.ts        # Telegram API helpers (sendMessage, sendChatAction)
  db.ts              # Supabase client + DB operations (insert note, match_notes RPC, dedup)
  types.ts           # TypeScript interfaces (Telegram, capture result, DB row types)
supabase/
  config.toml
  migrations/
    20260101000000_initial_schema.sql
tests/
  smoke.test.ts      # Smoke tests against the deployed worker
wrangler.toml        # Cloudflare Worker configuration
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

# Test-only
WORKER_URL                  # deployed worker URL, for smoke tests
TELEGRAM_CHAT_ID            # your personal chat ID, for smoke tests
```

## Key Commands

```bash
# Deploy the worker
wrangler deploy

# Set a deployed secret
wrangler secret put TELEGRAM_BOT_TOKEN

# Local dev server
wrangler dev

# Apply database migrations
supabase db push

# Run smoke tests (against deployed worker)
npx vitest run
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

## Capture Logic (single mode in v1)

1. Worker receives Telegram webhook POST
2. Verify `x-telegram-bot-api-secret-token` header — return 403 if missing/wrong
3. Parse body, guard non-text messages (sticker, photo, voice, etc.) — return 200
4. Check `message.chat.id` against `ALLOWED_CHAT_IDS` whitelist — return 200 silently if not allowed
5. Dedup check: insert `update_id` into `processed_updates` — if `23505` unique violation, return 200
6. **Return 200 to Telegram** (everything below runs in `ctx.waitUntil()`)
7. Send `typing` action to Telegram
8. Embed message text via OpenRouter
9. Call `match_notes(embedding, threshold, count=5)` for related notes
10. Call capture LLM with system prompt + raw message + related notes + today's date
11. Parse JSON response, validate fields
12. Insert note into `notes` with embedding and `raw_input`, insert links into `links`
13. Send HTML-formatted confirmation to Telegram (`parse_mode: HTML`): bold title, separator line, body, italic type·tags line, optional Linked/Corrections/Source lines
14. On any error in steps 7–13: send error message to Telegram with context, log structured JSON to console

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
  "links": [
    { "to_id": "<uuid>", "link_type": "extends|contradicts|supports|is-example-of" }
  ]
}
```

Type rules: `reflection` = first-person personal insight (explicit signal required); `lookup` = investigative prompt only; `source` = external URL included; `idea` = default.

Link types: `extends` = builds on/deepens; `contradicts` = challenges; `supports` = reinforces or parallel/sibling idea toward same goal; `is-example-of` = concrete instance.

`corrections` = voice dictation or typo fixes applied silently to the output. Logged to Cloudflare and shown in the Telegram reply when present.

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

- **Phase 1 (current):** Schema (notes, links, processed_updates), Telegram bot, Cloudflare Worker with async capture, chat ID whitelist, single capture mode, confirmation replies.
- **Phase 2 (deferred):** Assets table, MCP server, image handling, clarification loop, voice transcription, per-type capture prompts, runtime-configurable behavior.

Done when: 5 real messages from Telegram produce correctly structured notes in the database with confirmations received.

## Product Intent

ContemPlace is an always-on place to capture unedited thoughts and notes via low-friction communication interfaces (Telegram in Phase 1, potentially Slack, email, voice, web in the future). The user sends raw thinking without worrying about structure or formatting. The system stores it fast, structures it automatically, and never asks the user to clarify or edit.

The stored notes become a semantic context layer for downstream use. The primary use case: inviting an LLM agent (via MCP in Phase 2) to act as a creative review partner, research collaborator, or thinking companion — with access to the user's accumulated notes, retrievable by semantic similarity. The agent finds relevant context automatically. The user never has to copy-paste prior thinking into a prompt.

The capture logic (embed → find related → LLM → store) is intentionally decoupled from any specific input channel. Adding a new channel means writing a new entry point that calls the same pipeline. The `source` field records provenance.

The `raw_input` column preserves the user's exact words. The structured note (title, body, tags, links) is the LLM's interpretation — useful for retrieval, but the raw input is the irreplaceable source of truth and must never be discarded.

## Design Philosophy

The system is built for rapid iteration. All behavioral parameters (models, thresholds, prompts) should be changeable without code modifications where practical. When a change requires redeployment, it should be a one-line config change, not a code refactor. The architecture should never prevent the owner from tuning the system's behavior based on real usage.

## Review Trail

Specialist reviews from project bootstrap live in `reviews/`. Read them before making architectural decisions. Key files:
- `reviews/02-security.md` — secrets management, webhook verification, RLS audit
- `reviews/03-integrations.md` — integration gotchas and failure modes
- `reviews/04-schema.md` — corrected schema with full SQL
- `reviews/05-implementation-plan.md` — sequenced build plan for Phase 1

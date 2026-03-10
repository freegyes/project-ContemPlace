# ContemPlace

A personal memory system. Send raw thoughts to a Telegram bot — they come back structured, embedded, and linked to your prior thinking. No editing. No forms. Just capture.

The stored notes form a semantic context layer. The primary use: an AI agent (via MCP) that already knows your accumulated thinking, retrieves relevant notes by similarity, and acts as a creative partner without you ever copying prior work into a prompt.

**Live:** Telegram capture Worker + MCP server, both deployed to Cloudflare.

## How it works

You message the bot. The system:

1. Embeds your raw text and finds semantically related notes
2. Sends everything to an LLM that structures a note — title, body, tags, type, intent, entities — and links it to related notes
3. Stores the structured note alongside your exact raw input (never discarded)
4. Replies with a formatted confirmation showing the note, its metadata, and any linked notes

The bot returns 200 to Telegram immediately and processes everything in the background. It never times out, regardless of LLM latency.

```
You → Telegram → Cloudflare Worker → return 200
                       └→ background:
                            embed raw text + fetch capture voice (parallel)
                            → find related notes by cosine similarity
                            → LLM structures the note + links it
                            → re-embed with metadata augmentation
                            → store note + links + audit log
                            → send confirmation to Telegram
```

A second Worker exposes the note graph to AI agents over MCP (JSON-RPC 2.0). The same capture pipeline runs there synchronously — agents can both read and write notes.

## What the capture agent produces

Each note gets 10 fields from a single LLM pass:

| Field | Purpose |
|---|---|
| **title** | A claim or insight — not a topic label |
| **body** | 1–5 sentences, atomic, in the user's own voice |
| **type** | `idea` / `reflection` / `source` / `lookup` |
| **intent** | `reflect` / `plan` / `create` / `remember` / `reference` / `log` |
| **modality** | `text` / `link` / `list` / `mixed` |
| **tags** | Free-form, from the input |
| **entities** | Proper nouns with types (person, place, tool, project, concept) |
| **links** | Typed edges to related notes (`extends`, `contradicts`, `supports`, `is-example-of`) |
| **corrections** | Voice dictation fixes, applied silently and reported |
| **source_ref** | URL if one was included |

The body follows a strict traceability rule: every sentence must trace back to something you actually said. The agent cleans up grammar and filler but never fabricates information, adds conclusions, or pads for length.

Input can come from voice dictation. The agent detects and silently corrects transcription errors, cross-referencing proper nouns against existing notes. Corrections are shown in the reply.

## Stack

| Layer | Technology |
|---|---|
| Compute | Cloudflare Workers (TypeScript, V8 runtime) |
| Database | Supabase (Postgres 16 + pgvector) |
| AI gateway | OpenRouter (OpenAI-compatible SDK) |
| Embeddings | `openai/text-embedding-3-small` (1536 dimensions) |
| Capture LLM | `anthropic/claude-haiku-4-5` |
| Capture interface | Telegram bot (webhook-based) |
| Agent interface | MCP server (JSON-RPC 2.0 over HTTP) |

All models are configurable via environment variables. All AI calls route through OpenRouter.

## MCP server

The MCP Worker runs at `https://mcp-contemplace.<subdomain>.workers.dev/mcp`. It exposes five tools:

| Tool | What it does |
|---|---|
| `search_notes` | Semantic search by natural language query. Optional: `limit`, `threshold`, `filter_type`, `filter_intent`, `filter_tags`. |
| `get_note` | Fetch a single note by UUID — includes raw input, entities, and all links. |
| `list_recent` | Most recent notes, newest first. Optional: `limit`, `filter_type`, `filter_intent`. |
| `get_related` | All notes linked to a given note, both directions. |
| `capture_note` | Full capture pipeline. Pass `text` and optional `source` label. Creates a real, permanent note. |

Auth: `Authorization: Bearer <MCP_API_KEY>` header on all requests.

**Threshold note:** The default search threshold is 0.35. Stored embeddings are metadata-augmented (`[Type: idea] [Intent: plan] [Tags: …] text`), while search queries are bare natural language. A lower threshold compensates for this vector space gap. You can override per call. See `docs/decisions.md` for the full analysis.

### Connect from Claude Code

```json
{
  "mcpServers": {
    "contemplace": {
      "type": "http",
      "url": "https://mcp-contemplace.<subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer <your-MCP_API_KEY>"
      }
    }
  }
}
```

## Setup

### Prerequisites

- [Cloudflare account](https://cloudflare.com) with Workers enabled
- [Supabase project](https://supabase.com) (free tier works; pgvector enabled by default)
- [OpenRouter API key](https://openrouter.ai)
- Telegram bot token from [@BotFather](https://t.me/BotFather)
- Node.js 18+, [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/), [Supabase CLI](https://supabase.com/docs/guides/cli)

### 1. Clone and install

```bash
git clone https://github.com/freegyes/project-ContemPlace.git
cd project-ContemPlace
npm install
```

### 2. Configure local secrets

```bash
cp .dev.vars.example .dev.vars
# fill in all values — this file is gitignored
```

### 3. Link Supabase and apply the schema

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF -p YOUR_DB_PASSWORD
supabase db push --linked --yes
```

The migration creates 8 tables, RLS policies, RPC functions (`match_notes`, `match_chunks`), HNSW vector indexes, and seeds the default capture voice profile.

Run the SKOS domain concepts seed separately in the Supabase SQL editor if you want initial concept vocabulary:

```bash
# paste contents of supabase/seed/seed_concepts.sql into Supabase SQL editor
```

### 4. Deploy the Telegram capture Worker

Set secrets, then deploy:

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET   # openssl rand -hex 32
wrangler secret put OPENROUTER_API_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put ALLOWED_CHAT_IDS          # comma-separated Telegram chat IDs

bash scripts/deploy.sh    # schema + typecheck + tests + deploy + smoke tests
# or: wrangler deploy
```

### 5. Register the Telegram webhook

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://contemplace.YOUR_SUBDOMAIN.workers.dev" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  -d 'allowed_updates=["message"]'
```

Send a message to your bot to verify. You should get a structured confirmation back within ~5 seconds.

### 6. Deploy the MCP Worker

```bash
wrangler secret put MCP_API_KEY -c mcp/wrangler.toml            # openssl rand -hex 32
wrangler secret put SUPABASE_URL -c mcp/wrangler.toml
wrangler secret put SUPABASE_SERVICE_ROLE_KEY -c mcp/wrangler.toml
wrangler secret put OPENROUTER_API_KEY -c mcp/wrangler.toml

wrangler deploy -c mcp/wrangler.toml
```

Then add the MCP server to your Claude Code config as shown above.

## Configuration

### Telegram capture Worker

| Variable | Default | Description |
|---|---|---|
| `CAPTURE_MODEL` | `anthropic/claude-haiku-4-5` | LLM for note structuring |
| `EMBED_MODEL` | `openai/text-embedding-3-small` | Embedding model |
| `MATCH_THRESHOLD` | `0.60` | Cosine similarity floor for related-note lookup at capture time |

### MCP Worker

| Variable | Default | Description |
|---|---|---|
| `CAPTURE_MODEL` | `anthropic/claude-haiku-4-5` | LLM for `capture_note` tool |
| `EMBED_MODEL` | `openai/text-embedding-3-small` | Embedding model |
| `MATCH_THRESHOLD` | `0.60` | Threshold for related-note lookup inside `capture_note` |
| `MCP_SEARCH_THRESHOLD` | `0.35` | Default threshold for `search_notes` (lower to compensate for embedding space mismatch) |

Defaults live in `src/config.ts` and `mcp/src/config.ts`. Override via `wrangler.toml` vars.

## Tuning capture behavior

The LLM's title and body style rules live in the `capture_profiles` database table, not in code. Edit the `default` row to change how notes are written — no redeployment needed.

The structural contract (JSON schema, field enums, entity/link rules) lives in `SYSTEM_FRAME` in `src/capture.ts` and `mcp/src/capture.ts`. Changes there require a deploy.

## Development

```bash
# Unit tests — all local, no network
npx vitest run tests/parser.test.ts \
  tests/mcp-auth.test.ts tests/mcp-config.test.ts tests/mcp-embed.test.ts \
  tests/mcp-parser.test.ts tests/mcp-tools.test.ts tests/mcp-index.test.ts

# Typecheck
npx tsc --noEmit

# Smoke tests — hit the live workers (requires .dev.vars)
npx vitest run tests/smoke.test.ts          # Telegram Worker
npx vitest run tests/mcp-smoke.test.ts     # MCP Worker

# Local Telegram Worker dev server
wrangler dev
```

174 tests total (157 MCP unit tests, 17 parser unit tests). Smoke tests create and clean up test notes automatically.

## Project layout

```
src/              Telegram capture Worker
  index.ts        Entry point — webhook handler, async dispatch
  capture.ts      System frame, LLM call, response parser (parseCaptureResponse)
  embed.ts        Embedding client, metadata-augmented embedding builder
  db.ts           Supabase operations
  telegram.ts     Telegram API helpers
  config.ts       Environment variable parsing with defaults
  types.ts        TypeScript interfaces
mcp/              MCP Worker (JSON-RPC 2.0 over HTTP)
  src/
    index.ts      HTTP handler — routing, auth, JSON-RPC dispatch
    tools.ts      All 5 tool handlers with input validation
    auth.ts       Bearer token auth
    config.ts     Config loading with validation
    db.ts         DB read/write functions
    embed.ts      Embedding helpers (copy of src/embed.ts)
    capture.ts    Capture pipeline (copy of src/capture.ts)
    types.ts      MCP-specific TypeScript interfaces
  wrangler.toml
scripts/
  deploy.sh       Automated 5-step deploy pipeline
supabase/
  migrations/     Schema migrations (v2 is current — 8 tables)
  seed/           SKOS domain concept seeds
tests/
  parser.test.ts          Unit tests: capture response parsing (17)
  smoke.test.ts           Smoke tests: live Telegram Worker
  mcp-auth.test.ts        Unit tests: MCP auth (8)
  mcp-config.test.ts      Unit tests: MCP config loading (14)
  mcp-embed.test.ts       Unit tests: embedding + parity with src/embed.ts (8)
  mcp-parser.test.ts      Unit tests: MCP parser parity with src/capture.ts (17)
  mcp-tools.test.ts       Unit tests: all 5 tool handlers (61)
  mcp-index.test.ts       Unit tests: HTTP routing + JSON-RPC protocol (32)
  mcp-smoke.test.ts       Smoke tests: live MCP Worker
docs/             Architecture, schema, decisions, roadmap
reviews/          Specialist review notes from project bootstrap
```

## Documentation

| Document | Contents |
|---|---|
| [Architecture](docs/architecture.md) | Async capture flow, two-pass embedding, prompt structure, error handling |
| [Capture agent](docs/capture-agent.md) | Classification taxonomy, entity extraction, linking logic, voice correction |
| [Schema](docs/schema.md) | All 8 tables, RPC functions, indexes, RLS, SKOS concepts |
| [Design decisions](docs/decisions.md) | Why this stack, key tradeoffs, lessons from real usage |
| [Roadmap](docs/roadmap.md) | Phase history and what's next |
| [CLAUDE.md](CLAUDE.md) | Working instructions for Claude Code — conventions, constraints, commands |

## Status

| Phase | Status |
|---|---|
| 1 — Telegram capture | ✅ Live |
| 1.5 — Enriched capture (v2 schema, intent/entities/two-pass embedding) | ✅ Live |
| 2a — MCP server | ✅ Live |
| 2b — Gardening pipeline (nightly similarity links, SKOS normalization, chunks) | Planned |
| 2c — OAuth 2.1 for Claude.ai web connector | Planned |

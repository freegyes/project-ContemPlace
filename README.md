# ContemPlace

Your thoughts, stored in a database you own, accessible to any AI agent you choose to work with.

The core is a database and an MCP surface. That's the product — everything else is a module. Any MCP-capable agent can read from and write to your knowledge base directly. You don't need a special app. You send raw input from whatever interface suits you — a Telegram bot, Claude CLI, a custom script, anything that can call MCP. The system structures it, embeds it, links it to prior thinking, and makes it semantically searchable. A gardening pipeline runs in the background to normalize, connect, and chunk your notes so retrieval keeps getting better. Your notes become context that any agent can pull from automatically.

No proprietary format. No vendor lock-in. No VC-backed service that might change the rules. The stack is boring on purpose — widely-used, well-documented, free-tier friendly, nothing that requires infrastructure babysitting.

The system is **modular**. The database and MCP server are the irreducible core — the minimum viable product. Everything else — a Telegram bot for low-friction capture, a gardening pipeline that organizes notes in the background, a smart capture router that handles any input type, import tools, a dashboard — is an optional layer. Each module shares the same ethos: zero friction on input, agent-first retrieval, data you can always get out.

## Status

| Component | State |
|---|---|
| Telegram capture bot | ✅ Live |
| MCP server | ✅ Live — 8 tools |
| Gardening pipeline | ✅ Complete — similarity linker, tag normalization, chunk generation · [Phase 2b](https://github.com/freegyes/project-ContemPlace/milestone/1) |
| OAuth 2.1 (Claude.ai web) | 🔜 [Phase 2c](https://github.com/freegyes/project-ContemPlace/milestone/2) |
| Dashboard | 💡 Planned — [#12](https://github.com/freegyes/project-ContemPlace/issues/12) |
| Smart capture router | 💡 Design phase — input-type detection + specialized handlers · [#27](https://github.com/freegyes/project-ContemPlace/issues/27) |
| Import tools | 💡 Planned — [#13](https://github.com/freegyes/project-ContemPlace/issues/13), [#14](https://github.com/freegyes/project-ContemPlace/issues/14) |

→ [All open issues](https://github.com/freegyes/project-ContemPlace/issues) · [Roadmap](docs/roadmap.md) · [Decisions](docs/decisions.md)

## Philosophy

**Database + MCP is the product.** The irreducible core is a Postgres database with vector search and an MCP surface that any agent can talk to. The Telegram bot, the gardening pipeline, and everything else are modules you add. If you have a Claude subscription and MCP access, you can start capturing and retrieving notes with zero additional infrastructure.

**You own your data.** Notes are stored in Postgres — a format you can query, export, or migrate without asking anyone's permission. Raw input is always preserved alongside the structured note. Nothing is locked in.

**You never think about the system.** You send a thought; the system handles structure. Tags, intent classifications, entity extraction, and links between notes emerge automatically. The gardening pipeline runs in the background to refine connections over time. You set it up once and don't have to think about it. The capture layer is designed to grow smarter over time — recognizing what kind of input it received and processing it accordingly — so you never have to stress about format, routing, or administration.

**Agent-first retrieval.** The primary access pattern is semantic search via MCP — an AI agent finding relevant context from your notes automatically. Human-facing UIs are secondary. The value compounds as the database grows: the more you put in, the more useful the context layer becomes.

**Low cost, no risk.** Cloudflare Workers free tier, Supabase free tier, OpenRouter pay-per-call with small models. The capture agent runs on Claude Haiku. The whole system costs pennies per day for regular use. No infrastructure to babysit, no startup risk.

**Files-first, Obsidian-style.** Export is always possible. The data model is transparent. If you want to leave, you take your notes with you.

## Modules

The core — database + MCP server — is the only required piece. Everything else is optional.

| Module | What it does | State |
|---|---|---|
| **MCP server** | Exposes the note graph to any MCP-capable agent. Eight tools: search notes, search chunks, retrieve, browse, get related, capture, list unmatched tags, promote concept. | ✅ Live |
| **Telegram capture bot** | Zero-friction note capture. Message the bot in any format — voice, text, link — and get a structured note back. | ✅ Live |
| **Gardening pipeline** | Nightly background enrichment: similarity links, SKOS tag normalization, chunk generation. Runs at 02:00 UTC, also triggerable via POST /trigger. | ✅ Complete |
| **Dashboard** | Browser-based view of your notes — search, browse, follow links, see the graph. | 💡 Planned |
| **Obsidian import** | Pull an existing Obsidian vault into the database — making years of prior notes semantically accessible. | 💡 Planned |
| **ChatGPT memory import** | Import your ChatGPT memory export — rescuing accumulated context from a proprietary format. | 💡 Planned |
| **Smart capture router** | Automatic input-type detection: short notes, URLs, brain dumps, lists each get specialized processing. The user never thinks about routing. | 💡 Design phase |

## How capture works

You send a message. In the background:

1. The raw text is embedded and checked for semantically related notes
2. An LLM structures the note — title, body, tags, type, intent, entities — and links it to related notes
3. The structured note is stored alongside your exact raw input (never discarded)
4. A formatted confirmation is sent back showing the note, its metadata, and any links made

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

The same pipeline runs inside the MCP `capture_note` tool — synchronously, with a source tag. Any interface that can call the pipeline can capture notes.

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

The body follows a strict traceability rule: every sentence must trace back to something you actually said. The agent transcribes, not interprets — no added conclusions, no padding, no fabrication.

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

The MCP Worker exposes eight tools:

| Tool | What it does |
|---|---|
| `search_notes` | Search notes by meaning. Returns ranked results with body text. Optional: `limit`, `threshold`, `filter_type`, `filter_intent`, `filter_tags`. |
| `search_chunks` | Search within paragraphs of long notes (body > 1500 chars). Optional: `limit`, `threshold`. |
| `get_note` | Fetch a single note by UUID — body, raw_input (source of truth), entities, links, corrections. |
| `list_recent` | Most recent notes, newest first. Optional: `limit`, `filter_type`, `filter_intent`. |
| `get_related` | Linked notes in both directions with link type glossary (extends, contradicts, supports, is-example-of, is-similar-to). |
| `capture_note` | Pass the user's raw words — the server runs the full capture pipeline. Do not pre-structure or summarize. |
| `list_unmatched_tags` | Tags without SKOS concept matches, with frequency. Part of the curation workflow. |
| `promote_concept` | Add a concept to the SKOS vocabulary. Confirm with the user first; include alt_labels for synonym collapse. |

Auth: `Authorization: Bearer <MCP_API_KEY>` header on all requests. Tool descriptions include guidance for connecting agents — pass raw user input to `capture_note`, don't pre-structure or summarize.

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

The migration creates 8 tables, RLS policies, RPC functions (`match_notes`, `match_chunks`, `batch_update_refined_tags`, `find_similar_pairs`), HNSW vector indexes, and seeds the default capture voice profile.

Run the SKOS domain concepts seed separately in the Supabase SQL editor if you want initial concept vocabulary:

```bash
# paste contents of supabase/seed/seed_concepts.sql into Supabase SQL editor
```

### 4. Deploy the Telegram capture Worker

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

### 7. Deploy the Gardener Worker

```bash
wrangler secret put SUPABASE_URL -c gardener/wrangler.toml
wrangler secret put SUPABASE_SERVICE_ROLE_KEY -c gardener/wrangler.toml
wrangler secret put TELEGRAM_BOT_TOKEN -c gardener/wrangler.toml        # optional — failure alerts
wrangler secret put TELEGRAM_ALERT_CHAT_ID -c gardener/wrangler.toml    # optional — failure alerts
wrangler secret put GARDENER_API_KEY -c gardener/wrangler.toml          # optional — enables POST /trigger

wrangler deploy -c gardener/wrangler.toml
```

The gardener runs nightly at 02:00 UTC via cron trigger. You can also trigger it manually via `POST /trigger` with Bearer auth if `GARDENER_API_KEY` is set.

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

### Gardener Worker

| Variable | Default | Description |
|---|---|---|
| `GARDENER_SIMILARITY_THRESHOLD` | `0.70` | Cosine similarity floor for `is-similar-to` links (augmented-vs-augmented comparison) |
| `GARDENER_TAG_MATCH_THRESHOLD` | `0.55` | Cosine similarity floor for tag → concept matching |

Defaults live in `src/config.ts`, `mcp/src/config.ts`, and `gardener/src/config.ts`. Override via `wrangler.toml` vars.

## Tuning capture behavior

The LLM's title and body style rules live in the `capture_profiles` database table, not in code. Edit the `default` row to change how notes are written — no redeployment needed.

The structural contract (JSON schema, field enums, entity/link rules) lives in `SYSTEM_FRAME` in `src/capture.ts` and `mcp/src/capture.ts`. Changes there require a deploy.

## Development

```bash
# Unit tests — all local, no network
npx vitest run tests/parser.test.ts \
  tests/mcp-auth.test.ts tests/mcp-config.test.ts tests/mcp-embed.test.ts \
  tests/mcp-parser.test.ts tests/mcp-tools.test.ts tests/mcp-index.test.ts \
  tests/gardener-similarity.test.ts tests/gardener-normalize.test.ts \
  tests/gardener-embed.test.ts tests/gardener-config.test.ts \
  tests/gardener-alert.test.ts tests/gardener-trigger.test.ts \
  tests/gardener-chunk.test.ts

# Typecheck
npx tsc --noEmit

# Smoke tests — hit the live workers (requires .dev.vars)
npx vitest run tests/smoke.test.ts          # Telegram Worker
npx vitest run tests/mcp-smoke.test.ts     # MCP Worker

# Integration tests — hit the live stack (requires .dev.vars)
npx vitest run tests/gardener-integration.test.ts

# Local Telegram Worker dev server
wrangler dev
```

~391 tests total across unit, integration, and smoke suites. Smoke and integration tests create and clean up test notes automatically.

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
    tools.ts      All 8 tool handlers with input validation
    auth.ts       Bearer token auth
    config.ts     Config loading with validation
    db.ts         DB read/write functions
    embed.ts      Embedding helpers (copy of src/embed.ts)
    capture.ts    Capture pipeline (copy of src/capture.ts)
    types.ts      MCP-specific TypeScript interfaces
  wrangler.toml
gardener/         Gardener Worker (nightly enrichment pipeline)
  src/
    index.ts      Cron-triggered entry point — orchestrates 3 phases
    chunk.ts      Note chunking logic (splitIntoChunks, buildChunkEmbeddingInput)
    normalize.ts  Tag matching: lexicalMatch, semanticMatch, resolveNoteTags
    similarity.ts Link context builder (shared tags, entities)
    db.ts         Supabase operations (tag norm, similarity, chunking)
    embed.ts      Embedding helpers (batchEmbedTexts)
    alert.ts      Best-effort Telegram failure notification
    auth.ts       Bearer token auth for /trigger endpoint
    config.ts     Config loading with threshold validation
    types.ts      TypeScript interfaces
  wrangler.toml
scripts/
  deploy.sh       Automated 6-step deploy pipeline
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
  mcp-tools.test.ts       Unit tests: all 8 tool handlers (93)
  mcp-index.test.ts       Unit tests: HTTP routing + JSON-RPC protocol (35)
  mcp-smoke.test.ts       Smoke tests: live MCP Worker
  gardener-similarity.test.ts  Unit tests: buildContext + UUID dedup (13)
  gardener-normalize.test.ts   Unit tests: tag matching logic (23)
  gardener-embed.test.ts       Unit tests: embedding parity (3)
  gardener-config.test.ts      Unit tests: gardener config loading (12)
  gardener-alert.test.ts       Unit tests: Telegram failure alerting (10)
  gardener-trigger.test.ts     Unit tests: /trigger endpoint auth + routing (13)
  gardener-chunk.test.ts       Unit tests: note chunking logic (16)
  gardener-integration.test.ts Integration test: capture → gardener → get_related (6)
  semantic.test.ts             Semantic correctness: tagging, linking, search quality (45)
docs/             Architecture, schema, decisions, roadmap
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

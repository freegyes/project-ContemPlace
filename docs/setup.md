# Setup guide

Full step-by-step instructions for deploying ContemPlace. Pick the modules you need — the MCP Worker is the only required piece.

## Prerequisites

- [Cloudflare account](https://cloudflare.com) with Workers enabled
- [Supabase project](https://supabase.com) (free tier works; pgvector enabled by default)
- [OpenRouter API key](https://openrouter.ai)
- Node.js 18+, [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/), [Supabase CLI](https://supabase.com/docs/guides/cli)
- Telegram bot token from [@BotFather](https://t.me/BotFather) (only if deploying the Telegram Worker)

## 1. Clone and install

```bash
git clone https://github.com/freegyes/project-ContemPlace.git
cd project-ContemPlace
npm install
```

## 2. Database setup

### Configure local secrets

```bash
cp .dev.vars.example .dev.vars
# fill in all values — this file is gitignored and is the single source of truth for local dev and tests
```

### Link Supabase and apply the schema

```bash
supabase login
supabase link --project-ref YOUR_PROJECT_REF -p YOUR_DB_PASSWORD
supabase db push --linked --yes
```

The migrations create 5 tables, RLS policies, RPC functions (`match_notes`, `find_similar_pairs`), HNSW vector indexes, and seed the default capture voice profile.

## 3. Deploy the Telegram capture Worker

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET   # generate: openssl rand -hex 32
wrangler secret put OPENROUTER_API_KEY
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put ALLOWED_CHAT_IDS          # comma-separated Telegram chat IDs
```

Deploy:

```bash
bash scripts/deploy.sh    # schema + typecheck + unit tests + deploy + smoke tests
# or just: wrangler deploy
```

### Register the Telegram webhook

After deploying:

```bash
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  -d "url=https://contemplace.YOUR_SUBDOMAIN.workers.dev" \
  -d "secret_token=${TELEGRAM_WEBHOOK_SECRET}" \
  -d 'allowed_updates=["message"]'
```

Verify: `curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo"`

Send a message to your bot to verify. You should get a structured confirmation back within ~5 seconds.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `CAPTURE_MODEL` | `anthropic/claude-haiku-4-5` | LLM for note structuring |
| `EMBED_MODEL` | `openai/text-embedding-3-small` | Embedding model |
| `MATCH_THRESHOLD` | `0.60` | Cosine similarity floor for related-note lookup at capture time |

Defaults live in `src/config.ts`. Override via `wrangler.toml` `[vars]`.

## 4. Deploy the MCP Worker

```bash
wrangler secret put MCP_API_KEY -c mcp/wrangler.toml            # generate: openssl rand -hex 32
wrangler secret put CONSENT_SECRET -c mcp/wrangler.toml         # generate: openssl rand -hex 16
wrangler secret put SUPABASE_URL -c mcp/wrangler.toml
wrangler secret put SUPABASE_SERVICE_ROLE_KEY -c mcp/wrangler.toml
wrangler secret put OPENROUTER_API_KEY -c mcp/wrangler.toml

wrangler deploy -c mcp/wrangler.toml
```

### Connect from Claude.ai web

Add a remote MCP server in Claude.ai settings. Enter the URL — OAuth handles the rest:

```
https://mcp-contemplace.<subdomain>.workers.dev/mcp
```

### Connect from Claude Code CLI

Add to your MCP config (`.claude/settings.json` or project-level):

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

### Auth

Two paths, both permanent:

- **OAuth 2.1** — Authorization Code + PKCE for browser-based clients (Claude.ai web, ChatGPT, Cursor). Dynamic Client Registration — no manual credentials needed.
- **Static Bearer token** — `Authorization: Bearer <MCP_API_KEY>` for API/SDK callers (Claude Code CLI, Anthropic API, OpenAI Responses API).

### Configuration

| Variable | Default | Description |
|---|---|---|
| `CAPTURE_MODEL` | `anthropic/claude-haiku-4-5` | LLM for `capture_note` tool |
| `EMBED_MODEL` | `openai/text-embedding-3-small` | Embedding model |
| `MATCH_THRESHOLD` | `0.60` | Threshold for related-note lookup inside `capture_note` |
| `MCP_SEARCH_THRESHOLD` | `0.35` | Default threshold for `search_notes` (lower to compensate for embedding space mismatch) |

Defaults live in `mcp/src/config.ts`. Override via `mcp/wrangler.toml` `[vars]`.

**Threshold note:** The default search threshold is 0.35. Stored embeddings are metadata-augmented (`[Tags: ...] text`), while search queries are bare natural language. A lower threshold compensates for this vector space gap. You can override per call. See [decisions.md](decisions.md) for the full analysis.

## 5. Deploy the Gardener Worker

```bash
wrangler secret put SUPABASE_URL -c gardener/wrangler.toml
wrangler secret put SUPABASE_SERVICE_ROLE_KEY -c gardener/wrangler.toml
wrangler secret put TELEGRAM_BOT_TOKEN -c gardener/wrangler.toml        # optional — failure alerts
wrangler secret put TELEGRAM_ALERT_CHAT_ID -c gardener/wrangler.toml    # optional — failure alerts
wrangler secret put GARDENER_API_KEY -c gardener/wrangler.toml          # optional — enables POST /trigger

wrangler deploy -c gardener/wrangler.toml
```

The gardener runs nightly at 02:00 UTC via cron trigger. You can also trigger it manually:

```bash
curl -X POST "https://contemplace-gardener.YOUR_SUBDOMAIN.workers.dev/trigger" \
  -H "Authorization: Bearer <GARDENER_API_KEY>"
```

### Configuration

| Variable | Default | Description |
|---|---|---|
| `GARDENER_SIMILARITY_THRESHOLD` | `0.70` | Cosine similarity floor for `is-similar-to` links (augmented-vs-augmented) |

Defaults live in `gardener/src/config.ts`. Override via `gardener/wrangler.toml` `[vars]`.

## Tuning capture behavior

The LLM's title and body style rules live in the `capture_profiles` database table, not in code. Edit the `default` row to change how notes are written — no redeployment needed.

The structural contract (JSON schema, field enums, link rules) lives in `SYSTEM_FRAME` in `mcp/src/capture.ts`. Changes there require a deploy.

## Environment variables reference

```
# Required — no defaults
TELEGRAM_BOT_TOKEN          # from BotFather
TELEGRAM_WEBHOOK_SECRET     # openssl rand -hex 32
OPENROUTER_API_KEY          # from openrouter.ai
SUPABASE_URL                # from Supabase dashboard → Project Settings → API
SUPABASE_SERVICE_ROLE_KEY   # from Supabase dashboard → Project Settings → API
ALLOWED_CHAT_IDS            # comma-separated Telegram chat IDs

# MCP Worker secrets
MCP_API_KEY                 # openssl rand -hex 32
CONSENT_SECRET              # openssl rand -hex 16

# Gardener Worker secrets (optional)
TELEGRAM_BOT_TOKEN          # same as capture Worker — enables failure alerts
TELEGRAM_ALERT_CHAT_ID      # chat ID to receive failure alerts
GARDENER_API_KEY            # enables POST /trigger endpoint

# Test-only
WORKER_URL                  # deployed Telegram Worker URL, for smoke tests
TELEGRAM_CHAT_ID            # your personal chat ID, for smoke tests
MCP_WORKER_URL              # deployed MCP Worker URL, for mcp-smoke tests
GARDENER_WORKER_URL         # deployed Gardener Worker URL, for gardener-integration tests
```

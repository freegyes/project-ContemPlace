# Setup guide

*Everything you need to go from zero to a running ContemPlace instance. If you're deploying for the first time, start here.*

The system has three Workers — the MCP Worker and Gardener are the core, the Telegram bot adds mobile capture.

Run all commands from the repository root unless stated otherwise.

## Prerequisites

- [Cloudflare account](https://cloudflare.com) with Workers enabled (free tier is fine)
- [Supabase project](https://supabase.com) (free tier works; pgvector enabled by default)
- [OpenRouter account](https://openrouter.ai) with API key and credits (typical usage: $2–3/month)
- Node.js 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) — `npm install -g wrangler`
- [Supabase CLI](https://supabase.com/docs/guides/cli) — `brew install supabase/tap/supabase` (macOS) or [other methods](https://supabase.com/docs/guides/cli/getting-started#installing-the-supabase-cli)
- Telegram bot token from [@BotFather](https://t.me/BotFather) (only if deploying the Telegram Worker)

## 1. Clone and install

```bash
git clone https://github.com/freegyes/project-ContemPlace.git
cd project-ContemPlace
npm install
```

## 2. Authenticate CLIs

```bash
wrangler login          # opens browser → authorize with your Cloudflare account
supabase login          # opens browser → authorize with your Supabase account
```

## 3. Configure secrets

Two places store secrets, for different purposes:

| Where | What it's for | How values get there |
|---|---|---|
| **`.dev.vars`** | Local development, tests, and the `deploy.sh` script | You edit the file |
| **`wrangler secret put`** | Production — Cloudflare's encrypted store | Interactive prompt (paste the value when asked) |

You need both. Every secret goes in `.dev.vars` *and* gets pushed via `wrangler secret put`. Start by creating `.dev.vars`:

```bash
cp .dev.vars.example .dev.vars
```

Fill in the values as you go through the steps below. The `.dev.vars.example` file lists every variable with placeholder values and comments explaining where each one comes from.

**Note on `wrangler secret put`:** Each command is interactive — it prints `Enter a secret value:` and waits for you to paste. It does not accept the value as a command-line argument. Each Worker has its own secret scope: use `-c mcp/wrangler.toml` for the MCP Worker, `-c gardener/wrangler.toml` for the Gardener. No flag = the Telegram Worker.

## 4. Database setup

Find these in the Supabase dashboard:
- **Project ref** — Project Settings → General (it's the string in your project URL: `https://<project-ref>.supabase.co`)
- **Database password** — the one you set when creating the Supabase project
- **`SUPABASE_URL`** — Project Settings → API → Project URL
- **`SUPABASE_SERVICE_ROLE_KEY`** — same page → `service_role` key (not the `anon` key)

Save `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in `.dev.vars` now — every Worker needs them.

```bash
supabase link --project-ref YOUR_PROJECT_REF -p YOUR_DB_PASSWORD
supabase db push --linked --yes
```

The migrations create 7 tables, RLS policies, RPC functions (`match_notes`, `find_similar_pairs`), HNSW vector indexes, and seed the default capture voice profile.

## 5. Deploy the MCP Worker

The MCP Worker is the core — it hosts the capture pipeline, search tools, and auth. The Telegram Worker depends on it via a Service Binding (capture), and it depends on the Gardener Worker via a second Service Binding (on-demand gardening). Deploy order: Gardener → MCP → Telegram.

### Create the KV namespace

The MCP Worker uses Cloudflare KV (a key-value store) for OAuth token storage. Create it:

```bash
wrangler kv namespace create OAUTH_KV -c mcp/wrangler.toml
```

Output looks like:

```
🌀 Creating namespace with title "mcp-contemplace-OAUTH_KV"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
{ binding = "OAUTH_KV", id = "abc123def456..." }
```

Copy the `id` value. Open `mcp/wrangler.toml` and replace `YOUR_KV_NAMESPACE_ID` with it. Then create the preview namespace:

```bash
wrangler kv namespace create OAUTH_KV --preview -c mcp/wrangler.toml
```

Same thing — copy the `id` from the output and replace `YOUR_KV_PREVIEW_ID` in `mcp/wrangler.toml`.

Since these IDs are account-specific, your edit will show as a git diff. To suppress it: `git update-index --skip-worktree mcp/wrangler.toml`

### Generate and save secrets

Generate two secrets and save them in `.dev.vars`:

```bash
openssl rand -hex 32   # → save as MCP_API_KEY in .dev.vars (your static Bearer token for API access)
openssl rand -hex 16   # → save as CONSENT_SECRET in .dev.vars (passphrase for the OAuth consent page)
```

Also save your `OPENROUTER_API_KEY` in `.dev.vars` if you haven't already.

### Push secrets to Cloudflare and deploy

```bash
wrangler secret put MCP_API_KEY -c mcp/wrangler.toml
wrangler secret put CONSENT_SECRET -c mcp/wrangler.toml
wrangler secret put SUPABASE_URL -c mcp/wrangler.toml
wrangler secret put SUPABASE_SERVICE_ROLE_KEY -c mcp/wrangler.toml
wrangler secret put OPENROUTER_API_KEY -c mcp/wrangler.toml

wrangler deploy -c mcp/wrangler.toml
```

Wrangler prints the deployed URL after a successful deploy — something like `https://mcp-contemplace.your-subdomain.workers.dev`. Note it down; you'll need it for verification and client configuration.

### Verify the deploy

The MCP Worker requires authentication — opening the URL in a browser will return an error. That's expected. Verify with curl using your `MCP_API_KEY`:

```bash
curl -s https://mcp-contemplace.YOUR_SUBDOMAIN.workers.dev/mcp \
  -H "Authorization: Bearer YOUR_MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

Replace `YOUR_SUBDOMAIN` with your Cloudflare subdomain (from the deploy output) and `YOUR_MCP_API_KEY` with the key you generated.

A successful response looks like:

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","serverInfo":{"name":"contemplace-mcp","version":"1.0.0"},"capabilities":{"tools":{}}}}
```

If you see `"Unauthorized"` or `"Forbidden"`: the `MCP_API_KEY` you pushed via `wrangler secret put` doesn't match the token in the curl command. Regenerate, push again, and retry.

### Connect from Claude.ai web

Add a remote MCP server in Claude.ai settings → Integrations. Enter the URL — OAuth handles the rest automatically:

```
https://mcp-contemplace.<subdomain>.workers.dev/mcp
```

### Connect from Claude Code CLI

Add to your MCP config (`~/.claude/settings.json` or project-level `.claude/settings.json`):

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

- **OAuth 2.1** — Authorization Code + PKCE for browser-based clients (Claude.ai web, ChatGPT, Cursor). Dynamic Client Registration — no manual credentials needed. The consent page asks for a passphrase — this is your `CONSENT_SECRET`.
- **Static Bearer token** — the `MCP_API_KEY` you generated earlier. Send it as `Authorization: Bearer <MCP_API_KEY>` for API/SDK callers (Claude Code CLI, Anthropic API, OpenAI Responses API). It never expires.

### Configuration

| Variable | Description |
|---|---|
| `CAPTURE_MODEL` | LLM for `capture_note` tool |
| `EMBED_MODEL` | Embedding model |
| `MATCH_THRESHOLD` | Capture-time related-note lookup threshold (raw query vs. augmented store) |
| `MCP_SEARCH_THRESHOLD` | Default threshold for `search_notes` (bare NL query vs. augmented store) |
| `HARD_DELETE_WINDOW_MINUTES` | Grace window for `remove_note` — notes younger than this are permanently deleted, older notes are soft-archived |
| `RECENT_FRAGMENTS_COUNT` | Max recent fragments shown to capture LLM as temporal context (default 5, 0 to disable) |
| `RECENT_FRAGMENTS_WINDOW_MINUTES` | Time window for recent fragments — captures older than this are excluded (default 60, 0 to disable) |

Deployed values in `mcp/wrangler.toml` `[vars]`. Code defaults in `mcp/src/config.ts`. The toml values take precedence.

**Threshold note:** Stored embeddings are metadata-augmented (`[Tags: ...] text`), while search queries are bare natural language. The search threshold compensates for this vector space gap. You can override per call. See [decisions.md](decisions.md) for the full analysis.

## 6. Deploy the Telegram capture Worker (optional)

The Telegram Worker is a thin webhook adapter — it delegates capture to the MCP Worker via a Service Binding. It only needs Telegram and Supabase (for dedup) secrets. AI model config lives on the MCP Worker.

**Important:** The MCP Worker (step 5) must be deployed first. The Telegram Worker binds to it at deploy time.

### Generate secrets

```bash
openssl rand -hex 32   # → save as TELEGRAM_WEBHOOK_SECRET in .dev.vars
```

Get your Telegram bot token from [@BotFather](https://t.me/BotFather) and save it as `TELEGRAM_BOT_TOKEN` in `.dev.vars`.

### Push secrets to Cloudflare and deploy

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put ALLOWED_CHAT_IDS          # comma-separated Telegram chat IDs

wrangler deploy
```

**Finding your chat ID:** Send any message to your bot first. Then open `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates` in a browser. Look for `"chat":{"id":123456789}` — that number is your chat ID.

Note the deployed URL from the Wrangler output (e.g. `https://contemplace.your-subdomain.workers.dev`).

### Register the Telegram webhook

The webhook tells Telegram where to send messages. Replace the two values below with your bot token and the URL from the deploy output:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -d "url=https://contemplace.<YOUR_SUBDOMAIN>.workers.dev" \
  -d "secret_token=<YOUR_TELEGRAM_WEBHOOK_SECRET>" \
  -d 'allowed_updates=["message"]'
```

Verify the webhook is set:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

The `url` field in the response should match your Worker URL.

### Verify

Send a text message to your bot. You should get a structured confirmation back within ~5 seconds — a bold title, body text, tags, and optional linked/corrections lines.

## 7. Deploy the Gardener Worker

The gardener runs nightly at 02:00 UTC, creating similarity links between notes and detecting thematic clusters via Louvain community detection. It's what turns the database from a note store into a connected knowledge graph.

```bash
wrangler secret put SUPABASE_URL -c gardener/wrangler.toml
wrangler secret put SUPABASE_SERVICE_ROLE_KEY -c gardener/wrangler.toml

# Optional — enables entity extraction (proper noun tracking):
wrangler secret put OPENROUTER_API_KEY -c gardener/wrangler.toml

# Optional — enables Telegram alerts on failure:
wrangler secret put TELEGRAM_BOT_TOKEN -c gardener/wrangler.toml
wrangler secret put TELEGRAM_ALERT_CHAT_ID -c gardener/wrangler.toml

# Optional — enables POST /trigger for manual runs:
wrangler secret put GARDENER_API_KEY -c gardener/wrangler.toml

wrangler deploy -c gardener/wrangler.toml
```

### Verify

Trigger a manual run (requires `GARDENER_API_KEY`):

```bash
curl -X POST "https://contemplace-gardener.<YOUR_SUBDOMAIN>.workers.dev/trigger" \
  -H "Authorization: Bearer <YOUR_GARDENER_API_KEY>"
```

### Configuration

| Variable | Description |
|---|---|
| `GARDENER_SIMILARITY_THRESHOLD` | Cosine similarity gate for `is-similar-to` links (augmented-vs-augmented) |
| `GARDENER_COSINE_FLOOR` | Minimum similarity for the all-pairs query — gates both linking candidates and graph construction for clustering |
| `GARDENER_CLUSTER_RESOLUTIONS` | Comma-separated Louvain resolution values (e.g. `1.0,1.5,2.0`). Higher = more granular clusters |
| `GARDENER_ENTITY_MODEL` | LLM model for entity extraction (default `anthropic/claude-haiku-4-5`). Only used when `OPENROUTER_API_KEY` is set. |
| `GARDENER_ENTITY_BATCH_SIZE` | Max notes to extract entities from per gardener run (default `15`, `0` = unlimited). Constrained by CF Workers' 50-subrequest-per-invocation limit. |

Deployed values in `gardener/wrangler.toml` `[vars]`. Code defaults in `gardener/src/config.ts`. Entity extraction is entirely optional — without `OPENROUTER_API_KEY`, the gardener runs similarity linking and clustering only.

## 8. Configure automated backups (optional)

A GitHub Actions workflow dumps the full database daily — schema, data, and roles — to a private GitHub repository you control. Git history in that repo provides natural retention with zero maintenance.

### Create the backup repository

Create a **private** GitHub repository for backups (e.g., `yourname/contemplace-backups`). It can be empty — the workflow creates the initial commit.

### Find your database connection string

In the Supabase dashboard: Project Settings → Database → Connection string → **Session mode** (port 5432).

The format looks like:

```
postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres
```

Use session mode (port 5432), not transaction mode (port 6543). `pg_dump` requires a session-capable connection.

### Create a Personal Access Token

The workflow needs push access to the backup repo. Create a [fine-grained Personal Access Token](https://github.com/settings/personal-access-tokens/new):

- **Repository access:** Only the backup repository
- **Permissions:** Contents → Read and write

### Set secrets and variables

In this repository's Settings → Secrets and variables → Actions:

| Type | Name | Value |
|---|---|---|
| Secret | `SUPABASE_DB_URL` | The connection string from above |
| Secret | `BACKUP_PAT` | The Personal Access Token |
| Variable | `BACKUP_REPO` | `owner/repo` of the backup repository (e.g., `yourname/contemplace-backups`) |

Optional — for Telegram failure alerts:

| Type | Name | Value |
|---|---|---|
| Secret | `TELEGRAM_BOT_TOKEN` | Same bot token as the capture Worker |
| Secret | `TELEGRAM_ALERT_CHAT_ID` | Chat ID to receive failure alerts |

### Verify

Trigger the workflow manually:

```bash
gh workflow run backup.yml
```

Watch the run:

```bash
gh run watch
```

Check the backup repository — you should see three files: `roles.sql`, `schema.sql`, `data.sql`.

### Restore from backup

On a fresh Supabase project (or the same one after a disaster):

```bash
psql $DB_URL -c "CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions"
psql $DB_URL -f roles.sql    # errors on managed Supabase — safe to ignore (roles already exist)
psql $DB_URL -f schema.sql
psql $DB_URL -f data.sql
```

The `roles.sql` step will show errors on managed Supabase — that's expected, the roles already exist. Schema and data restore cleanly.

Verify: note count matches, `match_notes` and `find_similar_pairs` RPCs work, embeddings are queryable, `capture_profiles` seed data is present.

### Customization

- **Schedule:** Edit the cron expression in `.github/workflows/backup.yml` (default: daily at 04:00 UTC).
- **Storage target:** The workflow pushes to a GitHub repo by default. To use R2, S3, or another destination, replace the "Push to backup repository" step.
- **Retention:** Git history handles deduplication — identical dumps produce no new commit. At current scale (~1.4MB per dump), unlimited history is fine.

## Subsequent deploys

After the first-time setup, you don't need to repeat the secret and KV steps. Use `deploy.sh` for all future deploys — it handles schema migration, typechecking, unit tests, and deploying all three Workers in the correct order:

```bash
bash scripts/deploy.sh              # full deploy with smoke tests
bash scripts/deploy.sh --skip-smoke # skip end-to-end smoke tests
```

The script reads secrets from `.dev.vars` and deploys Workers in dependency order (MCP → Telegram → Gardener). It will fail early if KV namespace IDs in `mcp/wrangler.toml` are still placeholders.

## Tuning capture behavior

The LLM's title and body style rules live in the `capture_profiles` database table, not in code. Edit the `default` row to change how notes are written — no redeployment needed.

The structural contract (JSON schema, field enums, link rules) lives in `SYSTEM_FRAME` in `mcp/src/capture.ts`. Changes there require a deploy.

## Troubleshooting

### Viewing Worker logs

All Workers emit structured JSON logs. Two ways to see them:

- **Real-time streaming** — `wrangler tail` for the Telegram Worker, `wrangler tail -c mcp/wrangler.toml` for the MCP Worker, `wrangler tail -c gardener/wrangler.toml` for the Gardener. Shows logs as requests come in. Useful for debugging a specific request.
- **Persistent logs** — in the Cloudflare dashboard, go to Workers & Pages → select the Worker → Logs. Enable "Workers Logs" to store logs for later inspection. Useful when you're not watching in real time.

Start here when something isn't working — the logs usually tell you exactly what failed.

### "Unauthorized" or "invalid or missing token" when hitting the MCP Worker URL

The MCP Worker requires authentication on every request. You cannot test it by opening the URL in a browser — that will always fail. Use the curl command from step 5 with your `MCP_API_KEY`, or connect via Claude.ai (OAuth) or Claude Code CLI (static token).

If curl with the correct token still fails: the `MCP_API_KEY` you pushed via `wrangler secret put` doesn't match the token you're sending. Run `wrangler secret put MCP_API_KEY -c mcp/wrangler.toml` again with the correct value.

### Telegram bot doesn't respond

Check in order:
1. **Is the webhook registered?** Run `getWebhookInfo` (see step 6). The `url` field should match your Worker URL.
2. **Is the MCP Worker deployed?** The Telegram Worker delegates to it via Service Binding. If the MCP Worker is down, capture silently fails.
3. **Is your chat ID whitelisted?** Check `ALLOWED_CHAT_IDS`. Messages from non-whitelisted chats are silently ignored.
4. **Check Worker logs:** `wrangler tail` shows real-time logs from the Telegram Worker.

### `wrangler deploy` fails with KV namespace error

The KV namespace ID in `mcp/wrangler.toml` is account-specific. If you cloned the repo, you need to create your own namespace — see step 5 "Create the KV namespace."

### Writes fail or search always returns empty results

Most likely you're using the **anon key** instead of the **service role key** for `SUPABASE_SERVICE_ROLE_KEY`. The anon key looks similar (both start with `eyJ...`) but has no write access due to RLS.

Verify which key you have:

```bash
echo "$SUPABASE_SERVICE_ROLE_KEY" | cut -d. -f2 | base64 -d 2>/dev/null
```

You should see `"role":"service_role"`. If you see `"role":"anon"`, go to the Supabase dashboard → Project Settings → API → scroll to `service_role` → click **Reveal** → copy that key instead.

The Workers also validate this at startup — if you deploy with the wrong key, the Worker logs will show: `SUPABASE_SERVICE_ROLE_KEY has role "anon" — expected "service_role"`.

### `wrangler secret put` or `wrangler deploy` fails with auth error

Run `wrangler login` to re-authenticate with Cloudflare.

### Schema migration fails

Make sure the Supabase project is linked: `supabase link --project-ref YOUR_REF`. The deploy script uses `supabase db push --linked` which connects via the management API — no direct database port access required.

## Environment variables reference

```
# Telegram Worker — required, no defaults
TELEGRAM_BOT_TOKEN          # from BotFather
TELEGRAM_WEBHOOK_SECRET     # openssl rand -hex 32
SUPABASE_URL                # from Supabase dashboard → Project Settings → API (for dedup only)
SUPABASE_SERVICE_ROLE_KEY   # from Supabase dashboard → Project Settings → API (for dedup only)
ALLOWED_CHAT_IDS            # comma-separated Telegram chat IDs
R2_PUBLIC_URL               # public URL of the R2 bucket (e.g., https://pub-<hash>.r2.dev) — set in wrangler.toml [vars]

# MCP Worker secrets — required
OPENROUTER_API_KEY          # from openrouter.ai
MCP_API_KEY                 # openssl rand -hex 32
CONSENT_SECRET              # openssl rand -hex 16
SUPABASE_URL                # from Supabase dashboard → Project Settings → API
SUPABASE_SERVICE_ROLE_KEY   # from Supabase dashboard → Project Settings → API

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

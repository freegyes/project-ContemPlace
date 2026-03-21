# Setup guide

## What you're getting into

ContemPlace is a personal knowledge management system. You capture idea fragments (from Telegram, Claude, or any MCP client), and the system structures, embeds, and links them into a searchable knowledge graph.

Before you start:

- **What you'll deploy:** A Postgres database, one or more Cloudflare Workers, and an AI gateway. The core gives you capture and search via any MCP client. Optional modules add Telegram capture, nightly enrichment, a visual dashboard, and automated backups.
- **Time:** 20 minutes for the core. 45-60 minutes for the full stack.
- **Cost:** All infrastructure runs on free tiers. The only cost is OpenRouter LLM calls — roughly $2-3/month with active daily use.
- **Skills needed:** Copy-paste terminal commands, navigate web dashboards, edit one config file.
- **Maintenance:** Near zero. The gardener runs nightly on a cron. Backups run automatically if enabled. No servers to manage.

Run all commands from the repository root unless stated otherwise.

## Architecture: what you're deploying

The system is modular. The core is required. Everything else is opt-in.

### Core (required)

The minimum viable system. Gives you capture, search, and retrieval via any MCP client (Claude Code, Claude.ai, Cursor, etc.).

- **Supabase database** — Postgres 16 with pgvector for semantic search
- **MCP Worker** — the brain. Runs the capture pipeline, embedding, search, and all 8 MCP tools. Deployed on Cloudflare Workers.
- **OpenRouter account** — AI gateway for LLM calls (capture) and embeddings

### Module: Telegram Bot

Mobile capture via Telegram. Send a text or photo to your bot, get a structured knowledge fragment back.

- **Telegram Worker** — thin webhook adapter. Delegates all capture logic to the MCP Worker via a Cloudflare Service Binding.
- **R2 bucket** — stores photo attachments. Optional even within this module (text capture works without it).
- Requires: Core deployed first. The Telegram Worker binds to the MCP Worker at deploy time.

### Module: Gardener

Overnight enrichment. Finds similarity connections between your notes and detects thematic clusters.

- **Gardener Worker** — runs similarity linking, Louvain community detection, and optional entity extraction.
- Runs on cron (2:00 AM UTC) or on-demand via the `trigger_gardening` MCP tool.
- Requires: Core deployed. The MCP Worker handles the Gardener's absence gracefully — capture and search work fine without it.

### Module: Visual Dashboard

Browse your knowledge base in a web UI. Stats, cluster graphs, recent captures with image thumbnails.

- **Dashboard API Worker** — read-only JSON API, standalone (no Service Bindings).
- **Dashboard Pages** — static SPA on Cloudflare Pages. Cytoscape.js force-directed cluster graphs.
- Requires: Core deployed. Cluster panels will be empty without the Gardener, but everything else works.

### Module: Automated Backup

Daily database dump to a private GitHub repository. Git history provides natural retention.

- **GitHub Actions workflow** — connects to Supabase directly. No Cloudflare dependency.
- Requires: GitHub account, Supabase connection string.

## Prerequisites

Sign up for these before starting. All have free tiers.

1. **Cloudflare account** — [cloudflare.com](https://cloudflare.com). Workers, KV, R2, and Pages are all free tier.

2. **Supabase account** — [supabase.com](https://supabase.com). Create a new project. Save the database password — you'll need it once for linking.

3. **OpenRouter account** — [openrouter.ai](https://openrouter.ai). Sign up, add $5 credit, generate an API key.

4. **Node.js 18+** — [nodejs.org](https://nodejs.org). Check with `node --version`.

5. **Wrangler CLI** (Cloudflare's deploy tool):
   ```bash
   npm install -g wrangler
   ```

6. **Supabase CLI:**
   ```bash
   brew install supabase/tap/supabase    # macOS
   ```
   Other platforms: [supabase.com/docs/guides/cli](https://supabase.com/docs/guides/cli/getting-started#installing-the-supabase-cli)

7. **(If Telegram module)** A Telegram account. Create a bot via [@BotFather](https://t.me/BotFather) — send `/newbot`, follow the prompts, save the token.

8. **(If Backup module)** A GitHub account. You'll create a private repository for backup storage.

## Step 1: Clone and install

```bash
git clone https://github.com/freegyes/project-ContemPlace.git
cd project-ContemPlace
npm install
```

## Step 2: Authenticate CLIs

```bash
wrangler login          # opens browser — authorize with your Cloudflare account
supabase login          # opens browser — authorize with your Supabase account
```

**What you should see:** Both commands open a browser tab and print a success message after you authorize.

## Step 3: Set up the database

Find these in the Supabase dashboard:

- **Project ref** — Project Settings → General. It's the string in your project URL: `https://<project-ref>.supabase.co`.
- **Database password** — the one you chose when creating the project.

Link and push:

```bash
supabase link --project-ref YOUR_PROJECT_REF -p YOUR_DB_PASSWORD
supabase db push --linked --yes
```

**What you should see:** The migration output lists tables being created. When it finishes, you have 7 tables (`notes`, `links`, `clusters`, `enrichment_log`, `capture_profiles`, `processed_updates`, `entity_dictionary`), 2 RPC functions (`match_notes`, `find_similar_pairs`), vector indexes, and a seeded capture voice profile.

**If the migration fails** with a vector-related error: enable pgvector in the Supabase dashboard (Database → Extensions → search "vector" → enable it). Then run `supabase db push --linked --yes` again.

## Step 4: Create your secrets file

```bash
cp .dev.vars.example .dev.vars
```

Open `.dev.vars` in your editor. You'll fill it in as you go through the steps below. This file serves two purposes: local development/testing, and feeding values to the deploy script. It is gitignored and never committed.

### Supabase keys

Find both at Project Settings → API in the Supabase dashboard:

| Variable | Where to find it |
|---|---|
| `SUPABASE_URL` | Project Settings → API → Project URL. Looks like `https://abcdefg.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page → `service_role` → click **Reveal**. Starts with `eyJ...` |

**Use the `service_role` key, not the `anon` key.** Both start with `eyJ` but the anon key has no write access. All four Workers validate the key at startup and will show a clear error if you use the wrong one.

### OpenRouter key

| Variable | Where to find it |
|---|---|
| `OPENROUTER_API_KEY` | [openrouter.ai/keys](https://openrouter.ai/keys) → Create Key. Starts with `sk-or-v1-...` |

### Self-generated keys

Generate these yourself. Each one is a random secret — never share them.

```bash
openssl rand -hex 32    # → MCP_API_KEY (static Bearer token for MCP API access)
openssl rand -hex 16    # → CONSENT_SECRET (passphrase for the OAuth consent page)
openssl rand -hex 32    # → GARDENER_API_KEY (if deploying Gardener module)
openssl rand -hex 32    # → TELEGRAM_WEBHOOK_SECRET (if deploying Telegram module)
openssl rand -hex 32    # → DASHBOARD_API_KEY (if deploying Dashboard module)
```

Run each command, copy the output, paste it as the value in `.dev.vars`.

### Telegram variables (if deploying Telegram module)

| Variable | Where to find it |
|---|---|
| `TELEGRAM_BOT_TOKEN` | The token BotFather gave you when you created the bot |
| `ALLOWED_CHAT_IDS` | Your Telegram chat ID — see below |

**Finding your chat ID:** Send any message to your bot. Then open this URL in a browser (replace the token):

```
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates
```

Look for `"chat":{"id":123456789}`. That number is your chat ID. Multiple IDs are comma-separated: `123456789,987654321`.

### Dashboard variables (if deploying Dashboard module)

| Variable | Value |
|---|---|
| `DASHBOARD_API_KEY` | The key you generated above |
| `DASHBOARD_API_URL` | You'll fill this in after deploying the Dashboard API Worker (step 6) |
| `DASHBOARD_WORKER_URL` | Same URL — used by smoke tests |

### Test-only variables

These are only needed for running smoke tests after deploy. Fill them in after you know the deployed URLs:

| Variable | What it is |
|---|---|
| `WORKER_URL` | Deployed Telegram Worker URL |
| `TELEGRAM_CHAT_ID` | Your Telegram chat ID (same as in `ALLOWED_CHAT_IDS`) |
| `MCP_WORKER_URL` | Deployed MCP Worker URL |
| `GARDENER_WORKER_URL` | Deployed Gardener Worker URL |
| `DASHBOARD_WORKER_URL` | Deployed Dashboard API Worker URL |

## Step 5: Configure Cloudflare resources

### KV namespace (required for MCP Worker)

The MCP Worker uses Cloudflare KV for OAuth token storage. Create it:

```bash
wrangler kv namespace create OAUTH_KV -c mcp/wrangler.toml
```

**What you should see:**

```
Creating namespace with title "mcp-contemplace-OAUTH_KV"
Success!
Add the following to your configuration file in your kv_namespaces array:
{ binding = "OAUTH_KV", id = "abc123def456..." }
```

Copy the `id` value. Now create the preview namespace:

```bash
wrangler kv namespace create OAUTH_KV --preview -c mcp/wrangler.toml
```

Same output — copy that `id` too.

Open `mcp/wrangler.toml` and replace the placeholder KV namespace IDs with yours:

```toml
[[kv_namespaces]]
binding = "OAUTH_KV"
id = "your-production-kv-id-here"
preview_id = "your-preview-kv-id-here"
```

Since these IDs are account-specific, your edit will show as a git diff. Suppress it:

```bash
git update-index --skip-worktree mcp/wrangler.toml
```

### R2 bucket (if deploying Telegram module with photo support)

Create the bucket:

```bash
wrangler r2 bucket create contemplace-images
```

Enable public access in the Cloudflare dashboard: R2 → `contemplace-images` → Settings → Public access → Allow access.

**What you should see:** A public URL like `https://pub-<hash>.r2.dev`.

Open `wrangler.toml` (root — the Telegram Worker's config) and update the `R2_PUBLIC_URL`:

```toml
[vars]
R2_PUBLIC_URL = "https://pub-<your-hash>.r2.dev"
```

### Dashboard API config (if deploying Dashboard module)

Open `dashboard-api/wrangler.toml` and update two values:

```toml
[vars]
CORS_ORIGIN = "https://contemplace-dashboard.pages.dev"   # ← your Pages URL (update after first deploy if different)
BACKUP_REPO = "yourname/contemplace-backups"               # ← your backup repo, or leave empty if not using backups
```

The `CORS_ORIGIN` must exactly match the URL where your dashboard Pages app is hosted. After your first Pages deploy, Cloudflare will tell you the URL. Come back and update this if it differs.

## Step 6: Push secrets and deploy

Every secret goes to Cloudflare's encrypted store via `wrangler secret put`. Each command is interactive — it prints `Enter a secret value:` and waits for you to paste. Press Enter after pasting.

Each Worker has its own secret scope. The `-c` flag tells Wrangler which Worker to target:

| Worker | Flag |
|---|---|
| Telegram Worker | (no flag — uses root `wrangler.toml`) |
| MCP Worker | `-c mcp/wrangler.toml` |
| Gardener Worker | `-c gardener/wrangler.toml` |
| Dashboard API Worker | `-c dashboard-api/wrangler.toml` |

### Option A: Deploy everything with the script

The deploy script handles schema migration, typechecking, unit tests, and deploying all Workers + Pages in the correct order. It reads secrets from `.dev.vars`.

But you still need to push secrets to Cloudflare first. The script deploys code — it does not push secrets.

Push all secrets (run each line, paste the value when prompted):

```bash
# MCP Worker (deploy this first — other Workers depend on it)
wrangler secret put MCP_API_KEY -c mcp/wrangler.toml
wrangler secret put CONSENT_SECRET -c mcp/wrangler.toml
wrangler secret put OPENROUTER_API_KEY -c mcp/wrangler.toml
wrangler secret put SUPABASE_URL -c mcp/wrangler.toml
wrangler secret put SUPABASE_SERVICE_ROLE_KEY -c mcp/wrangler.toml

# Telegram Worker
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_WEBHOOK_SECRET
wrangler secret put SUPABASE_URL
wrangler secret put SUPABASE_SERVICE_ROLE_KEY
wrangler secret put ALLOWED_CHAT_IDS

# Gardener Worker
wrangler secret put SUPABASE_URL -c gardener/wrangler.toml
wrangler secret put SUPABASE_SERVICE_ROLE_KEY -c gardener/wrangler.toml
wrangler secret put GARDENER_API_KEY -c gardener/wrangler.toml
# Optional — entity extraction:
wrangler secret put OPENROUTER_API_KEY -c gardener/wrangler.toml
# Optional — Telegram failure alerts:
wrangler secret put TELEGRAM_BOT_TOKEN -c gardener/wrangler.toml
wrangler secret put TELEGRAM_ALERT_CHAT_ID -c gardener/wrangler.toml

# Dashboard API Worker
wrangler secret put DASHBOARD_API_KEY -c dashboard-api/wrangler.toml
wrangler secret put SUPABASE_URL -c dashboard-api/wrangler.toml
wrangler secret put SUPABASE_SERVICE_ROLE_KEY -c dashboard-api/wrangler.toml
# Optional — backup freshness metric:
wrangler secret put GITHUB_BACKUP_PAT -c dashboard-api/wrangler.toml
```

Skip the sections for modules you're not deploying. Then run:

```bash
bash scripts/deploy.sh
```

The script deploys in this order: schema migration → typecheck → unit tests → MCP Worker → Telegram Worker → Gardener Worker → Dashboard API Worker → Dashboard Pages → smoke tests.

Add `--skip-smoke` to skip the end-to-end smoke tests:

```bash
bash scripts/deploy.sh --skip-smoke
```

**What you should see:** Each step prints a checkmark. The script exits with "Deploy complete."

After the script finishes, note the deployed URLs from the output. Fill them into `.dev.vars` for the test-only variables.

### Option B: Deploy step by step

If you want to understand each piece, or only deploy some modules.

#### Deploy the MCP Worker (core — do this first)

Push secrets (same as Option A, MCP section above), then:

```bash
wrangler deploy -c mcp/wrangler.toml
```

**What you should see:** Wrangler prints the deployed URL — something like `https://mcp-contemplace.your-subdomain.workers.dev`.

Verify:

```bash
curl -s https://mcp-contemplace.YOUR_SUBDOMAIN.workers.dev/mcp \
  -H "Authorization: Bearer YOUR_MCP_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize"}'
```

**What you should see:**

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","serverInfo":{"name":"contemplace-mcp","version":"1.0.0"},"capabilities":{"tools":{}}}}
```

If you see `"Unauthorized"`: the `MCP_API_KEY` you pushed doesn't match the one in the curl command.

#### Deploy the Telegram Worker

Push secrets (same as Option A, Telegram section above), then:

```bash
wrangler deploy
```

Register the webhook — replace the three placeholders:

```bash
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -d "url=https://contemplace.<YOUR_SUBDOMAIN>.workers.dev" \
  -d "secret_token=<YOUR_TELEGRAM_WEBHOOK_SECRET>" \
  -d 'allowed_updates=["message"]'
```

Register bot commands:

```bash
curl -s -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setMyCommands" \
  -H "Content-Type: application/json" \
  -d '{"commands": [{"command": "start", "description": "Start the bot"}, {"command": "undo", "description": "Undo the most recent capture"}]}'
```

Verify the webhook:

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

**What you should see:** The `url` field matches your Worker URL.

Send a text message to your bot. You should get a structured confirmation back within 5 seconds — a bold title, body text, tags, and optional linked/corrections lines.

#### Deploy the Gardener Worker

Push secrets (same as Option A, Gardener section above), then:

```bash
wrangler deploy -c gardener/wrangler.toml
```

Verify with a manual trigger (requires `GARDENER_API_KEY`):

```bash
curl -X POST "https://contemplace-gardener.<YOUR_SUBDOMAIN>.workers.dev/trigger" \
  -H "Authorization: Bearer <YOUR_GARDENER_API_KEY>"
```

**What you should see:** A JSON response with similarity linking and clustering results. If your corpus is small (< 5 notes), it may report zero links — that's normal.

#### Deploy the Dashboard API Worker and Pages

Push secrets (same as Option A, Dashboard section above), then:

```bash
wrangler deploy -c dashboard-api/wrangler.toml
```

Note the deployed URL (e.g., `https://contemplace-dashboard-api.your-subdomain.workers.dev`). Save it as `DASHBOARD_API_URL` in `.dev.vars`.

Create the Pages project:

```bash
wrangler pages project create contemplace-dashboard
```

Generate `config.js` and deploy:

```bash
echo "window.CONTEMPLACE_API_URL = \"https://contemplace-dashboard-api.YOUR_SUBDOMAIN.workers.dev\";" > dashboard/config.js
wrangler pages deploy dashboard/ --project-name contemplace-dashboard --branch main
```

`dashboard/config.js` is gitignored — it's generated at deploy time.

**What you should see:** Wrangler prints the Pages URL. Open it in a browser. The dashboard prompts for the `DASHBOARD_API_KEY`. Paste it — it persists in localStorage.

## Step 7: Connect MCP clients

### Claude Code CLI

Add to `~/.claude/settings.json` (or your project-level `.claude/settings.json`):

```json
{
  "mcpServers": {
    "contemplace": {
      "type": "http",
      "url": "https://mcp-contemplace.<your-subdomain>.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer <your-MCP_API_KEY>"
      }
    }
  }
}
```

### Claude.ai web

Add a remote MCP server in Claude.ai: Settings → Integrations → Add integration. Enter the URL:

```
https://mcp-contemplace.<your-subdomain>.workers.dev/mcp
```

OAuth handles the rest. When the consent page asks for a passphrase, enter your `CONSENT_SECRET`.

### Other MCP clients (Cursor, ChatGPT, Anthropic API, OpenAI Responses API)

OAuth 2.1 (Authorization Code + PKCE) for browser-based clients. Static Bearer token for API/SDK callers. Both auth paths work permanently.

## Step 8: Set up automated backups (optional)

This module is independent of Cloudflare. A GitHub Actions workflow dumps the database daily to a private repo.

### Create the backup repository

Create a **private** GitHub repository (e.g., `yourname/contemplace-backups`). It can be empty.

### Get the database connection string

In the Supabase dashboard: Project Settings → Database → Connection string → **Session mode** (port 5432).

The format:

```
postgresql://postgres.[project-ref]:[password]@aws-0-[region].pooler.supabase.com:5432/postgres
```

**Use session mode (port 5432), not transaction mode (port 6543).** `pg_dump` requires a session-capable connection.

### Create a Personal Access Token

The workflow needs push access to the backup repo. Create a [fine-grained PAT](https://github.com/settings/personal-access-tokens/new):

- **Repository access:** Only the backup repository
- **Permissions:** Contents → Read and write

### Set GitHub Actions secrets

In this repository's Settings → Secrets and variables → Actions:

| Type | Name | Value |
|---|---|---|
| Secret | `SUPABASE_DB_URL` | The connection string from above |
| Secret | `BACKUP_PAT` | The Personal Access Token |
| Variable | `BACKUP_REPO` | `owner/repo` format (e.g., `yourname/contemplace-backups`) |

Optional — Telegram failure alerts:

| Type | Name | Value |
|---|---|---|
| Secret | `TELEGRAM_BOT_TOKEN` | Same bot token as the capture Worker |
| Secret | `TELEGRAM_ALERT_CHAT_ID` | Chat ID to receive failure alerts |

### Verify

```bash
gh workflow run backup.yml
gh run watch
```

**What you should see:** The workflow completes. Check the backup repository — you should see three files: `roles.sql`, `schema.sql`, `data.sql`.

### Restore from backup

On a fresh Supabase project (or the same one after a disaster):

```bash
psql $DB_URL -c "CREATE EXTENSION IF NOT EXISTS vector SCHEMA extensions"
psql $DB_URL -f roles.sql    # errors on managed Supabase — safe to ignore (roles already exist)
psql $DB_URL -f schema.sql
psql $DB_URL -f data.sql
```

## Subsequent deploys

After the first-time setup, you don't repeat secrets or KV steps. Use the deploy script:

```bash
bash scripts/deploy.sh              # full deploy with smoke tests
bash scripts/deploy.sh --skip-smoke # skip end-to-end tests
```

The script reads from `.dev.vars`, deploys in dependency order, and generates `dashboard/config.js` automatically.

## Tuning capture behavior

The LLM's title and body style rules live in the `capture_profiles` database table, not in code. Edit the `default` row to change how notes are written — no redeployment needed.

The structural contract (JSON schema, field enums, link rules) lives in `SYSTEM_FRAME` in `mcp/src/capture.ts`. Changes there require a deploy.

## Troubleshooting

### Viewing Worker logs

All Workers emit structured JSON logs. Two ways to see them:

- **Real-time:** `wrangler tail` (no flag = Telegram Worker), `wrangler tail -c mcp/wrangler.toml` (MCP), `wrangler tail -c gardener/wrangler.toml` (Gardener), `wrangler tail -c dashboard-api/wrangler.toml` (Dashboard API).
- **Persistent:** Cloudflare dashboard → Workers & Pages → select Worker → Logs.

Start here when something isn't working.

### Wrong Supabase key type

**Symptom:** Writes silently fail, searches return empty results.

**Cause:** You're using the `anon` key instead of the `service_role` key. Both start with `eyJ...`.

**Check:**

```bash
echo "YOUR_KEY_HERE" | cut -d. -f2 | base64 -d 2>/dev/null
```

You should see `"role":"service_role"`. If you see `"role":"anon"`, go to the Supabase dashboard → Project Settings → API → scroll to `service_role` → click **Reveal** → use that key instead.

The Workers also catch this at startup and log: `SUPABASE_SERVICE_ROLE_KEY has role "anon" — expected "service_role"`.

### KV namespace ID mismatch

**Symptom:** MCP Worker deploy fails, or OAuth flow doesn't work after deploy.

**Cause:** The KV namespace IDs in `mcp/wrangler.toml` are from a different Cloudflare account.

**Fix:** Create your own KV namespaces (Step 5) and replace the IDs in the file.

### pgvector extension not enabled

**Symptom:** Schema migration fails with a vector-related error.

**Fix:** Enable pgvector in the Supabase dashboard: Database → Extensions → search "vector" → enable. Re-run the migration.

### Telegram bot doesn't respond

Check in order:

1. **Webhook registered?** Run `curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"`. The `url` field should match your Worker URL.
2. **MCP Worker deployed?** The Telegram Worker delegates to it via Service Binding. If the MCP Worker isn't deployed, capture silently fails. Deploy order: MCP first, Telegram second.
3. **Chat ID whitelisted?** Messages from non-whitelisted chat IDs are silently ignored. Check `ALLOWED_CHAT_IDS`.
4. **Check logs:** `wrangler tail` shows real-time Telegram Worker logs.

### Photos captured but images don't load

**Symptom:** Notes are created with `image_url` set, but the URL returns an error.

**Cause:** The R2 bucket doesn't have public access enabled, or `R2_PUBLIC_URL` in `wrangler.toml` doesn't match the actual bucket URL.

**Fix:** Enable public access in Cloudflare dashboard: R2 → `contemplace-images` → Settings → Public access. Copy the public URL and update `R2_PUBLIC_URL` in `wrangler.toml`.

### Dashboard loads but panels show errors

**Symptom:** The dashboard SPA opens, but data panels fail with network errors.

**Cause:** `CORS_ORIGIN` in `dashboard-api/wrangler.toml` doesn't match the Pages URL.

**Fix:** Update `CORS_ORIGIN` to exactly match your dashboard's URL (e.g., `https://contemplace-dashboard.pages.dev`). Redeploy the Dashboard API Worker.

### Dashboard shows blank screen

**Symptom:** Nothing renders at all.

**Cause:** `dashboard/config.js` is missing. The deploy script generates it, but manual deploys skip this step.

**Fix:** Create it manually:

```bash
echo "window.CONTEMPLACE_API_URL = \"https://contemplace-dashboard-api.YOUR_SUBDOMAIN.workers.dev\";" > dashboard/config.js
wrangler pages deploy dashboard/ --project-name contemplace-dashboard --branch main
```

### Service Binding target not deployed

**Symptom:** Telegram messages get "Something went wrong." The Telegram Worker logs show a Service Binding error.

**Cause:** The MCP Worker wasn't deployed before the Telegram Worker.

**Fix:** Deploy the MCP Worker first: `wrangler deploy -c mcp/wrangler.toml`. Then redeploy the Telegram Worker: `wrangler deploy`.

### `wrangler secret put` or `wrangler deploy` fails with auth error

Run `wrangler login` to re-authenticate with Cloudflare.

### Schema migration fails

Make sure the Supabase project is linked:

```bash
supabase link --project-ref YOUR_REF -p YOUR_DB_PASSWORD
```

Then retry `supabase db push --linked --yes`.

## Environment variable reference

### MCP Worker

Set secrets with: `wrangler secret put <NAME> -c mcp/wrangler.toml`

| Variable | Required | Source | Description |
|---|---|---|---|
| `MCP_API_KEY` | Yes | `openssl rand -hex 32` | Static Bearer token for API access |
| `CONSENT_SECRET` | Yes | `openssl rand -hex 16` | Passphrase for OAuth consent page |
| `OPENROUTER_API_KEY` | Yes | [openrouter.ai/keys](https://openrouter.ai/keys) | AI gateway for LLM + embeddings |
| `SUPABASE_URL` | Yes | Supabase dashboard → Project Settings → API | Database URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Same page → `service_role` (click Reveal) | Database access key |

Configuration vars (set in `mcp/wrangler.toml` `[vars]`, defaults in `mcp/src/config.ts`):

| Variable | Default | Description |
|---|---|---|
| `CAPTURE_MODEL` | `anthropic/claude-haiku-4-5` | LLM for capture |
| `EMBED_MODEL` | `openai/text-embedding-3-small` | Embedding model (1536 dimensions) |
| `MATCH_THRESHOLD` | `0.35` | Capture-time related-note threshold |
| `MCP_SEARCH_THRESHOLD` | `0.35` | Default search threshold |
| `HARD_DELETE_WINDOW_MINUTES` | `11` | Grace window for hard delete vs. soft archive |
| `RECENT_FRAGMENTS_COUNT` | `5` | Max recent fragments shown to capture LLM |
| `RECENT_FRAGMENTS_WINDOW_MINUTES` | `60` | Time window for recent fragments |
| `GARDENING_COOLDOWN_MINUTES` | `5` | Minimum wait between trigger_gardening calls |

### Telegram Worker

Set secrets with: `wrangler secret put <NAME>` (no `-c` flag)

| Variable | Required | Source | Description |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | Yes | [@BotFather](https://t.me/BotFather) | Bot API token |
| `TELEGRAM_WEBHOOK_SECRET` | Yes | `openssl rand -hex 32` | Webhook signature verification |
| `SUPABASE_URL` | Yes | Supabase dashboard | For dedup checks |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase dashboard | For dedup checks |
| `ALLOWED_CHAT_IDS` | Yes | Telegram API (`getUpdates`) | Comma-separated numeric chat IDs |

Configuration var (set in `wrangler.toml` `[vars]`):

| Variable | Description |
|---|---|
| `R2_PUBLIC_URL` | Public URL of the R2 bucket for photo storage |

### Gardener Worker

Set secrets with: `wrangler secret put <NAME> -c gardener/wrangler.toml`

| Variable | Required | Source | Description |
|---|---|---|---|
| `SUPABASE_URL` | Yes | Supabase dashboard | Database URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase dashboard | Database access key |
| `GARDENER_API_KEY` | No | `openssl rand -hex 32` | Enables POST /trigger endpoint |
| `OPENROUTER_API_KEY` | No | [openrouter.ai/keys](https://openrouter.ai/keys) | Enables entity extraction |
| `TELEGRAM_BOT_TOKEN` | No | BotFather | Enables failure alerts |
| `TELEGRAM_ALERT_CHAT_ID` | No | Telegram API | Chat ID for failure alerts |

Configuration vars (set in `gardener/wrangler.toml` `[vars]`, defaults in `gardener/src/config.ts`):

| Variable | Default | Description |
|---|---|---|
| `GARDENER_SIMILARITY_THRESHOLD` | `0.65` | Cosine gate for `is-similar-to` links |
| `GARDENER_COSINE_FLOOR` | `0.40` | Minimum similarity for all-pairs query |
| `GARDENER_CLUSTER_RESOLUTIONS` | `1.0,1.5,2.0` | Louvain resolutions (higher = more granular) |
| `GARDENER_ENTITY_MODEL` | `anthropic/claude-haiku-4-5` | LLM for entity extraction |
| `GARDENER_ENTITY_BATCH_SIZE` | `15` | Max notes per extraction run (0 = unlimited) |

### Dashboard API Worker

Set secrets with: `wrangler secret put <NAME> -c dashboard-api/wrangler.toml`

| Variable | Required | Source | Description |
|---|---|---|---|
| `SUPABASE_URL` | Yes | Supabase dashboard | Database URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Yes | Supabase dashboard | Database access key |
| `DASHBOARD_API_KEY` | Yes | `openssl rand -hex 32` | Bearer token for dashboard auth |
| `GITHUB_BACKUP_PAT` | No | [GitHub PAT settings](https://github.com/settings/personal-access-tokens/new) | Enables backup freshness in /stats |

Configuration vars (set in `dashboard-api/wrangler.toml` `[vars]`):

| Variable | Description |
|---|---|
| `CORS_ORIGIN` | Allowed origin for CORS (must match your Pages URL exactly) |
| `BACKUP_REPO` | `owner/repo` of backup repository (for freshness check) |

### `.dev.vars`-only variables (not pushed to Cloudflare)

| Variable | Description |
|---|---|
| `SUPABASE_DB_PASSWORD` | Only for `supabase link` |
| `DASHBOARD_API_URL` | Dashboard API Worker URL — deploy.sh injects it into `config.js` |
| `WORKER_URL` | Telegram Worker URL (smoke tests) |
| `TELEGRAM_CHAT_ID` | Your chat ID (smoke tests) |
| `MCP_WORKER_URL` | MCP Worker URL (smoke tests) |
| `GARDENER_WORKER_URL` | Gardener Worker URL (integration tests) |
| `DASHBOARD_WORKER_URL` | Dashboard API Worker URL (dashboard smoke tests) |

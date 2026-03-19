# Development

*Test commands, project layout, file-by-file breakdown — contributor and developer reference. Start here if you want to run tests or understand the codebase structure.*

## Tests

Unit, integration, smoke, and semantic test suites.

### Unit tests (local, no network)

```bash
# All unit tests at once
npx vitest run tests/parser.test.ts tests/undo.test.ts \
  tests/mcp-auth.test.ts tests/mcp-config.test.ts tests/mcp-embed.test.ts \
  tests/mcp-tools.test.ts tests/mcp-dispatch.test.ts \
  tests/mcp-index.test.ts tests/mcp-oauth.test.ts \
  tests/gardener-similarity.test.ts tests/gardener-config.test.ts \
  tests/gardener-alert.test.ts tests/gardener-trigger.test.ts \
  tests/gardener-clustering.test.ts tests/gardener-entities.test.ts

# Or individually:
npx vitest run tests/parser.test.ts              # Capture response parsing
npx vitest run tests/undo.test.ts                # /undo command (grace window, source filter)
npx vitest run tests/mcp-tools.test.ts           # All 7 MCP tool handlers
npx vitest run tests/mcp-dispatch.test.ts        # JSON-RPC dispatch
npx vitest run tests/mcp-oauth.test.ts           # Consent page + AuthHandler
npx vitest run tests/mcp-index.test.ts           # OAuthProvider + resolveExternalToken
npx vitest run tests/gardener-clustering.test.ts # Louvain clustering (graph build, gravity, labels)
npx vitest run tests/gardener-entities.test.ts  # Entity extraction + dictionary resolution
```

### Smoke tests (live workers, requires `.dev.vars`)

```bash
npx vitest run tests/smoke.test.ts              # Telegram Worker
npx vitest run tests/mcp-smoke.test.ts          # MCP Worker + OAuth discovery
```

### Integration tests (live stack, requires `.dev.vars`)

```bash
npx vitest run tests/gardener-integration.test.ts   # capture → gardener /trigger → get_related
```

### Semantic correctness suite

```bash
npx vitest run tests/semantic.test.ts   # 78 tests, ~100s, hits live MCP + Supabase, self-cleaning
```

Tests tagging quality, linking accuracy, and search relevance across 9 topic clusters (A-I), including conviction-type inputs (first-person beliefs about process/design). Cleans up via `source='semantic-test'` + ON DELETE CASCADE. Run this before and after capture agent changes to measure quality impact.

### Typecheck

```bash
npx tsc --noEmit                            # Telegram Worker
npx tsc --noEmit -p mcp/tsconfig.json       # MCP Worker
npx tsc --noEmit -p gardener/tsconfig.json  # Gardener Worker
```

## Deploy

```bash
bash scripts/deploy.sh          # Full: schema → typecheck → unit tests → MCP Worker → Telegram Worker → bot commands → Gardener Worker → smoke tests
bash scripts/deploy.sh --skip-smoke  # Skip end-to-end smoke tests

# Individual Workers:
wrangler deploy                          # Telegram Worker
wrangler deploy -c mcp/wrangler.toml     # MCP Worker
wrangler deploy -c gardener/wrangler.toml  # Gardener Worker
```

### Local dev server

```bash
wrangler dev                              # Telegram Worker at localhost:8787
wrangler dev -c mcp/wrangler.toml         # MCP Worker
wrangler dev -c gardener/wrangler.toml    # Gardener Worker
```

### Trigger a local gardener run

```bash
# Symlink .dev.vars for the gardener:
ln -s ../.dev.vars gardener/.dev.vars

npx wrangler dev -c gardener/wrangler.toml --test-scheduled
# then: curl "http://localhost:8787/__scheduled?cron=0+2+*+*+*"
```

## Project layout

```
src/              Telegram capture Worker (thin webhook adapter)
  index.ts        Entry point — webhook handler, /undo command, Service Binding calls, HTML reply formatting
  db.ts           Supabase client + dedup (tryClaimUpdate)
  telegram.ts     Telegram API helpers
  config.ts       Environment variable parsing (Telegram + Supabase only)
  types.ts        Telegram types + CaptureServiceStub + ServiceCaptureResult
mcp/              MCP Worker (JSON-RPC 2.0 over HTTP)
  src/
    index.ts      OAuthProvider setup, CaptureService entrypoint (capture + undoLatest), McpApiHandler, resolveExternalToken bypass
    pipeline.ts   Single source of truth for capture logic (called by Service Binding RPC + capture_note tool)
    oauth.ts      Consent page HTML + AuthHandler (GET/POST /authorize)
    tools.ts      MCP tool handlers with input validation
    auth.ts       Bearer token auth + constant-time comparison
    config.ts     Config loading with validation
    db.ts         DB read/write functions
    embed.ts      Embedding helpers
    capture.ts    System frame, LLM call, response parser (parseCaptureResponse)
    types.ts      MCP-specific TypeScript interfaces + ServiceCaptureResult
  wrangler.toml
gardener/         Gardener Worker (nightly similarity linking + cluster detection + entity extraction)
  src/
    index.ts      Cron-triggered entry point — orchestrates similarity linking, clustering, and entity extraction
    clustering.ts Louvain community detection via Graphology (multi-resolution, gravity, tag labels)
    entities.ts   Entity extraction prompt, response parsing, corpus-wide dedup/resolution
    ai.ts         OpenRouter client for entity extraction (optional — only when OPENROUTER_API_KEY set)
    similarity.ts Link context builder (shared tags)
    db.ts         Supabase operations (similarity linking + cluster storage + entity dictionary)
    alert.ts      Best-effort Telegram failure notification
    auth.ts       Bearer token auth for /trigger endpoint
    config.ts     Config loading with threshold + clustering + entity config validation
    types.ts      TypeScript interfaces
  wrangler.toml
.claude/
  commands/       Custom command prompts (Claude Code slash commands)
    orchestrate.md        Orchestrator mode — parallel cmux workspaces + git worktrees
    extract-fragments.md  Example recipe: topic-driven Obsidian re-capture sessions
    harvest-ideas.md      Search corpus for actionable product ideas
    audit-captures.md     Capture quality audit
    work-on-issue.md      Full issue workflow (gather → review → plan → implement → ship)
    reflect.md            Session-closing ritual: review pushbacks, improve commands/docs/memory
scripts/
  deploy.sh                 Automated deploy pipeline
  cluster-experiment.ts     Clustering experiment — weighted graph + Louvain against live corpus (read-only)
  threshold-analysis.ts     Threshold analysis — pairwise distribution, gardener sweep, source stratification (read-only)
  measure-tag-consistency.ts  Tag consistency measurement — burst detection, reuse rate, synonym introductions, pre/post comparison (read-only)
  tag-quality-analysis.ts   Tag quality analysis — tag frequency, reuse patterns, singleton rate (read-only)
  retag-corpus.ts           One-time corpus re-tag — re-runs capture LLM chronologically, updates tags + embeddings (dry-run default, --write to commit)
supabase/
  migrations/     Schema migrations (v4 is current)
tests/
  parser.test.ts          Capture response parsing
  undo.test.ts            /undo command (grace window, source filter)
  smoke.test.ts           Live Telegram Worker
  mcp-auth.test.ts        MCP auth
  mcp-config.test.ts      MCP config loading
  mcp-embed.test.ts       Embedding helpers
  mcp-tools.test.ts       All MCP tool handlers
  mcp-index.test.ts       OAuthProvider + resolveExternalToken
  mcp-oauth.test.ts       Consent page + AuthHandler
  mcp-dispatch.test.ts    JSON-RPC dispatch
  mcp-smoke.test.ts       Live MCP Worker + OAuth discovery
  gardener-similarity.test.ts  buildContext + UUID dedup
  gardener-config.test.ts      Gardener config loading (thresholds, cosineFloor, resolutions)
  gardener-clustering.test.ts  Louvain clustering (graph build, gravity, labels, singletons)
  gardener-entities.test.ts    Entity extraction + dictionary resolution
  gardener-alert.test.ts       Telegram failure alerting
  gardener-trigger.test.ts     /trigger endpoint auth + routing
  gardener-integration.test.ts capture → gardener → get_related
  semantic.test.ts             Tagging, linking, search quality
.github/
  workflows/
    backup.yml        Automated daily Supabase backup to private GitHub repo
docs/             Architecture, schema, decisions, roadmap
```

## Test file conventions

- **Unit tests** (`parser.test.ts`, `mcp-*.test.ts`, `gardener-*.test.ts`) — no network, mocked dependencies
- **Smoke tests** (`smoke.test.ts`, `mcp-smoke.test.ts`) — hit live Workers, require `.dev.vars`. Test notes are prefixed `[SMOKE-TEST]` and cleaned up in `afterAll`
- **Integration tests** (`gardener-integration.test.ts`) — exercise the full cycle against deployed Workers. Require `MCP_WORKER_URL`, `MCP_API_KEY`, `GARDENER_WORKER_URL`, `GARDENER_API_KEY` in `.dev.vars`
- **Semantic tests** (`semantic.test.ts`) — quality assertions against real LLM output. Self-cleaning via `source='semantic-test'`. ~70s runtime

## `.dev.vars` loading

`.dev.vars` uses `KEY=VALUE` format (no `export` prefix). `source .dev.vars` sets vars in the current shell but does NOT export them — child processes don't see them. Use:

```bash
export $(grep -E '^(VAR1|VAR2)=' .dev.vars | xargs)
```

to load specific vars for subcommands.

## Documentation

| Document | Contents |
|---|---|
| [Usage guide](usage.md) | What daily use looks like — capture, retrieval, curation, gardener |
| [Philosophy](philosophy.md) | Design principles and why each exists — the constraints the system is built against |
| [Architecture](architecture.md) | Async capture flow, two-pass embedding, prompt structure, error handling |
| [Capture agent](capture-agent.md) | Linking logic, voice correction, fragment capture behavior |
| [Schema](schema.md) | All tables, RPC functions, indexes, RLS |
| [Design decisions](decisions.md) | Why this stack, key tradeoffs, lessons from real usage |
| [Roadmap](roadmap.md) | Phase history and what's next |
| [Setup](setup.md) | Full deploy guide — prerequisites, secrets, Worker deployment, config |
| [CLAUDE.md](../CLAUDE.md) | Working instructions for Claude Code — conventions, constraints, commands |

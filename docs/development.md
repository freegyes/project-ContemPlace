# Development

Test commands, project layout, and contributor reference for ContemPlace.

## Tests

~420 tests across unit, integration, smoke, and semantic suites.

### Unit tests (local, no network)

```bash
# All unit tests at once
npx vitest run tests/parser.test.ts \
  tests/mcp-auth.test.ts tests/mcp-config.test.ts tests/mcp-embed.test.ts \
  tests/mcp-parser.test.ts tests/mcp-tools.test.ts tests/mcp-dispatch.test.ts \
  tests/mcp-index.test.ts tests/mcp-oauth.test.ts \
  tests/gardener-similarity.test.ts tests/gardener-normalize.test.ts \
  tests/gardener-embed.test.ts tests/gardener-config.test.ts \
  tests/gardener-alert.test.ts tests/gardener-trigger.test.ts \
  tests/gardener-chunk.test.ts

# Or individually:
npx vitest run tests/parser.test.ts              # Capture response parsing (17 tests)
npx vitest run tests/mcp-tools.test.ts           # All 8 MCP tool handlers (93 tests)
npx vitest run tests/mcp-dispatch.test.ts        # JSON-RPC dispatch (27 tests)
npx vitest run tests/mcp-oauth.test.ts           # Consent page + AuthHandler (19 tests)
npx vitest run tests/mcp-index.test.ts           # OAuthProvider + resolveExternalToken (15 tests)
npx vitest run tests/gardener-normalize.test.ts  # Tag matching logic (23 tests)
npx vitest run tests/gardener-chunk.test.ts      # Note chunking (16 tests)
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
npx vitest run tests/semantic.test.ts   # 45 tests, ~70s, hits live MCP + Supabase, self-cleaning
```

Tests tagging quality, linking accuracy, and search relevance. Cleans up via `source='semantic-test'` + ON DELETE CASCADE. Run this before and after capture agent changes to measure quality impact.

### Typecheck

```bash
npx tsc --noEmit                            # Telegram + MCP Workers
npx tsc --noEmit -p gardener/tsconfig.json  # Gardener Worker
```

## Deploy

```bash
bash scripts/deploy.sh          # Full: schema → typecheck → unit tests → Telegram Worker → Gardener Worker → smoke tests
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
    index.ts      OAuthProvider setup, McpApiHandler, resolveExternalToken bypass
    oauth.ts      Consent page HTML + AuthHandler (GET/POST /authorize)
    tools.ts      All 8 tool handlers with input validation
    auth.ts       Bearer token auth + constant-time comparison
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
  parser.test.ts          Capture response parsing (17)
  smoke.test.ts           Live Telegram Worker
  mcp-auth.test.ts        MCP auth (8)
  mcp-config.test.ts      MCP config loading (14)
  mcp-embed.test.ts       Embedding + parity with src/embed.ts (8)
  mcp-parser.test.ts      MCP parser parity with src/capture.ts (17)
  mcp-tools.test.ts       All 8 tool handlers (93)
  mcp-index.test.ts       OAuthProvider + resolveExternalToken (15)
  mcp-oauth.test.ts       Consent page + AuthHandler (19)
  mcp-dispatch.test.ts    JSON-RPC dispatch (27)
  mcp-smoke.test.ts       Live MCP Worker + OAuth discovery (27)
  gardener-similarity.test.ts  buildContext + UUID dedup (13)
  gardener-normalize.test.ts   Tag matching logic (23)
  gardener-embed.test.ts       Embedding parity (3)
  gardener-config.test.ts      Gardener config loading (12)
  gardener-alert.test.ts       Telegram failure alerting (10)
  gardener-trigger.test.ts     /trigger endpoint auth + routing (13)
  gardener-chunk.test.ts       Note chunking logic (16)
  gardener-integration.test.ts capture → gardener → get_related (6)
  semantic.test.ts             Tagging, linking, search quality (45)
docs/             Architecture, schema, decisions, roadmap
```

## Test file conventions

- **Unit tests** (`parser.test.ts`, `mcp-*.test.ts`, `gardener-*.test.ts`) — no network, mocked dependencies
- **Smoke tests** (`smoke.test.ts`, `mcp-smoke.test.ts`) — hit live Workers, require `.dev.vars`. Test notes are prefixed `[SMOKE-TEST]` and cleaned up in `afterAll`
- **Integration tests** (`gardener-integration.test.ts`) — exercise the full cycle against deployed Workers. Require `MCP_WORKER_URL`, `MCP_API_KEY`, `GARDENER_WORKER_URL`, `GARDENER_API_KEY` in `.dev.vars`
- **Semantic tests** (`semantic.test.ts`) — quality assertions against real LLM output. Self-cleaning via `source='semantic-test'`. ~70s runtime
- **Parity tests** (`mcp-parser.test.ts`, `mcp-embed.test.ts`, `gardener-embed.test.ts`) — enforce that copied code in MCP and Gardener Workers stays in sync with `src/`

## `.dev.vars` loading

`.dev.vars` uses `KEY=VALUE` format (no `export` prefix). `source .dev.vars` sets vars in the current shell but does NOT export them — child processes don't see them. Use:

```bash
export $(grep -E '^(VAR1|VAR2)=' .dev.vars | xargs)
```

to load specific vars for subcommands.

## Documentation

| Document | Contents |
|---|---|
| [Architecture](architecture.md) | Async capture flow, two-pass embedding, prompt structure, error handling |
| [Capture agent](capture-agent.md) | Classification taxonomy, entity extraction, linking logic, voice correction |
| [Schema](schema.md) | All 8 tables, RPC functions, indexes, RLS, SKOS concepts |
| [Design decisions](decisions.md) | Why this stack, key tradeoffs, lessons from real usage |
| [Roadmap](roadmap.md) | Phase history and what's next |
| [Setup](setup.md) | Full deploy guide — prerequisites, secrets, Worker deployment, config |
| [CLAUDE.md](../CLAUDE.md) | Working instructions for Claude Code — conventions, constraints, commands |

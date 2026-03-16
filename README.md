<h1 align="center">ContemPlace</h1>

<p align="center">Your memory, your database, any agent.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/cloudflare-workers-orange" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/database-supabase-green" alt="Supabase" />
</p>

<div align="center">
<img src="docs/assets/claude-web-mcp-demo.png" alt="Claude.ai web retrieving instrument-building notes from ContemPlace via MCP — a fresh session with zero prior context" width="500" />
<br />
<em>A fresh Claude.ai session with no prior context. One MCP query, and the agent pulls a cluster of linked notes.</em>
</div>

---

Every AI conversation starts from zero. You re-explain your project, paste context from your notes, rebuild understanding that vanishes when the session ends or you switch tools. Your thinking is scattered across platforms that don't talk to each other.

ContemPlace is a personal knowledge base that any AI agent can read and write. Send raw thoughts — from Telegram, Claude, or anything that speaks [MCP](https://modelcontextprotocol.io/) — and the system structures, embeds, and links them into a searchable graph. A gardening pipeline finds connections in the background. Your accumulated context travels with you across tools, permanently.

Postgres you can always query and export. The whole stack runs on free tiers. LLM costs average $2–3/month.

## How it works

1. You send a thought — raw text, voice transcription, a link, whatever
2. The [capture agent](docs/capture-agent.md) titles it, corrects voice errors, tags it, and links it to related notes — your exact words are always preserved
3. A nightly gardener finds connections between your notes that you didn't make explicitly
4. Any MCP-capable agent can search, browse, and build on your accumulated knowledge

<div align="center">
<img src="docs/assets/telegram-capture-demo.png" alt="Telegram bot capturing a voice note — showing structured output with title, tags, corrections, and links" width="320" />
<br />
<em>Telegram capture: voice input from your phone → structured fragment with title, tags, corrections, and links to existing notes.</em>
</div>

## MCP tools

The MCP server is the primary interface — five tools, usable by any MCP-capable agent:

| Tool | What it does |
|---|---|
| `search_notes` | Search notes by meaning. Ranked results with body text. Optional tag filter. |
| `get_note` | Fetch a single note — body, raw_input (source of truth), links, corrections. |
| `list_recent` | Most recent notes, newest first. |
| `get_related` | All linked notes in both directions with link types and confidence. |
| `capture_note` | Pass raw words — the server runs the full capture pipeline. Do not pre-structure. |

**Auth:** OAuth 2.1 (Authorization Code + PKCE) for browser clients like Claude.ai, or a static Bearer token for CLI/SDK callers like Claude Code. Both paths are permanent.

## What's included

The database + MCP server is the core. Everything else is optional — add what you need.

| Component | What it does | Status |
|---|---|---|
| **MCP server** | 5 tools: search, capture, browse, link traversal | ✅ Live |
| **Telegram bot** | Message it, get a structured note back. Mobile capture. | ✅ Live |
| **Gardening pipeline** | Nightly similarity linking between fragments | ✅ Live |
| **OAuth 2.1** | Claude.ai web connector. Auth Code + PKCE, static key fallback. | ✅ Live |
| **Dashboard** | Browser-based graph exploration | Planned — [#101](https://github.com/freegyes/project-ContemPlace/issues/101) |
| **Import tools** | Re-fragment from Obsidian vaults, ChatGPT memory exports | Planned — [#133](https://github.com/freegyes/project-ContemPlace/issues/133), [#13](https://github.com/freegyes/project-ContemPlace/issues/13), [#14](https://github.com/freegyes/project-ContemPlace/issues/14) |

## Stack

| Layer | Technology |
|---|---|
| Compute | Cloudflare Workers (TypeScript) |
| Database | Supabase (Postgres 16 + pgvector) |
| AI gateway | OpenRouter (OpenAI-compatible SDK) |
| Embeddings | `openai/text-embedding-3-small` (1536 dimensions) |
| Capture LLM | `anthropic/claude-haiku-4-5` |
| Capture interface | Telegram bot (webhook-based) |
| Agent interface | MCP server (JSON-RPC 2.0 over HTTP) |

All models are configurable via environment variables. All AI calls route through OpenRouter — swap models without code changes.

## Trust and control

**Your words stay yours.** The capture agent structures your input — title, tags, links — but never compresses, interprets, or adds meaning you didn't express. Your exact words are always preserved alongside the structured version. Today's LLM interprets them one way; tomorrow's can reinterpret the same raw input with better understanding. Nothing is lost. [How the trust contract works →](docs/philosophy.md#3-the-trust-contract)

**You decide what goes in.** No background scraping, no automatic capture. You send what you want captured, and you're the quality gate. The system trusts your judgment — guard rails and warnings are fine, but your editorial control is what keeps the knowledge base honest. [The curator principle →](docs/philosophy.md#7-low-friction-aware-curator)

**No lock-in.** Postgres you can query and export any time. MCP means any compatible agent works — Claude, ChatGPT, Cursor, custom scripts. Switch tools whenever you want. The database doesn't care who's reading it. [Data ownership →](docs/philosophy.md#10-your-data-any-agent)

The [full design philosophy](docs/philosophy.md) has ten principles with the reasoning behind each — not marketing copy, but the actual design constraints the system is built against.

## Get started

| Goal | What to deploy | Time |
|---|---|---|
| **MCP access** — search and capture via any agent | MCP Worker + Supabase | ~10 min |
| **+ Telegram** — low-friction mobile capture | Add the Telegram Worker | +5 min |
| **+ Gardening** — automatic similarity linking | Add the Gardener Worker | +2 min |

Everything runs on free tiers. **[Setup guide →](docs/setup.md)**

## FAQ

### What kind of notes does this store?

Idea fragments — whatever is on your mind. Observations, reflections, questions, quotes, project ideas, workflow notes. You never pick a category. Send raw text; the capture agent handles structuring. Patterns emerge from accumulation, not from you organizing anything. [More on the capture agent →](docs/capture-agent.md)

### What agents work with this?

Any MCP-capable client. Tested with Claude.ai (via OAuth) and Claude Code CLI (via static token). ChatGPT and Cursor connectors should work but are [not yet verified](https://github.com/freegyes/project-ContemPlace/issues/102). The MCP server speaks JSON-RPC over HTTP, so `curl` or any HTTP client works too.

### Does value actually scale?

Each new fragment creates edges in the graph. The nightly gardener finds similarity links you didn't ask for. After a few hundred fragments, ask any agent "what have I been thinking about X?" and the graph does the work. You never organized anything manually — the structure emerged from accumulation.

### What happens if I stop using it?

Your data stays in Postgres. Export it, query it, migrate it. Every fragment's raw input is preserved, so you can re-process everything with different tools or models. There's no proprietary format to decode.

### What does it cost?

All infrastructure runs on free tiers (Cloudflare Workers, Supabase). The only cost is LLM calls through OpenRouter — typically $2–3/month for active daily use.

---

**[Philosophy](docs/philosophy.md)** · **[Setup guide](docs/setup.md)** · **[Architecture](docs/architecture.md)** · **[Schema](docs/schema.md)** · **[Capture agent](docs/capture-agent.md)** · **[Development](docs/development.md)** · **[Decisions](docs/decisions.md)** · **[Roadmap](docs/roadmap.md)**

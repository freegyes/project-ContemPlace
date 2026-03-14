<h1 align="center">ContemPlace</h1>

<p align="center">Your memory, your database, any agent.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/tests-passing-brightgreen" alt="Tests: passing" />
  <img src="https://img.shields.io/badge/cloudflare-workers-orange" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/database-supabase-green" alt="Supabase" />
</p>

<div align="center">
<img src="docs/assets/claude-web-mcp-demo.png" alt="Claude.ai web retrieving instrument-building notes from ContemPlace via MCP — a fresh session with zero prior context" width="500" />
<br />
<em>A fresh Claude.ai session with no prior context. One prompt, and the agent pulls a cluster of linked notes from the ContemPlace MCP server.</em>
</div>

---

Every AI agent you use builds memory about you — but in its own proprietary garden. You can't move it, combine it, or extract it without non-trivial effort. Every time you try a new tool, you start from zero.

ContemPlace is the fix. An MCP-connected database that *you* own. Send raw input from any interface — a Telegram bot, Claude CLI, a custom script, anything that speaks MCP. The system structures it, embeds it, links it to your prior thinking, and makes it semantically searchable. A gardening pipeline runs in the background to normalize and connect your notes so retrieval keeps getting better. Your accumulated context travels with you.

No proprietary format. No vendor lock-in. Postgres you can always query and export. The stack runs on free tiers — average use costs $2–3/month in LLM calls.

## Status

| Component | State |
|---|---|
| Telegram capture bot | ✅ Live |
| MCP server | ✅ Live — 5 tools |
| Gardening pipeline | ✅ Complete — similarity linker · [Phase 2b](https://github.com/freegyes/project-ContemPlace/milestone/1) |
| OAuth 2.1 (Claude.ai web) | ✅ Live — Auth Code + PKCE, DCR, static key fallback · [Phase 2c](https://github.com/freegyes/project-ContemPlace/milestone/2) |
| Dashboard | 💡 Planned — [#101](https://github.com/freegyes/project-ContemPlace/issues/101) |
| Leaner capture (drop type/intent/modality) | ✅ Complete — [#110](https://github.com/freegyes/project-ContemPlace/issues/110) |
| Schema simplification (v4) | ✅ Complete — drop SKOS, chunking, simplify links · [#128](https://github.com/freegyes/project-ContemPlace/issues/128) |
| URL handling + input awareness | 💡 Design phase — [#27](https://github.com/freegyes/project-ContemPlace/issues/27) |
| Import tools | 💡 Planned — [#13](https://github.com/freegyes/project-ContemPlace/issues/13), [#14](https://github.com/freegyes/project-ContemPlace/issues/14) |

> [All open issues](https://github.com/freegyes/project-ContemPlace/issues) · [Roadmap](docs/roadmap.md) · [Decisions](docs/decisions.md)

## How it works

1. You send a thought — raw text, voice transcription, a link, whatever
2. The capture agent gives it a title, corrects voice errors, tags it, and links it to related notes — your exact words are always preserved
3. Enrichment is non-destructive: future agents can reinterpret the same raw input with better models
4. A nightly gardener refines connections via similarity linking

<div align="center">
<img src="docs/assets/telegram-capture-demo.png" alt="Telegram bot capturing a note about withdiode.com — showing raw input, structured note with metadata, and link preview" width="320" />
<br />
<em>Telegram capture in action: raw input → structured note with title, tags, corrections, source URL, and links.</em>
</div>

## MCP tools

The MCP server is the primary interface. Five tools, usable by any MCP-capable agent:

| Tool | What it does |
|---|---|
| `search_notes` | Search notes by meaning. Ranked results with body text. Optional tag filter. |
| `get_note` | Fetch a single note — body, raw_input (source of truth), links, corrections. |
| `list_recent` | Most recent notes, newest first. |
| `get_related` | All linked notes in both directions with link types and confidence. |
| `capture_note` | Pass raw words — the server runs the full capture pipeline. Do not pre-structure. |

**Auth:** OAuth 2.1 (Authorization Code + PKCE) for browser clients like Claude.ai, or a static Bearer token for API/SDK callers like Claude Code CLI. Both paths are permanent.

## Modules

The database + MCP server is the only required piece. Everything else is optional.

| Module | What it does | State |
|---|---|---|
| **MCP server** | Exposes the note graph to any MCP-capable agent. The core interface. | ✅ Live |
| **Telegram capture bot** | Zero-friction note capture from your phone. Message the bot, get a structured note back. | ✅ Live |
| **Gardening pipeline** | Nightly enrichment: similarity linking. | ✅ Complete |
| **Dashboard** | Browser-based view — search, browse, follow links, see the graph. | 💡 Planned |
| **Obsidian import** | Pull an existing vault into the database. | 💡 Planned |
| **ChatGPT memory import** | Rescue accumulated context from a proprietary format. | 💡 Planned |
| **URL handling + input awareness** | Detect URLs for specialized capture; multi-fragment quality signals. | 💡 Design phase |

## Philosophy

**Your context travels with you.** Any MCP-capable agent can read and write your knowledge base. Switch tools, try new agents, combine workflows — your accumulated context comes along.

**Capture fragments, not finished thoughts.** Send whatever is on your mind — a reflection, a quote, an observation, a question, a workflow idea. No pressure to make it perfect or atomic. The system structures each fragment (title, tags, links) and preserves your exact words. Focused fragments produce the best immediate results, but everything is valuable raw material for the synthesis layer.

**You get the results without the process.** Most people organize notes because they want the results — findability, connections, patterns — not because they enjoy organizing. ContemPlace automates the gardening: similarity links and (planned) cluster synthesis. You capture fragments; the system does the curation.

**Value compounds the more you use it.** Fragment 1 is just a fragment. Fragment 50 starts forming clusters. Fragment 200 has a graph where ideas reinforce, contradict, and extend each other — and you didn't build that graph manually. The gardening pipeline tightens the mesh in the background. The more you capture, the richer the context any agent has when it reads your memory.

**The primary consumer is your agents, not you.** You rarely browse notes directly. You ask an AI something and it pulls from your memory via MCP — semantic search, related notes, link traversal. The database is designed for machine retrieval first, which means any MCP-capable tool gets full access to your accumulated thinking.

**Your ideas become a graph you can explore.** Fragments cluster around themes over time. Some nodes gain gravitational weight. Structure isn't imposed; it emerges from the accumulation of linked, gardened fragments. The system never reaches a final state — it's a living organism that changes with every fragment you capture, reflecting back what you've been thinking about days or years ago.

**The system is a faithful mirror, not a co-author.** The capture agent doesn't compress, interpret, or add inferred meanings. It transcribes, not synthesizes. Every sentence in the body traces back to something you actually said. Your raw input is always preserved as the irreplaceable source of truth. When the synthesis layer organizes and connects your fragments, it stays analytical — no inferred conclusions, no creative additions. Everything traces to something you said.

**You own your data.** Postgres. Query it, export it, migrate it. Today's LLM interprets your words one way; tomorrow's can reinterpret the same raw input with better understanding. Enrichment is always additive, never destructive. No proprietary format, no walled garden.

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

## Quick start

What do you want? Pick your path:

| Goal | Deploy | Guide |
|---|---|---|
| **MCP access only** — search and capture via any agent | MCP Worker + Supabase | [Setup: MCP Worker](docs/setup.md#4-deploy-the-mcp-worker) |
| **+ Telegram capture** — low-friction mobile input | Add the Telegram Worker | [Setup: Telegram Worker](docs/setup.md#3-deploy-the-telegram-capture-worker) |
| **+ Background enrichment** — similarity linking | Add the Gardener Worker | [Setup: Gardener Worker](docs/setup.md#5-deploy-the-gardener-worker) |

All three require a Supabase database and Cloudflare account. Full prerequisites and step-by-step instructions in the **[Setup guide](docs/setup.md)**.

## FAQ

### What kind of notes does this store?

Anything you'd want to find again. The system captures idea fragments — whatever is on your mind, in your own voice. A fragment can be a single focused thought or something rougher and more partial. In practice, a typical database ends up with:

- **Observations** — things you noticed about the world, your work, your interests
- **Reflections** — personal notes about energy, motivation, creative identity, life
- **Questions** — things you'd like to ponder or investigate
- **Quotes and references** — things that resonated from books, articles, conversations
- **Project ideas** — things to build, explore, or try
- **Workflow notes** — specific suggestions for how to do things better

The system doesn't care about categories. You never have to pick one. You send raw text; the capture agent handles structuring. The patterns above aren't folders — they emerge from real usage.

### Why preserve the raw input?

Every note stores two things: the structured note (title, body, tags, links) and your exact original words in `raw_input`. The structured version is the LLM's interpretation — useful for search and retrieval today. But models improve. A year from now, a better model can re-read your raw input and extract richer meaning, catch nuances the current model missed, or classify things differently. Because enrichment is non-destructive — it only adds columns and links, never overwrites `raw_input` — your database gets smarter over time without losing anything. You're not locked into today's LLM's understanding of what you said.

### Does value really scale with more notes?

Yes, and nonlinearly. A single note is just text with metadata. But the capture agent links each new note to existing ones, so every note you add creates new edges in the graph. The nightly gardener finds similarity links you didn't ask for. After a few hundred notes, ask any MCP agent "what are my recurring themes?" or "what relates to this idea?" and the graph does the work. You never organized anything manually. The structure emerged from accumulation.

### How does structure emerge?

No folders, no hierarchy, no manual organization. Structure comes from three mechanisms:

1. **Capture-time linking** — the LLM compares your note against existing notes and creates edges to related notes
2. **Similarity linking** — the gardening pipeline finds notes with high cosine similarity and connects them

Over time, clusters form naturally. Any MCP-capable agent can surface them — ask "what are my instrument-building ideas?" and the graph does the work.

<details>
<summary><strong>What the capture agent produces</strong></summary>

The capture agent structures each note in a single LLM pass:

| Field | Purpose |
|---|---|
| **title** | A claim or question — never a topic label. States the note's point so you can scan a list without opening each one. |
| **body** | Faithful to your words, as long as needed — no compression. Typically 1–4 sentences. |
| **tags** | Free-form, from the input |
| **links** | Edges to related notes |
| **corrections** | Voice dictation fixes, applied silently and reported |
| **source_ref** | URL if one was included |

The body follows a strict traceability rule: every sentence must trace back to something you actually said. The agent transcribes, not interprets.

Input can come from voice dictation. The agent detects and silently corrects transcription errors, cross-referencing proper nouns against existing notes. Corrections are shown in the reply.
</details>

---

**[Philosophy](docs/philosophy.md)** · **[Setup guide](docs/setup.md)** · **[Development](docs/development.md)** · **[Architecture](docs/architecture.md)** · **[Schema](docs/schema.md)** · **[Capture agent](docs/capture-agent.md)** · **[Decisions](docs/decisions.md)** · **[Roadmap](docs/roadmap.md)** · **[CLAUDE.md](CLAUDE.md)**

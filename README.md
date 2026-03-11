<h1 align="center">ContemPlace</h1>

<p align="center">Your memory, your database, any agent.</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
  <img src="https://img.shields.io/badge/tests-~435-brightgreen" alt="Tests: ~435" />
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

ContemPlace is the fix. An MCP-connected database that *you* own. Send raw input from any interface — a Telegram bot, Claude CLI, a custom script, anything that speaks MCP. The system structures it, embeds it, links it to your prior thinking, and makes it semantically searchable. A gardening pipeline runs in the background to normalize, connect, and chunk your notes so retrieval keeps getting better. Your accumulated context travels with you.

No proprietary format. No vendor lock-in. Postgres you can always query and export. The stack runs on free tiers — average use costs $2–3/month in LLM calls.

## Status

| Component | State |
|---|---|
| Telegram capture bot | ✅ Live |
| MCP server | ✅ Live — 8 tools |
| Gardening pipeline | ✅ Complete — similarity linker, tag normalization, chunk generation · [Phase 2b](https://github.com/freegyes/project-ContemPlace/milestone/1) |
| OAuth 2.1 (Claude.ai web) | ✅ Live — Auth Code + PKCE, DCR, static key fallback · [Phase 2c](https://github.com/freegyes/project-ContemPlace/milestone/2) |
| Dashboard | 💡 Planned — [#12](https://github.com/freegyes/project-ContemPlace/issues/12) |
| Smart capture router | 💡 Design phase — [#27](https://github.com/freegyes/project-ContemPlace/issues/27) |
| Import tools | 💡 Planned — [#13](https://github.com/freegyes/project-ContemPlace/issues/13), [#14](https://github.com/freegyes/project-ContemPlace/issues/14) |

> [All open issues](https://github.com/freegyes/project-ContemPlace/issues) · [Roadmap](docs/roadmap.md) · [Decisions](docs/decisions.md)

## How it works

1. You send a thought — raw text, voice transcription, a link, whatever
2. The capture agent structures it: title, body, tags, type, intent, entities — and links it to related notes
3. Your exact words are always preserved alongside the structured note
4. A nightly gardener refines connections: similarity links, tag normalization, chunking for retrieval

<div align="center">
<img src="docs/assets/telegram-capture-demo.png" alt="Telegram bot capturing a note about withdiode.com — showing raw input, structured note with metadata, and link preview" width="320" />
<br />
<em>Telegram capture in action: raw input → structured note with type, tags, corrections, source URL, and entities.</em>
</div>

## MCP tools

The MCP server is the primary interface. Eight tools, usable by any MCP-capable agent:

| Tool | What it does |
|---|---|
| `search_notes` | Search notes by meaning. Ranked results with body text. Filter by type, intent, tags. |
| `search_chunks` | Search within paragraphs of long notes (body > 1500 chars). |
| `get_note` | Fetch a single note — body, raw_input (source of truth), entities, links, corrections. |
| `list_recent` | Most recent notes, newest first. Filter by type or intent. |
| `get_related` | All linked notes in both directions with link types and confidence. |
| `capture_note` | Pass raw words — the server runs the full capture pipeline. Do not pre-structure. |
| `list_unmatched_tags` | Tags without SKOS concept matches, with frequency. Curation workflow. |
| `promote_concept` | Add a concept to the SKOS vocabulary for synonym normalization. |

**Auth:** OAuth 2.1 (Authorization Code + PKCE) for browser clients like Claude.ai, or a static Bearer token for API/SDK callers like Claude Code CLI. Both paths are permanent.

## Modules

The database + MCP server is the only required piece. Everything else is optional.

| Module | What it does | State |
|---|---|---|
| **MCP server** | Exposes the note graph to any MCP-capable agent. The core interface. | ✅ Live |
| **Telegram capture bot** | Zero-friction note capture from your phone. Message the bot, get a structured note back. | ✅ Live |
| **Gardening pipeline** | Nightly enrichment: similarity links, SKOS tag normalization, chunk generation. | ✅ Complete |
| **Dashboard** | Browser-based view — search, browse, follow links, see the graph. | 💡 Planned |
| **Obsidian import** | Pull an existing vault into the database. | 💡 Planned |
| **ChatGPT memory import** | Rescue accumulated context from a proprietary format. | 💡 Planned |
| **Smart capture router** | Auto-detect input type: short notes, URLs, brain dumps, lists. | 💡 Design phase |

## Philosophy

**Your context travels with you.** Any MCP-capable agent can read and write your knowledge base. Switch tools, try new agents, combine workflows — your accumulated context comes along.

**You never think about the system.** Send a thought; structure emerges automatically. Tags, intent, entities, and links happen in the background. Low friction isn't a feature — it's the reason this works at all.

**Your ideas become a graph you can explore.** Notes cluster around themes over time. Some nodes gain gravitational weight. Structure isn't imposed; it emerges from the accumulation of linked, gardened notes.

**You own your data.** Postgres. Query it, export it, migrate it. Raw input is always preserved. No proprietary format, no walled garden.

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
| **+ Background enrichment** — similarity links, tag normalization, chunking | Add the Gardener Worker | [Setup: Gardener Worker](docs/setup.md#5-deploy-the-gardener-worker) |

All three require a Supabase database and Cloudflare account. Full prerequisites and step-by-step instructions in the **[Setup guide](docs/setup.md)**.

## FAQ

### What kind of notes does this store?

Anything you'd want to find again. The capture agent classifies each note by type and intent automatically. In practice, a typical database ends up with:

- **Project ideas** — things to build, one concept per note
- **Technical references** — things you looked up and want to find again
- **Research breadcrumbs** — things to follow up on
- **Source notes** — references to videos, articles, or conversations that sparked ideas
- **Reflections** — shorter, personal notes about energy, motivation, or creative identity

The system doesn't care about categories. You never have to pick one. You send raw text; the capture agent figures out the rest. The patterns above aren't folders — they emerge from real usage.

### How does structure emerge?

No folders, no hierarchy, no manual organization. Every note is atomic — one idea, one reference, one reflection. Structure comes from three mechanisms:

1. **Capture-time linking** — the LLM compares your note against existing notes and creates typed edges (`extends`, `contradicts`, `supports`, `is-example-of`, `duplicate-of`)
2. **Similarity linking** — the gardening pipeline finds notes with high cosine similarity and connects them with `is-similar-to` links
3. **Tag normalization** — free-form tags are matched against a SKOS concept vocabulary, so "laser cutting" and "laser cutter" resolve to the same concept

Over time, clusters form naturally. Any MCP-capable agent can surface them — ask "what are my instrument-building ideas?" and the graph does the work.

<details>
<summary><strong>What the capture agent produces</strong></summary>

Each note gets 10 fields from a single LLM pass:

| Field | Purpose |
|---|---|
| **title** | A claim or insight — not a topic label |
| **body** | 1–8 sentences (scales with input length), atomic, in the user's own voice |
| **type** | `idea` / `reflection` / `source` / `lookup` |
| **intent** | `reflect` / `plan` / `create` / `remember` / `reference` / `log` |
| **modality** | `text` / `link` / `list` / `mixed` |
| **tags** | Free-form, from the input |
| **entities** | Proper nouns with types (person, place, tool, project, concept) |
| **links** | Typed edges to related notes |
| **corrections** | Voice dictation fixes, applied silently and reported |
| **source_ref** | URL if one was included |

The body follows a strict traceability rule: every sentence must trace back to something you actually said. The agent transcribes, not interprets.

Input can come from voice dictation. The agent detects and silently corrects transcription errors, cross-referencing proper nouns against existing notes. Corrections are shown in the reply.
</details>

---

**[Setup guide](docs/setup.md)** · **[Development](docs/development.md)** · **[Architecture](docs/architecture.md)** · **[Schema](docs/schema.md)** · **[Capture agent](docs/capture-agent.md)** · **[Decisions](docs/decisions.md)** · **[Roadmap](docs/roadmap.md)** · **[CLAUDE.md](CLAUDE.md)**

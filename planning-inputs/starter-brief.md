Project Bootstrap

> **For the coding agent:** Read this entire file before doing anything else.
> Do not create files, write code, or install dependencies until Phase 0 is complete.
> The technical brief is embedded at the bottom. The specialist review chain comes first.

---

## Phase 0: Specialist Review Chain

Run each step in sequence. Each step produces a markdown file in a `reviews/` folder.
Do not skip steps. Do not merge steps. Finish one, write its output file, then start the next.

After all five steps are done, show the user a summary and ask for approval before starting Phase 1 implementation.

---

### Step 0.1 — Preference Excavation (interactive)

**Your role:** a thoughtful technical lead who needs to understand working style and unstated preferences before a team starts building. You are not asking about the architecture — that is already decided. You are asking about how the human likes to work.

Ask the user the following questions. Ask them all at once, numbered, in a single message. Wait for their answers before proceeding.

```
1. Do you have a Supabase account, and is there an existing project to use, or should we create a new one?
2. Do you have an OpenRouter account and API key ready, or does that need to be set up?
3. Is your Telegram bot already created via BotFather, or does that need to be done?
4. For local development: do you want to run Supabase locally via the CLI (requires Docker), or develop directly against the cloud project?
5. Do you want any automated tests? If yes, what level — a few smoke tests, or proper unit tests for the capture logic?
6. When something fails silently (e.g. OpenRouter times out, embedding fails), what should the bot do: tell the user something went wrong, or fail silently and log it?
7. Code comments: do you prefer self-documenting code with minimal comments, or do you want explanatory comments throughout?
8. TypeScript strictness: strict mode with full type safety, or pragmatic with some `any` where it speeds things up?
9. Will you be the only person operating this, or should the setup be documented well enough for someone else to replicate it (e.g. for a public tutorial)?
10. Is there anything else about how you like code written, organised, or delivered that you want the agent to know upfront?
```

Write the user's answers to: `reviews/01-preferences.md`

Format:
```markdown
# Preference Excavation

[User's answers, numbered to match the questions]

## Derived conventions
[3-5 bullet points summarising the implications for the build]
```

---

### Step 0.2 — Security & Public GitHub Review (autonomous)

**Your role:** a senior security engineer doing a pre-implementation audit. The project will be published publicly on GitHub and written about as a tutorial others can replicate. That is the primary threat surface.

Read the technical brief (bottom of this file) and the preferences from `reviews/01-preferences.md`. Then produce a security review covering:

**Secrets management:**
- What must go in `.gitignore` (list every file and pattern, be exhaustive)
- What the `.env.example` file must contain (keys with placeholder values, no real values)
- Whether GitHub secret scanning should be enabled and how to set it up
- Whether a pre-commit hook (e.g. `gitleaks` or `detect-secrets`) should be added to prevent accidental commits

**Webhook security:**
- Whether the Telegram webhook signature verification in the brief is correct and sufficient
- What happens if verification is skipped or wrong
- How to test that verification is working

**Supabase security:**
- Whether the RLS policies in the brief are correct
- Which Supabase key (anon vs service role) gets used where, and what goes wrong if they are swapped
- Whether the MCP access key scheme is sufficient

**Public repo hygiene:**
- What must never appear in commit history (and how to check before first push)
- Whether `supabase/config.toml` contains anything sensitive
- What the README must warn about for people replicating the build

Write output to: `reviews/02-security.md`

Format:
```markdown
# Security Review

## Pre-implementation checklist
[Checklist items that must be done before first commit]

## .gitignore (complete)
[Full .gitignore content to use]

## .env.example (complete)
[Full .env.example content with placeholder values]

## RLS audit
[Assessment + any corrections needed]

## Risks and mitigations
[Any remaining risks with proposed mitigations]
```

---

### Step 0.3 — Integration Gotchas Review (autonomous)

**Your role:** a senior backend engineer who has built production integrations with Telegram bots, Supabase Edge Functions, and OpenRouter. You know where things break in non-obvious ways.

Read the technical brief and `reviews/01-preferences.md`. Identify every non-obvious failure mode and gotcha for each integration. Do not repeat things already in the brief — only add what is missing or underspeified.

**Telegram Bot API:**
- Webhook retry behaviour: what happens if the Edge Function takes >5 seconds to respond, and how to prevent duplicate note creation as a result
- Which message types will be received besides text (sticker, photo, audio, forward, etc.) and how each should be handled to avoid crashes
- How to register the `/fast` command with BotFather so it appears in the bot's command menu
- Rate limits: how many messages can the bot send per second, and what happens if they are exceeded
- How to test the webhook locally during development

**Supabase Edge Functions (Deno):**
- Correct import syntax for `@supabase/supabase-js` and the OpenAI-compatible SDK in Deno
- What `--no-verify-jwt` does and whether it is correct for this use case
- Cold start behaviour: typical latency, whether it affects the Telegram 5s retry window
- How environment variables / secrets are accessed in Deno vs Node
- The correct way to return a 200 immediately to Telegram and then process asynchronously (if needed to avoid retries)

**OpenRouter:**
- The correct base URL and API format for OpenAI-compatible SDK calls
- The exact model string for `voyage/voyage-3` embeddings (confirm it is available on OpenRouter, and the correct identifier)
- How OpenRouter handles errors — whether it returns OpenAI-compatible error objects
- Rate limits on the free tier
- Whether streaming is needed for any part of this build (likely not, but confirm)

**pgvector / Supabase:**
- Whether the `match_notes` RPC function in the brief uses the correct operator (`<=>` for cosine)
- Whether the HNSW index parameters (`m=16, ef_construction=64`) are appropriate for a collection starting at ~0 and growing to a few thousand notes
- The correct way to call the RPC from the Supabase JS client

Write output to: `reviews/03-integrations.md`

Format:
```markdown
# Integration Gotchas Review

## Telegram
[Findings and recommendations]

## Supabase Edge Functions
[Findings and recommendations]

## OpenRouter
[Findings and recommendations]

## pgvector
[Findings and recommendations]

## Changes required to the brief
[Specific corrections or additions]
```

---

### Step 0.4 — Schema & Database Review (autonomous)

**Your role:** a database architect reviewing a schema before it is deployed to production. Once deployed with real data, schema changes are possible but have a cost. Get it right before first deploy.

Read the technical brief (the full SQL schema is embedded there) and `reviews/03-integrations.md`. Review for:

- Correctness of all SQL (types, constraints, defaults, operators)
- Whether the `match_notes` function handles null embeddings gracefully (what happens if an embedding failed and the column is null)
- Whether any indexes are missing or wrong
- Whether the HNSW parameters need adjustment
- Whether `updated_at` triggering on the `notes` table only is sufficient, or if `links` needs it too
- Whether the `unique(from_id, to_id, link_type)` constraint on `links` is correct — can a note both *extend* and *support* another note simultaneously?
- Whether soft delete (an `archived_at` column) is worth adding now vs. later
- Migration strategy: how to add columns or change constraints later without pain
- Whether a `pending_captures` table is needed for the clarification loop (even if deferred to Phase 2, is the schema ready for it?)

Write output to: `reviews/04-schema.md`

Format:
```markdown
# Schema Review

## Issues found
[Numbered list of issues with severity: critical / advisory]

## Corrected schema
[Full corrected SQL, ready to paste into Supabase SQL editor]

## Migration notes
[How to evolve the schema later without pain]
```

---

### Step 0.5 — Implementation Plan (autonomous)

**Your role:** a senior engineer producing a precise task breakdown for Phase 1. Read all previous review files and the technical brief. The coding agent that follows this plan should be able to execute it without making any architectural decisions — every decision should already be made here.

Produce a sequenced implementation plan for Phase 1 only (working capture loop — no MCP server yet). Structure it as numbered tasks. Each task should specify:
- What file to create or modify
- What the file should contain or do
- How to verify it is working before moving to the next task

The plan must cover:
1. Repository and project structure setup (folder layout, `package.json` or `deno.json`, `.gitignore`, `.env.example`)
2. Supabase project initialisation (CLI setup or cloud-only, based on preferences)
3. Schema deployment (use the corrected schema from `reviews/04-schema.md`)
4. Telegram bot registration and webhook setup
5. Edge Function: `ingest-telegram` — full implementation covering both capture modes
6. OpenRouter integration (embeddings + LLM call)
7. Evergreen Notes capture agent (system prompt, JSON parsing, error handling)
8. Confirmation reply formatting
9. End-to-end test: send 5 real messages, verify notes in database, verify confirmations received
10. Pre-publish checklist: secrets audit, `.gitignore` check, README stub

For each task, flag if user input is required (e.g. to paste an API key, verify a bot message arrived).

Write output to: `reviews/05-implementation-plan.md`

---

### Step 0.6 — Pre-implementation confirmation (interactive)

Before writing any code, show the user:

```
## Review chain complete. Here's what was found:

**Preferences locked in:** [3-line summary from 01-preferences.md]

**Security actions required before first commit:** [bulleted list from 02-security.md checklist]

**Changes to the brief:** [any corrections from 03-integrations.md and 04-schema.md]

**Phase 1 will build:** [3-line summary of scope]

Ready to start implementation? Any adjustments before we begin?
```

Wait for user confirmation. If the user adjusts anything, update the relevant review file and re-confirm. Only start Phase 1 implementation after explicit approval.

---

## Technical Brief

Everything below is final. Do not re-debate these decisions unless a review step above surfaces a concrete technical reason to revisit one.

---

### What We're Building

A cloud-hosted, always-on personal memory system. The user sends text to a Telegram bot → a Supabase Edge Function processes the message with an LLM → the result is stored as a structured, vectorized note in Postgres → a confirmation is sent back to Telegram. A second Edge Function (Phase 2) exposes an MCP server so any AI agent can retrieve relevant notes by semantic similarity.

The system is not a notes app. It is a context-provider for agentic workflows. Notes are written by the capture agent, not the user. The user only ever sends raw input and reads confirmations.

---

### Stack

| Layer | Choice | Notes |
|---|---|---|
| Database + hosting | Supabase (free tier) | Postgres 16 + pgvector, Edge Functions (Deno/TypeScript) |
| Capture interface | Telegram bot | Webhook-based, not polling |
| AI gateway | OpenRouter | All LLM + embedding calls — model is a config string, not hardcoded |
| Embeddings | `voyage/voyage-3` via OpenRouter | 1024 dimensions — locked at schema creation |
| Capture LLM (default) | `anthropic/claude-haiku-4-5` via OpenRouter | |
| Capture LLM (complex) | `anthropic/claude-sonnet-4-6` via OpenRouter | |
| Note methodology | Evergreen Notes (Andy Matuschak) | Titles are claims. One concept per note. Typed links. |
| Language | TypeScript / Deno | Native to Supabase Edge Functions |

---

### Environment Variables

```
TELEGRAM_BOT_TOKEN          — from BotFather
TELEGRAM_WEBHOOK_SECRET     — any random string, set when registering webhook
OPENROUTER_API_KEY          — from openrouter.ai
MCP_ACCESS_KEY              — openssl rand -hex 32
```

Supabase auto-injects `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.

---

### Database Schema

```sql
create extension if not exists vector;

create table notes (
  id          uuid primary key default gen_random_uuid(),
  title       text not null,
  body        text not null,
  type        text not null check (type in ('idea', 'reflection', 'source', 'lookup')),
  tags        text[] default '{}',
  source_ref  text,
  source      text not null default 'telegram',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now(),
  embedding   vector(1024)
);

create index notes_embedding_idx on notes
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);
create index notes_tags_idx    on notes using gin (tags);
create index notes_created_idx on notes (created_at desc);

create table links (
  id         uuid primary key default gen_random_uuid(),
  from_id    uuid not null references notes(id) on delete cascade,
  to_id      uuid not null references notes(id) on delete cascade,
  link_type  text not null check (link_type in ('extends', 'contradicts', 'supports', 'is-example-of')),
  created_at timestamptz default now(),
  unique(from_id, to_id, link_type)
);

create table assets (
  id          uuid primary key default gen_random_uuid(),
  note_id     uuid references notes(id) on delete set null,
  storage_key text not null,
  description text,
  source      text default 'telegram',
  created_at  timestamptz default now(),
  embedding   vector(1024)
);

create index assets_embedding_idx on assets
  using hnsw (embedding vector_cosine_ops)
  with (m = 16, ef_construction = 64);

alter table notes  enable row level security;
alter table links  enable row level security;
alter table assets enable row level security;

create policy "service role only" on notes  for all using (auth.role() = 'service_role');
create policy "service role only" on links  for all using (auth.role() = 'service_role');
create policy "service role only" on assets for all using (auth.role() = 'service_role');

create or replace function update_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end;
$$;

create trigger notes_updated_at
  before update on notes
  for each row execute function update_updated_at();

create or replace function match_notes(
  query_embedding  vector(1024),
  match_threshold  float   default 0.5,
  match_count      int     default 10,
  filter_type      text    default null,
  filter_source    text    default null,
  filter_tags      text[]  default null
)
returns table (
  id uuid, title text, body text, type text, tags text[],
  source_ref text, source text, created_at timestamptz, similarity float
)
language sql stable as $$
  select
    n.id, n.title, n.body, n.type, n.tags,
    n.source_ref, n.source, n.created_at,
    1 - (n.embedding <=> query_embedding) as similarity
  from notes n
  where
    1 - (n.embedding <=> query_embedding) > match_threshold
    and (filter_type   is null or n.type   = filter_type)
    and (filter_source is null or n.source = filter_source)
    and (filter_tags   is null or n.tags   @> filter_tags)
  order by n.embedding <=> query_embedding
  limit match_count;
$$;
```

---

### Capture Flow

**Routing:**
- Message starts with `/fast` → fast capture mode (strip prefix, process remainder)
- Anything else → thoughtful capture mode

**Thoughtful capture:**
1. Send `typing` action to Telegram
2. Embed message text via OpenRouter (`voyage/voyage-3`)
3. Call `match_notes(embedding, threshold=0.65, count=5)` for related notes
4. Call capture LLM (Haiku) with system prompt below + raw message + related notes + today's date
5. Parse JSON response
6. Insert note into `notes` with embedding
7. Insert links into `links`
8. Reply: `✓ [title]\n\n[one-line summary]\n\nLinked to: [[A]], [[B]]` (omit last line if no links)

**Fast capture** (invoked with `/fast`):
1. Embed message text
2. Call LLM with minimal prompt: extract title, type, tags only — no related-note lookup, no link resolution
3. Insert note
4. Reply: `Stored: [title]`
Target: <3 seconds end-to-end.

**Capture agent system prompt (thoughtful mode):**
```
You are a knowledge capture agent following the Evergreen Notes methodology.
Transform raw input into a single, well-formed note and identify its typed
relationships to existing notes.

Rules:
- Title must be a claim or insight, not a topic label.
  Good: "Constraints make creative work stronger"
  Bad: "Creativity" or "Note about constraints"
- Body: 2–5 sentences, atomic. Preserve the user's voice and framing.
  Clean up stream-of-consciousness into coherent prose. Do not over-formalize.
- Type: one of idea | reflection | source | lookup
  reflection = first-person, personal insight about creativity or inner life;
               only use when the user's words explicitly signal personal resonance
  lookup = a research/investigation prompt; only if primarily investigative
  source = from an external source with a URL
  idea = everything else (default)
- Tags: 2–5 lowercase strings, no # prefix
- source_ref: URL if the user included one, otherwise null
- Links: for each related note provided, decide if a typed relationship applies.
  Types: extends | contradicts | supports | is-example-of
  Only link when the relationship is conceptually meaningful, not just topically similar.
  It is fine to link to zero notes.
- If the input is genuinely too short to form a useful note, do your best.
  Do not ask for clarification — just capture what is there.

Return valid JSON only. No text outside the JSON object.
{
  "title": "...",
  "body": "...",
  "type": "idea|reflection|source|lookup",
  "tags": ["...", "..."],
  "source_ref": null,
  "links": [
    { "to_id": "<uuid>", "link_type": "extends|contradicts|supports|is-example-of" }
  ]
}
```

---

### MCP Interface (Phase 2 — for reference, do not build in Phase 1)

Edge Function: `contemplace-mcp`
Auth: `MCP_ACCESS_KEY` via `?key=` query param or `x-brain-key` header

Tools:
- `search_notes(query, limit=10, threshold=0.5, filter_type?, filter_source?)` — embed query, call `match_notes` RPC
- `get_note(id_or_title)` — fetch note + its links
- `list_notes(limit=20, filter_type?, filter_source?, filter_tags?, date_from?, date_to?)` — filtered listing
- `capture_note(body, type, tags, source_ref?)` — same pipeline as thoughtful capture, source tagged `"mcp"`

MCP URL: `https://YOUR_PROJECT_REF.supabase.co/functions/v1/contemplace-mcp?key=YOUR_KEY`

---

### Phase 1 Scope

**Build:** Supabase schema, Telegram bot, `ingest-telegram` Edge Function (both capture modes), confirmation reply.
**Done when:** 5 real messages sent from Telegram produce correctly structured notes in the database with confirmations received, within 8 seconds each.
**Defer:** MCP server, image handling, clarification loop, voice transcription, scheduled gardening.

---

### Hard Constraints

1. **Embedding dimension is 1024** (`voyage/voyage-3`). Do not use 1536.
2. **All AI calls via OpenRouter.** Base URL: `https://openrouter.ai/api/v1`. Use OpenAI-compatible SDK.
3. **All DB access uses `SUPABASE_SERVICE_ROLE_KEY`**, never the anon key.
4. **Use `<=>` operator** for cosine distance in pgvector (not `<->` which is L2).
5. **Source field is always set** at insert — never null.
6. **Deploy Edge Functions with `--no-verify-jwt`** — we handle auth ourselves.
7. **Register Telegram webhook after deploying the function**, not before.

---

### Registering the Telegram Webhook

```
https://api.telegram.org/bot{TOKEN}/setWebhook
  ?url=https://YOUR_REF.supabase.co/functions/v1/ingest-telegram
  &secret_token=YOUR_WEBHOOK_SECRET
```

Verify: `https://api.telegram.org/bot{TOKEN}/getWebhookInfo`

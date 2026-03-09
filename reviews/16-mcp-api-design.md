# Phase 2a API Design Review — MCP Tool Interface Contract

## Design Principles

Tool descriptions are written for an LLM, not for a developer. An agent reads `description` to decide which tool to call and how — write it as a clear, direct explanation of what the tool does and when to use it. Do not write API documentation prose.

Return `score` in search results. An agent that can see a score of 0.91 versus 0.63 makes better relevance decisions than one that receives an unlabeled ranked list.

Omit verbosity from list/search results. `raw_input` and `embedding` are excluded from search and list responses — they are large and rarely useful in aggregate. `get_note` includes `raw_input` (single note, manageable, important for agents that need to see the user's exact words).

Pagination is not needed in Phase 2a. Personal note volume is manageable with `limit` params.

---

## Tool Definitions

### 1. `search_notes`

**Description for agent:**
> "Search your personal notes by semantic similarity to a query. Embeds the query text and matches against stored notes using vector similarity. Use filter_type or filter_intent to narrow results. Returns ranked results with similarity scores — a score above 0.75 is a strong match, 0.60–0.75 is moderate, below 0.60 may be loosely related."

**Input schema:**

```typescript
{
  query: string,              // required — natural language search query, max 1000 chars
  limit?: number,             // default 5, max 20 — number of results to return
  threshold?: number,         // default 0.60, range [0.0, 1.0] — minimum similarity score
  filter_type?: "idea" | "reflection" | "source" | "lookup",
  filter_intent?: "reflect" | "plan" | "create" | "remember" | "reference" | "log",
  filter_tags?: string[]      // array of tag strings — notes must contain all listed tags
}
```

**Process:**
1. Validate `query` length (max 1000 chars)
2. Clamp `limit` to [1, 20], `threshold` to [0.0, 1.0]
3. Validate enum values for `filter_type`, `filter_intent`
4. Call `embedText(query)` via OpenRouter
5. Call `match_notes(embedding, threshold, limit, filter_type, filter_intent, filter_tags, null, true)` RPC
6. Return formatted results

**Output shape:**

```typescript
{
  results: Array<{
    id: string,           // UUID
    title: string,
    body: string,
    type: string,
    intent: string,
    tags: string[],
    score: number,        // similarity score from match_notes
    created_at: string    // ISO 8601
  }>,
  count: number           // number of results returned
}
```

**Warning to document in description:** A threshold below 0.40 will return noise. Agents should use the default unless they have a specific reason to lower it.

---

### 2. `get_note`

**Description for agent:**
> "Fetch a single note by its UUID, including the full body, all metadata, and any links to other notes. Use this after search_notes to get complete content and context for a specific note. The raw_input field contains the user's original unedited words."

**Input schema:**

```typescript
{
  id: string    // required — UUID of the note
}
```

**Validation:** Check UUID format with `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` before DB call. Return `isError: true` if invalid.

**Process:**
1. Validate UUID format
2. Fetch note from `notes` table by `id`
3. Fetch links from `links` table where `from_id = id` OR `to_id = id`, joined with linked note title
4. Return combined result

**Output shape:**

```typescript
{
  id: string,
  title: string,
  body: string,
  type: string,
  intent: string,
  modality: string,
  tags: string[],
  entities: Array<{ name: string, type: string }>,
  corrections: string[] | null,
  raw_input: string,            // user's original words — included here, not in list/search
  source: string,
  created_at: string,
  links: Array<{
    to_id: string,
    to_title: string,           // joined from the linked note
    link_type: string,
    context: string | null,
    direction: "outbound" | "inbound"  // whether this note is from_id or to_id
  }>
}
```

If the note does not exist: return `isError: true`, `"Note not found: <id>"`.

---

### 3. `list_recent`

**Description for agent:**
> "List the most recently created notes, newest first. Use filter_type or filter_intent to focus on a specific kind of note — for example, filter_intent=plan to see everything the user is currently planning."

**Input schema:**

```typescript
{
  limit?: number,             // default 10, max 50
  filter_type?: "idea" | "reflection" | "source" | "lookup",
  filter_intent?: "reflect" | "plan" | "create" | "remember" | "reference" | "log"
}
```

**Process:**
1. Clamp `limit` to [1, 50]
2. Validate enum values
3. Query `notes` table ordered by `created_at DESC` with optional `WHERE type = ?` and/or `WHERE intent = ?`
4. Return results

**Output shape:**

```typescript
{
  notes: Array<{
    id: string,
    title: string,
    body: string,
    type: string,
    intent: string,
    tags: string[],
    created_at: string
  }>,
  count: number
}
```

Same shape as `search_notes` results but without `score` — there is no ranking concept here, just recency order.

---

### 4. `get_related`

**Description for agent:**
> "Get all notes linked to a given note, in both directions. Returns the linked notes along with the link type and any context note recorded when the link was created. Useful for traversing the note graph — following extends/contradicts/supports/is-example-of relationships."

**Input schema:**

```typescript
{
  id: string,        // required — UUID of the source note
  limit?: number     // default 10, max 50 — total links returned across both directions
}
```

**Validation:** UUID format check on `id` before DB call.

**Process:**
1. Validate UUID format
2. Query `links` where `from_id = id` → these are outbound links (this note links TO others)
3. Query `links` where `to_id = id` → these are inbound links (other notes link TO this one)
4. For each linked note UUID, fetch `id`, `title`, `body`, `type`, `intent` from `notes`
5. Combine, apply limit, return

**Output shape:**

```typescript
{
  source_id: string,
  links: Array<{
    note: {
      id: string,
      title: string,
      body: string,
      type: string,
      intent: string
    },
    link_type: string,          // extends | contradicts | supports | is-example-of | is-similar-to | ...
    context: string | null,     // explanation recorded at link creation time
    confidence: number | null,  // null for manually created links
    created_by: string,         // "capture" | "gardener" | "user"
    direction: "outbound" | "inbound"
  }>,
  count: number
}
```

If the note does not exist: return `isError: true`. If the note exists but has no links: return an empty array (not an error).

---

### 5. `capture_note`

**Description for agent:**
> "Create a new note by running the full capture pipeline. The text is embedded, matched against related notes for context, and structured by the AI capture agent (title, body, type, intent, tags, entities, links). The result is permanently stored. Use the source parameter to record where this note came from — for example, 'obsidian', 'notion', 'readwise', or 'manual'. This tool has a side effect: it creates a real, persistent note."

**Input schema:**

```typescript
{
  text: string,        // required — raw text to capture, max 4000 chars
  source?: string      // default "mcp" — provenance label, max 100 chars, [a-zA-Z0-9_-] only
}
```

**Process:**
1. Validate `text` length (max 4000 chars) — return `isError: true` if exceeded
2. Validate and sanitize `source` (default `"mcp"`, reject invalid chars)
3. Run the full capture pipeline **synchronously** (no `ctx.waitUntil()` deferral):
   a. In parallel: `embedText(text)`, `getCaptureVoice()`, send no typing indicator (MCP has no equivalent)
   b. `match_notes(embedding, threshold, 5, null, null, null, null, true)`
   c. Call capture LLM with system frame + capture voice + text + related notes + today's date
   d. Parse JSON response, apply fallback defaults on validation failure
   e. Re-embed with `buildEmbeddingInput()` — on failure, fall back to raw embedding
   f. Insert into `notes` with `source = source_param`, `raw_input = text`
   g. Insert links into `links` table
   h. Insert enrichment log rows
4. Return the created note summary

**Synchronous vs async decision:** The Telegram handler is async because Telegram requires a 200 response in under a few seconds. MCP clients block and wait for the tool result. Running synchronously is correct here — the pipeline takes 2–4 seconds and the client expects a result. Do not use `ctx.waitUntil()` in the MCP tool handler.

**Output shape:**

```typescript
{
  id: string,
  title: string,
  body: string,
  type: string,
  intent: string,
  tags: string[],
  links_created: number,    // number of links inserted
  source: string
}
```

Enough for the agent to confirm what was stored and reference the note by ID in subsequent calls.

On LLM failure: return `isError: true`, `"Capture failed: could not generate structured note."`. Log full error. Do not create a partial note.

On DB insert failure after successful LLM call: return `isError: true`, `"Capture failed: could not store note."`. Log full error.

---

## Cross-Cutting Design Notes

### Tool descriptions are read by the LLM

The `description` field in each tool definition is what Claude (or any other LLM) reads when deciding which tool to call. Write them as direct, informative explanations — not marketing copy, not API reference prose. Include:
- What the tool does
- When to use it
- Any important caveats (side effects, limits, what score values mean)

### Score field in search results

Include `score` in `search_notes` results. An agent reasoning about whether a result is relevant benefits from seeing the actual similarity value. A score of 0.92 is strong evidence; a score of 0.61 is weak. Without the score, the agent can only see rank position — it cannot distinguish "all results are highly relevant" from "only the first result matters."

### Omitting `raw_input` from list/search results

`raw_input` is included in `get_note` but excluded from `search_notes` and `list_recent`. The raw input can be verbose (full voice dictation, long text). Including it in list results would bloat responses significantly for no benefit — an agent that needs the raw text can call `get_note` with the ID.

### `entities` field as a search surface

The `entities` field is not exposed as a separate filter parameter in Phase 2a. Agents that want to find notes about a specific person, tool, or project should use `search_notes` with the entity name in the query string. The semantic embedding captures entity mentions effectively. A dedicated `filter_entity` parameter can be added in Phase 3 if needed.

### Bulk import pattern

The `capture_note` tool enables importing notes from other systems via a loop of calls:

```python
for note in obsidian_notes:
    client.call_tool("capture_note", {
        "text": note.content,
        "source": "obsidian"
    })
```

This runs the full capture pipeline on each note — it is not a raw import. Each Obsidian note will be re-structured and re-titled by the capture LLM. The `raw_input` column preserves the original. This is intentional: ContemPlace's value is the structured, embedded representation, not a file mirror.

If the user wants a raw import without LLM processing, that is a different use case not covered by Phase 2a. It would require a direct DB insert tool, which bypasses the capture pipeline entirely.

### What agents can do with these tools

- "Recall everything I've written about product design" → `search_notes({ query: "product design" })`
- "What am I currently planning?" → `list_recent({ filter_intent: "plan", limit: 20 })`
- "What are all the notes connected to this one?" → `get_related({ id: "<uuid>" })`
- "Show me the full note and its context" → `get_note({ id: "<uuid>" })` (includes links and raw_input)
- "Import my Obsidian vault" → loop of `capture_note` calls with `source: "obsidian"`
- "What notes do I have about specific people?" → `search_notes({ query: "person name" })` — entity mentions are embedded
- "Save this conversation insight" → `capture_note({ text: "...", source: "claude-session" })`

### Pagination

Not implemented in Phase 2a. The `limit` parameter on each tool is sufficient for personal note volume (hundreds to low thousands of notes). If the collection grows to tens of thousands, add cursor-based pagination in Phase 3 using `created_at` as the cursor anchor.

### Date filtering

Not in Phase 2a. `list_recent` provides time-ordered access. Specific date range queries (`"notes from last week"`) are deferred to Phase 3. An agent can approximate this by calling `list_recent` with a high limit and filtering by `created_at` client-side.

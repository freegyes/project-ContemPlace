# Phase 2a Security Review — MCP Server

## Threat Model

This is a personal, single-user system. The MCP server exposes read and write access to the note database. The relevant threats are: unauthorized access by external parties, injection via agent-supplied inputs, and accidental data corruption via the write tool. Multi-user isolation, OAuth flows, and audit compliance are out of scope.

---

## API Key Authentication

**Single API key is appropriate.** One user, one key. The key is validated on every request before any processing.

Key requirements:
- Generate with `openssl rand -hex 32` (256-bit entropy). Document this in setup instructions.
- Store as a Wrangler secret: `wrangler secret put MCP_API_KEY -c mcp/wrangler.toml`. Never in `wrangler.toml`, never in source code.
- Add `MCP_API_KEY=<placeholder>` to `.dev.vars.example`. Add the real value to `.dev.vars` (gitignored).

**Key must never appear in logs.** The auth middleware validates the key and discards it. No logging of request headers, no logging of the key value in any error path. If auth fails, log `"Auth failed: missing/invalid token"` — not the received token value.

**Key rotation:** Generate a new key, run `wrangler secret put MCP_API_KEY`, redeploy. Update Claude Desktop / Cursor config. No DB changes needed.

---

## Input Validation

Validate all tool inputs before they reach the database or LLM.

### UUIDs

Any `id` parameter (`get_note`, `get_related`) must match the standard UUID format before being used in a DB call. Validate with a regex: `/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i`. Return a tool-level error with `isError: true` if the format is invalid — do not let the raw string reach the Supabase client.

### Numeric limits

| Parameter | Default | Max | Behavior on overflow |
|---|---|---|---|
| `search_notes.limit` | 5 | 20 | Clamp to max, do not error |
| `list_recent.limit` | 10 | 50 | Clamp to max |
| `get_related.limit` | 10 | 50 | Clamp to max |
| `search_notes.threshold` | 0.60 | 1.0 | Clamp to [0.0, 1.0] |

### Text inputs

`capture_note.text`: cap at 4000 characters. Return `isError: true` if exceeded. This matches the token budget constraint of the capture LLM and prevents runaway costs from a malformed agent loop.

`search_notes.query`: cap at 1000 characters. A longer query is almost certainly a bug or abuse.

`capture_note.source`: cap at 100 characters, allow only `[a-zA-Z0-9_-]`. Default to `"mcp"` if not provided. This value is stored in the `notes.source` column and used for provenance tracking — it must not be attacker-controlled freeform text embedded into any system prompt or SQL.

### Enum values

`filter_type`, `filter_intent` must be validated against the known enum sets before being passed to the RPC. Invalid values return `isError: true`. Valid sets:
- `filter_type`: `idea`, `reflection`, `source`, `lookup`
- `filter_intent`: `reflect`, `plan`, `create`, `remember`, `reference`, `log`

---

## Injection Risks

### SQL injection

The Supabase JS client uses parameterized queries. Tool inputs are passed as method arguments to `.select()`, `.eq()`, `.rpc()` — never interpolated into raw SQL strings. This is the same posture as the capture worker.

**JSONB columns** (`entities`, `metadata`) contain LLM-generated content. This content is read from the DB and returned to the MCP client as JSON — it is never re-interpolated into SQL. No injection surface here.

**Hard constraint (carry over from CLAUDE.md):** Never interpolate JSONB column values or MCP tool inputs into raw SQL strings. If a future query requires dynamic SQL, use the Supabase RPC approach with named parameters.

### Prompt injection via `capture_note`

An agent calling `capture_note` passes `text` to the capture LLM. A malicious or misconfigured agent could pass prompt injection payloads in `text`. The LLM processes this as user input, not as a system instruction — the system frame is fixed in code and cannot be overridden by the `text` field. The worst realistic outcome is a garbled or misleading note being stored. Mitigations:

1. The `source` field records provenance. Notes created via MCP are distinguishable from Telegram notes.
2. The 4000-character cap limits the surface area.
3. The `raw_input` column preserves the original text — if a bad note is detected, the source is visible.

There is no server-side defense against an agent that the user themselves configured sending garbage. That is an agent design problem, not a security problem.

### LLM-generated content in responses

The MCP server returns note titles, bodies, and entities to the MCP client. These were written by the capture LLM based on the user's input. An MCP client (like Claude Desktop) will present this content to the user or use it in further reasoning. There is a theoretical second-order prompt injection risk: a note whose body contains adversarial text that influences the downstream agent. This is a known MCP ecosystem risk, not specific to this implementation. Mitigations are the responsibility of the MCP client, not this server.

---

## CORS

The MCP server is a Cloudflare Worker with an HTTP endpoint. MCP clients (Claude Desktop, Cursor, agent scripts) are not browsers — they do not enforce CORS. Browser clients are not expected in Phase 2a.

Set permissive CORS headers for `OPTIONS` preflight responses to avoid issues if browser-based tooling is introduced later:

```
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: POST, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
```

Do not expose internal error details via CORS headers. If restricting to specific origins becomes necessary (Phase 3 web client), add an allowlist at that point.

---

## Rate Limiting

Cloudflare Workers rate limiting via WAF is available on paid plans. The free tier does not offer per-route rate limiting built in.

For Phase 2a (personal system, known clients):

- The system does not implement application-level rate limiting.
- Cloudflare's DDoS protection at the edge applies to all Workers by default.
- Log excessive call patterns to console for manual detection.
- The `capture_note` tool calls OpenRouter (LLM + embedding) — runaway agent loops will be visible in OpenRouter billing before causing significant damage.

If rate limiting becomes necessary: use Cloudflare Workers KV to track per-IP or per-token call counts, or upgrade to a paid Cloudflare plan and configure WAF rate limiting rules. Document this as a future option but do not implement in Phase 2a.

---

## The `capture_note` Write Surface

`capture_note` runs the full capture pipeline: embed → find related → LLM → insert note. This is the same code path as the Telegram handler. The security posture is identical:

- LLM call goes to OpenRouter (authenticated with `OPENROUTER_API_KEY`). Input is the user-supplied `text` — the same risk as any Telegram message.
- DB insert uses the Supabase service role key with parameterized queries.
- The `source` field is set to the caller-supplied value (validated and sanitized as described above). This field makes MCP-created notes distinguishable in the database.

One additional consideration: the Telegram handler silently discards unauthorized chat IDs. The MCP `capture_note` tool has no equivalent guard because the entire endpoint is already API-key-gated. Any holder of the API key can create notes. This is correct for a single-user system.

**Size cap is the primary protection.** A 4000-character limit prevents an agent from creating arbitrarily large notes that could affect DB performance or consume excessive embedding/LLM tokens.

---

## Secret Management Summary

| Secret | Storage | Notes |
|---|---|---|
| `MCP_API_KEY` | `wrangler secret put` + `.dev.vars` | 256-bit. Never logged. |
| `SUPABASE_SERVICE_ROLE_KEY` | `wrangler secret put` + `.dev.vars` | Same key as capture worker. Server-side only. |
| `OPENROUTER_API_KEY` | `wrangler secret put` + `.dev.vars` | Same key as capture worker. |
| `SUPABASE_URL` | `wrangler.toml` (non-secret) | Not sensitive. |

The MCP Worker and the capture Worker share `SUPABASE_SERVICE_ROLE_KEY` and `OPENROUTER_API_KEY`. Both are server-side Workers with no public key exposure. Sharing is safe. If the MCP Worker is ever compromised, rotate both keys and redeploy both Workers.

The service role key is never used client-side. The Supabase anon key is never used in this system (capture worker constraint carried forward).

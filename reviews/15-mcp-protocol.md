# Phase 2a Protocol Review — MCP Spec and Client Compatibility

## MCP Spec Version

This implementation targets **MCP spec version 2025-03-26** (the latest stable release as of Phase 2a). Use this version string in the `initialize` handshake. The spec is at `https://spec.modelcontextprotocol.io`.

---

## Transport: Streamable HTTP

Streamable HTTP is the recommended remote transport in the 2025 MCP spec. It supersedes the earlier SSE-based remote transport. Key properties:

- **Single endpoint:** all communication goes to `POST /mcp`. No separate SSE stream endpoint.
- **Request format:** JSON-RPC 2.0 body. `Content-Type: application/json`.
- **Response format:** the server chooses between:
  - `Content-Type: application/json` — for synchronous request/response (one JSON-RPC response per request)
  - `Content-Type: text/event-stream` — for streaming responses (server sends multiple SSE events before closing)
- **Phase 2a uses application/json for all responses.** None of the five tools need streaming. Search results, note fetches, and even `capture_note` return a single result object. Streaming adds complexity with no benefit here.
- **Stateless per request.** No session state is maintained between requests. No cookies, no session tokens, no server-side connection tracking.

### Why not stdio?

stdio transport works by spawning a subprocess and communicating over stdin/stdout. It requires the MCP server process to run on the same machine as the client. Claude Desktop on Mac can run a local stdio MCP server, but cloud agents, Cursor running in a remote environment, and any future web-based tooling cannot. Remote HTTP is the correct default for a system designed for "various environments."

A stdio shim can be added later as a thin wrapper that reads from stdin, calls the HTTP endpoint with the API key, and writes to stdout. This requires no changes to the MCP server code.

---

## JSON-RPC 2.0 Message Format

All MCP messages follow JSON-RPC 2.0.

**Request:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "tools/call",
  "params": { "name": "search_notes", "arguments": { "query": "..." } }
}
```

**Success response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": { ... }
}
```

**Error response:**
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "error": { "code": -32601, "message": "Method not found" }
}
```

Standard error codes:

| Code | Meaning | When to use |
|---|---|---|
| `-32700` | Parse error | Malformed JSON in request body |
| `-32600` | Invalid request | Missing `jsonrpc`, `method`, or `id` |
| `-32601` | Method not found | Unknown method string |
| `-32602` | Invalid params | Missing required params, wrong types |
| `-32603` | Internal error | Unhandled server exception |

Tool-level errors (note not found, validation failure, DB error) are **not** JSON-RPC errors. They are returned as a successful JSON-RPC response with `isError: true` in the tool result. This is the MCP convention — the protocol layer succeeded, the tool itself reported a problem.

---

## Required MCP Lifecycle

The MCP client initiates with an `initialize` request before calling any tools. The server must handle this correctly or clients will refuse to proceed.

### `initialize`

**Request params:**
```json
{
  "protocolVersion": "2025-03-26",
  "clientInfo": { "name": "claude-desktop", "version": "..." }
}
```

**Response result:**
```json
{
  "protocolVersion": "2025-03-26",
  "serverInfo": { "name": "contemplace-mcp", "version": "1.0.0" },
  "capabilities": {
    "tools": {}
  }
}
```

`capabilities.tools` being present (even as an empty object) signals that this server supports the `tools/list` and `tools/call` methods. If the client requests a protocol version the server does not support, the server should respond with the version it does support and the client may choose to abort.

### `tools/list`

**Request:** `{ "method": "tools/list", "params": {} }`

**Response result:**
```json
{
  "tools": [
    {
      "name": "search_notes",
      "description": "...",
      "inputSchema": {
        "type": "object",
        "properties": { ... },
        "required": [...]
      }
    },
    ...
  ]
}
```

Return all five tools in every `tools/list` response. There is no tool versioning or conditional availability in Phase 2a.

### `tools/call`

**Request:**
```json
{
  "method": "tools/call",
  "params": {
    "name": "search_notes",
    "arguments": { "query": "product design ideas" }
  }
}
```

**Success response result:**
```json
{
  "content": [
    { "type": "text", "text": "{\"results\": [...]}" }
  ],
  "isError": false
}
```

**Tool error response result:**
```json
{
  "content": [
    { "type": "text", "text": "Note not found: <id>" }
  ],
  "isError": true
}
```

The `content` array must always contain at least one item of type `"text"`. The `text` field contains a JSON string for structured results, or a plain error message string for errors. Clients parse the `text` field — return well-formed JSON so that capable clients can process results programmatically.

### `notifications/initialized`

After receiving the `initialize` response, some clients send a `notifications/initialized` notification (no `id`, no response expected). The server must accept this without error. Handle it by returning `204 No Content` or an empty 200. Do not return a JSON-RPC error for notifications.

---

## Client Compatibility Matrix

### Claude Desktop (Mac)

- Supports both stdio and remote HTTP MCP servers.
- Remote HTTP: configured via `claude_desktop_config.json` with `url` and `headers` fields. The `Authorization: Bearer <key>` header is sent with every request.
- Compatible with Streamable HTTP transport.
- The tool list is fetched on startup. Changes to tool definitions require restarting Claude Desktop.
- **Compatible. Recommended primary client.**

### Cursor

- Supports stdio and remote HTTP MCP servers.
- Configuration: Settings → MCP → Add Server → type HTTP, enter URL and headers.
- Compatible with Streamable HTTP transport.
- **Compatible.**

### Custom agents using `@modelcontextprotocol/sdk` (Node.js)

- The official TypeScript SDK supports Streamable HTTP transport via `StreamableHTTPClientTransport`.
- Agents implement the MCP client protocol using the SDK, connect to the server URL, and call tools programmatically.
- **Compatible.**

### Python agents using `mcp` package

- The official Python SDK supports HTTP transport.
- **Compatible.**

### Claude.ai web (claude.ai)

- Does not support custom MCP servers as of 2025. Users cannot connect third-party MCP servers to claude.ai.
- **Not supported. Out of scope.**

### Claude API (Anthropic API directly)

- The Claude API does not natively speak MCP. Agents using the API must implement an MCP client themselves (using the SDK) and bridge tool calls between the Claude API tool-use format and MCP protocol.
- This is a valid pattern for custom agents but requires client-side implementation effort.
- **Indirect support. Works if the agent implements the MCP client.**

---

## The `capture_note` Tool as a Write Surface

MCP tools performing side effects (creating data, sending messages, modifying state) are normal and expected in the MCP spec. The spec does not distinguish read-only from read-write tools at the protocol level. Clients are expected to present tool calls to users before execution when running in interactive mode.

The `capture_note` tool creates a real note in the database. Its description must make this explicit:

> "Create a new note by running the full capture pipeline. The text is embedded, matched against related notes, and structured by the AI capture agent. The note is permanently stored. Use the source parameter to record the origin (e.g., 'obsidian', 'notion', 'manual')."

This makes the side effect visible to both the agent (which reads the description) and the user (who sees the tool call in Claude Desktop or Cursor before confirming).

---

## Error Handling Patterns

**Validation failures** (bad UUID format, text too long, unknown enum value): return `isError: true` with a descriptive message. Do not throw a JSON-RPC error — the protocol layer worked fine.

**Note not found** (`get_note` with a valid UUID that doesn't exist in the DB): return `isError: true`, message `"Note not found: <id>"`.

**DB errors** (Supabase connection failure, RPC error): return `isError: true`, message `"Database error. Try again."`. Log full error to console.

**LLM errors** (OpenRouter rate limit, timeout, invalid response): for `capture_note`, return `isError: true`, message `"Capture failed: LLM error. Try again."`. Log details.

**Unhandled exceptions**: return JSON-RPC error `{ code: -32603, message: "Internal error" }`. Log full stack trace.

Never propagate raw Supabase or OpenRouter error messages to the client — they may contain internal details.

---

## Session Management

Streamable HTTP is stateless per request. Each `POST /mcp` is an independent transaction. There is no session ID, no connection state, no in-memory session store. The `initialize` handshake is done on every new client session but the server does not retain any per-client state between requests.

This is the correct design for a Cloudflare Worker (V8 isolate per request, no persistent memory).

---

## Future: stdio Wrapper

If remote network latency becomes a problem for local Claude Desktop use, a stdio shim can be built without changing the server. The shim would:

1. Start as a process (Node.js or Python script)
2. Read JSON-RPC messages from stdin
3. Forward them to the HTTP endpoint with the API key header
4. Write responses to stdout

This keeps all business logic in the Worker. The shim is ~50 lines of code. It can be added in Phase 3 if needed without any server-side changes.

# Phase 2c — OAuth 2.1 for MCP Web Connectors

**GitHub issue:** #5
**Branch:** `feat/phase-2c-oauth` (not started)
**Status:** Planning — specialist research complete, implementation plan revised
**Last updated:** 2026-03-10

---

## Why OAuth, and why now

Phase 2a shipped a static Bearer token (`MCP_API_KEY`) that works correctly for:
- Claude Code CLI (`--header "Authorization: Bearer <key>"`)
- Anthropic API (`authorization_token` field on the MCP connector)
- OpenAI Responses API (same pattern)

It does **not** work with **browser-based connectors** — Claude.ai web, Cursor IDE, ChatGPT web — all of which require OAuth 2.1 Authorization Code + PKCE. There is no field for a static Bearer token in these UIs. The server must implement OAuth or the web connector will not connect.

---

## MCP authorization spec evolution

The plan must target the **current spec (2025-11-25 / draft)**, not the older March 2025 version. Key changes:

| Date | What changed |
|---|---|
| 2025-03-26 | First OAuth spec. MCP server = authorization server. Discovery via RFC 8414 only. DCR SHOULD. |
| 2025-06-18 | MCP server reclassified as OAuth **resource server**. Protected Resource Metadata (RFC 9728) becomes MUST. Resource Indicators (RFC 8707) becomes MUST for clients. Fallback default endpoints removed. |
| 2025-11-25 | Client ID Metadata Documents (CIMD) preferred. DCR downgraded to MAY. OpenID Connect Discovery added alongside RFC 8414. |

Claude.ai currently supports both the 3/26 and 6/18+ flows, so old-style works today. But Cursor follows 6/18+, and future Claude.ai versions will likely drop 3/26 support. **Implement for the current spec.**

---

## Discovery flow (two-layer, updated)

The previous plan described a single-layer flow (client fetches `/.well-known/oauth-authorization-server` directly). The current spec requires two layers:

1. Client POSTs to `/mcp`, gets HTTP **401** with `WWW-Authenticate: Bearer resource_metadata="https://mcp-contemplace.adamfreisinger.workers.dev/.well-known/oauth-protected-resource"`
2. Client GETs `/.well-known/oauth-protected-resource` (RFC 9728) — returns `authorization_servers` array
3. Client GETs `/.well-known/oauth-authorization-server` from the AS URL found in step 2 (RFC 8414)
4. Client proceeds with DCR (or uses pre-registered credentials)
5. Client initiates Authorization Code + PKCE

Since ContemPlace is its own authorization server (same origin), both `.well-known` endpoints live on the same Worker. The `workers-oauth-provider` library serves both automatically.

---

## Connector compatibility matrix (updated)

| Client | Auth mechanism | Works today? | After Phase 2c? | Notes |
|---|---|---|---|---|
| Claude Code CLI `--header` | Static Bearer token | Yes | Yes | Unchanged |
| Claude Code CLI OAuth | Auth Code + PKCE (browser) | No | Yes | Requires DCR; localhost redirect |
| Anthropic API `authorization_token` | Static Bearer token | Yes | Yes | Unchanged |
| Claude.ai web connector | Auth Code + PKCE | No | Yes | Redirect: `https://claude.ai/api/mcp/auth_callback` |
| ChatGPT Developer Mode | Auth Code + PKCE | No | Yes | **Requires DCR** (no manual credential entry) |
| OpenAI Responses API | Static Bearer token | Yes | Yes | Unchanged |
| Cursor | Auth Code + PKCE | No | Yes | Requires DCR; `cursor://` redirect scheme |

---

## Decision: Enable DCR (revised from original plan)

**Original plan: skip DCR.** Research overturns this.

Without DCR:
- ChatGPT cannot connect (no UI for manual credentials)
- Claude Code CLI errors: "Incompatible auth server: does not support dynamic client registration"
- Cursor connection is problematic

With DCR (via `workers-oauth-provider`):
- Zero-config for all clients
- No pre-shared secrets to manage
- Clients register their own redirect URIs (solves the multi-redirect-URI problem)
- The library handles it automatically — one config line: `clientRegistrationEndpoint: "/register"`

**Revised decision: enable DCR.** `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` secrets are no longer needed. Remove from the plan.

---

## Library: `@cloudflare/workers-oauth-provider`

### How it works

The library **takes over the entire fetch handler**. The current `export default { fetch() { ... } }` pattern must be restructured:

```typescript
import { OAuthProvider } from "@cloudflare/workers-oauth-provider";

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: McpHandler,          // your JSON-RPC handler (WorkerEntrypoint class)
  defaultHandler: AuthHandler,     // consent page + non-API routes
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  accessTokenTTL: 3600,           // 1 hour
  refreshTokenTTL: 2592000,       // 30 days
  allowPlainPKCE: false,          // S256 only (OAuth 2.1 requirement)
  scopesSupported: ["mcp"],
  resourceMetadata: {              // RFC 9728 — served at /.well-known/oauth-protected-resource
    resource: "https://mcp-contemplace.adamfreisinger.workers.dev",
    authorization_servers: ["https://mcp-contemplace.adamfreisinger.workers.dev"],
    scopes_supported: ["mcp"],
    bearer_methods_supported: ["header"],
  },
});
```

### What the library handles automatically
- `GET /.well-known/oauth-authorization-server` — RFC 8414 metadata
- `GET /.well-known/oauth-protected-resource` — RFC 9728 resource metadata
- `POST /token` — code exchange + refresh
- `POST /register` — DCR (RFC 7591)
- PKCE validation (S256)
- Token hashing in KV (never stores plaintext tokens)
- Refresh token rotation
- 401 responses on unauthenticated `/mcp` requests with proper `WWW-Authenticate` header

### What you implement
- **Consent page** at `/authorize` (inside `defaultHandler`) — minimal HTML, "Approve" button
- **Static token fallback** — custom logic to keep `MCP_API_KEY` working alongside OAuth

### Token format
**Opaque tokens, not JWTs.** The library hashes tokens and stores grants in KV. Validation requires a KV lookup per request. For a single-user system with sub-ms KV cached reads, this is fine. The `props` field (arbitrary data passed at authorization time) is encrypted using the token as key material — forward-secure.

---

## Static token fallback design

The `workers-oauth-provider` returns 401 on unauthenticated `/mcp` requests. Static `MCP_API_KEY` callers would break.

**Solution:** Check for the static key in `defaultHandler` before OAuthProvider's API route validation kicks in. If a request to `/mcp` carries a Bearer token matching `MCP_API_KEY`, proxy it directly to the MCP handler without OAuth validation.

```
Request to /mcp:
  1. defaultHandler receives the request (since OAuthProvider routes non-authenticated /mcp to defaultHandler? — NO)
```

**Correction:** OAuthProvider routes `/mcp` requests to `apiHandler` only if they have a valid OAuth token. Without one, it returns 401. There is no interception point for static tokens in the standard flow.

**Options for static fallback:**

1. **Wrapper around OAuthProvider** — intercept fetch before it reaches OAuthProvider. If `Authorization: Bearer` matches `MCP_API_KEY`, bypass OAuth and call the MCP handler directly. Otherwise, delegate to OAuthProvider.
2. **Custom `apiHandler` that checks both** — the `apiHandler` receives requests with validated OAuth tokens. For static token callers, they'd still get 401 before reaching it.
3. **Separate route** — serve the MCP handler at both `/mcp` (OAuth-protected) and `/mcp-static` (static key). Ugly but simple.

**Recommended: Option 1.** Wrap the OAuthProvider:

```typescript
const oauthProvider = new OAuthProvider({ ... });

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    // Static Bearer token bypass for API/CLI callers
    if (isStaticTokenRequest(request, env)) {
      return handleMcpRequest(request, env);
    }
    // Everything else goes through OAuth
    return oauthProvider.fetch(request, env, ctx);
  }
};

function isStaticTokenRequest(request: Request, env: Env): boolean {
  if (new URL(request.url).pathname !== '/mcp') return false;
  const auth = request.headers.get('Authorization');
  if (!auth?.startsWith('Bearer ')) return false;
  // Use constant-time comparison
  return timingSafeEqual(auth.slice(7), env.MCP_API_KEY);
}
```

This preserves backward compatibility. Static key callers hit the same MCP handler. OAuth callers go through the full flow. The two paths are cleanly separated.

---

## Security decisions

### PKCE
- **S256 only.** Set `allowPlainPKCE: false`. OAuth 2.1 requires PKCE for all clients. `plain` is only for constrained devices that cannot do SHA-256. No MCP client sends `plain`.

### Redirect URI validation
- DCR handles this: clients register their own redirect URIs, and the library validates exact match on authorization requests.
- Known redirect URIs across clients:
  - Claude.ai: `https://claude.ai/api/mcp/auth_callback` (may become `https://claude.com/...`)
  - ChatGPT: `https://chatgpt.com/connector_platform_oauth_redirect`
  - Cursor: `cursor://anysphere.cursor-mcp/oauth/*/callback`
  - Claude Code CLI: `http://localhost:<port>/callback`
- The library accepts whatever the client registered. No hardcoding needed with DCR.

### Token lifetimes
- Access tokens: **1 hour** (default). Cursor has broken refresh token handling — tokens expire and Cursor shows "Logged out." Consider bumping to 8 hours if Cursor friction is unacceptable. Configurable via `accessTokenTTL`.
- Refresh tokens: **30 days**. Rotation is automatic in the library (new refresh token on each use).

### Refresh token rotation
- The library handles this. Old refresh token invalidated on each use.
- Reuse detection (replay of rotated-out token → revoke entire grant) is a follow-up if needed.

### Consent form CSRF
- The `/authorize` consent form should use `SameSite=Lax; Secure; HttpOnly` cookies for session state between form display and submission. Single-user system reduces risk, but good hygiene.

### Constant-time comparison
- Required for the static token fallback (`isStaticTokenRequest`). Use `crypto.subtle.timingSafeEqual` or equivalent.
- Not needed for OAuth tokens — the library handles validation via hash lookup.

---

## KV storage

### Why KV is fine
- `workers-oauth-provider` uses KV exclusively. Cloudflare's own library for their own platform — strong signal.
- Tokens stored as hashes only. Props encrypted with token as key material.
- AES-256-GCM encryption at rest.
- Read-your-own-write consistency restored at same PoP (August 2025 rearchitecture). The auth code exchange (write code → immediate read during `/token`) nearly always hits the same PoP.
- Per-key TTL maps directly to token lifetimes. No cleanup needed.
- Zero additional cost on free tier (100K reads/day, 1K writes/day).

### Setup
```bash
npx wrangler kv namespace create "OAUTH_KV"
# outputs: { binding = "OAUTH_KV", id = "<id>" }
```

Add to `mcp/wrangler.toml`:
```toml
[[kv_namespaces]]
binding = "OAUTH_KV"
id = "<created-namespace-id>"
```

### When KV might not be enough
The one theoretical risk: cross-PoP auth code exchange due to eventual consistency. Negligible for single-user where all requests originate from the same geographic location. If it ever becomes a problem, Durable Objects are the upgrade path — but the library doesn't support them, so this would require a fork.

---

## CORS

The existing MCP endpoint has CORS headers. The OAuth endpoints also need them:

- `/.well-known/oauth-protected-resource` — Claude.ai's browser JS fetches this cross-origin
- `/.well-known/oauth-authorization-server` — same
- `/token` — cross-origin POST from Claude.ai
- `/register` — cross-origin POST from Claude.ai
- `/authorize` — full page navigation, **not** a fetch — CORS not needed here

The library may handle CORS on its managed routes. Verify during implementation. If not, add CORS headers in the wrapper.

---

## Implementation plan (revised)

### Files to create
- `mcp/src/oauth.ts` — consent page HTML, `AuthHandler` class (defaultHandler), static token bypass helper
- `tests/mcp-oauth.test.ts` — unit tests for consent page, static token fallback, CORS

### Files to modify
- `mcp/wrangler.toml` — add KV binding
- `mcp/src/index.ts` — restructure: wrap OAuthProvider with static token bypass, move JSON-RPC handler into `WorkerEntrypoint` class
- `mcp/src/types.ts` — add `OAUTH_KV: KVNamespace` to `Env` interface
- `mcp/src/auth.ts` — keep `validateAuth` for the static path; add constant-time comparison
- `mcp/package.json` — add `@cloudflare/workers-oauth-provider` dependency

### Structural change to `mcp/src/index.ts`

Current:
```typescript
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // auth check, parse JSON-RPC, dispatch to handlers
  }
};
```

After:
```typescript
// McpHandler — WorkerEntrypoint class for OAuthProvider's apiHandler
class McpHandler extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    // Same JSON-RPC dispatch logic, moved here
    // this.ctx.props has OAuth user context
  }
}

// AuthHandler — defaultHandler for /authorize consent page
class AuthHandler extends WorkerEntrypoint {
  async fetch(request: Request): Promise<Response> {
    // /authorize → render consent page
    // POST /authorize → call completeAuthorization, redirect
    // everything else → 404
  }
}

// OAuthProvider instance
const oauthProvider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: McpHandler,
  defaultHandler: AuthHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  accessTokenTTL: 3600,
  refreshTokenTTL: 2592000,
  allowPlainPKCE: false,
  resourceMetadata: { ... },
});

// Wrapper: static token bypass + OAuth
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (isStaticTokenRequest(request, env)) {
      return handleMcpDirectly(request, env);
    }
    return oauthProvider.fetch(request, env, ctx);
  }
};
```

### Consent page (minimal)

Single-user system. The consent page:
1. Displays the client name (from DCR registration metadata or "Unknown client")
2. Shows "Authorize access to ContemPlace?"
3. One "Approve" button
4. On submit: calls `env.OAUTH_PROVIDER.completeAuthorization()` with a fixed user ID

No login form — the consent itself is the authentication gate. If you're seeing the page, you're the owner. For additional security, consider a shared secret (password field) or Cloudflare Access in front of `/authorize`.

### Routes (final)

| Route | Method | Handled by | Purpose |
|---|---|---|---|
| `/.well-known/oauth-protected-resource` | GET | Library (auto) | RFC 9728 resource metadata |
| `/.well-known/oauth-authorization-server` | GET | Library (auto) | RFC 8414 AS metadata |
| `/register` | POST | Library (auto) | DCR (RFC 7591) |
| `/authorize` | GET | You (AuthHandler) | Consent page |
| `/authorize` | POST | You (AuthHandler) | Consent submission → completeAuthorization |
| `/token` | POST | Library (auto) | Code exchange + refresh |
| `/mcp` | POST | Library → McpHandler | MCP JSON-RPC (OAuth-authenticated) |
| `/mcp` | POST | Static bypass | MCP JSON-RPC (MCP_API_KEY-authenticated) |

---

## Migration path (zero-downtime, revised)

1. **Install library, create KV namespace, restructure code** — local dev and unit tests
2. **Deploy with both auth paths live** (static key bypass + OAuth)
3. **Run existing smoke tests** — static key path must still pass
4. **Configure Claude.ai connector:** enter just the URL. With DCR, no client ID/secret needed.
5. **Walk through the OAuth flow** in the browser; verify Claude.ai can call tools
6. **Keep static key indefinitely** for Anthropic API and CLI `--header` callers. Do NOT retire `MCP_API_KEY` — it serves a different audience than OAuth.

**Change from original plan:** Step 6 originally said "remove static key fallback, retire MCP_API_KEY." This is wrong. API/SDK callers (Anthropic API, OpenAI Responses API) pass static tokens and never do OAuth. The static key path must remain permanently, not as a migration crutch but as the correct auth mechanism for machine-to-machine callers.

---

## Flagged risks and dubious decisions

### 1. Consent page is an open authorization gate
**Risk:** The consent page has no authentication. Anyone who navigates to `/authorize` can approve access. In practice, the approved token goes to the registered `redirect_uri` (which is the client's own domain), not to the attacker. But a sophisticated attack could register a malicious client via DCR with an attacker-controlled redirect URI.

**Mitigation options (pick one):**
- **(a)** Put Cloudflare Access in front of `/authorize` — requires the owner to authenticate via email/SSO before the consent page loads. Most secure.
- **(b)** Add a password field to the consent page — shared secret stored as a Worker secret.
- **(c)** Accept the risk — single-user system, DCR clients are logged, tokens are short-lived.

**Recommendation:** Start with (c), add (a) if the risk profile changes. Document the tradeoff.

### 2. Library is actively evolving
`@cloudflare/workers-oauth-provider` has open issues (#139–#162 as of March 2026). Breaking changes are possible. Pin the version in `package.json`. Watch the repo for releases.

### 3. Cursor's broken refresh tokens
Cursor does not properly use refresh tokens as of early 2026. When access tokens expire, users must reauthenticate manually. The 1-hour access token means Cursor users re-auth every hour. Options: bump `accessTokenTTL` to 28800 (8 hours) or 86400 (24 hours), or accept the friction and wait for Cursor to fix it.

### 4. ChatGPT's spec non-compliance
ChatGPT reportedly sends `GET /.well-known/oauth-authorization-server` directly, skipping Protected Resource Metadata (RFC 9728). The library serves both endpoints, so this works. But if ChatGPT skips `/register` too, it would need manual credentials — and there's no UI for that. Test empirically.

### 5. Static token bypass constant-time comparison
The `isStaticTokenRequest` function compares a Bearer token to `MCP_API_KEY`. Must use constant-time comparison (`crypto.subtle.timingSafeEqual`). A naive `===` leaks timing information. The Cloudflare Workers runtime supports `crypto.subtle` — confirm `timingSafeEqual` is available or use a polyfill.

### 6. `WorkerEntrypoint` availability
The `workers-oauth-provider` examples use `WorkerEntrypoint` classes. Verify this is available with `compatibility_date = "2024-01-01"` or bump it. May need `compatibility_date = "2024-09-23"` or later.

---

## Pre-flight checklist before implementation

- [ ] `npm install @cloudflare/workers-oauth-provider` — verify it installs cleanly, check version
- [ ] Read the library source for `OAuthProvider` constructor options — confirm `resourceMetadata`, `allowPlainPKCE`, `refreshTokenTTL` behave as documented
- [ ] Confirm `WorkerEntrypoint` is available at the current `compatibility_date`
- [ ] Create KV namespace: `npx wrangler kv namespace create OAUTH_KV`
- [ ] Verify `crypto.subtle.timingSafeEqual` exists in the Workers runtime (or find a polyfill)
- [ ] Check if the library adds CORS headers to `/.well-known/*` and `/token` routes, or if we need to add them
- [ ] Confirm the library's 401 response includes `WWW-Authenticate` header with `resource_metadata` URL (RFC 9728 requirement)
- [ ] Decide on consent page auth: open gate (c), password (b), or Cloudflare Access (a)

---

## Open questions resolved

| Question | Original answer | Revised answer |
|---|---|---|
| Skip DCR? | Yes, skip | **No — enable DCR.** Required for ChatGPT, Claude Code CLI, Cursor. Library handles it. |
| Consent page UX? | Minimal "Approve" button | Same, but note the open-gate security tradeoff. |
| Token lifetime? | 1h access / 30d refresh | Same, but monitor Cursor's broken refresh handling. May bump access to 8h. |
| Token format? | "Signed JWTs" | **Opaque tokens.** Library uses hash-based KV lookup, not JWTs. |
| Redirect URI handling? | Hardcode Claude.ai callback | **DCR handles it.** Clients register their own redirect URIs. |
| Discovery endpoint? | `/.well-known/oauth-authorization-server` only | **Both:** `/.well-known/oauth-protected-resource` (RFC 9728) + `/.well-known/oauth-authorization-server` (RFC 8414). Library serves both. |
| Retire `MCP_API_KEY`? | Yes, after OAuth confirmed | **No — keep permanently.** Static tokens are the correct auth for API/SDK callers. |

---

## Why this wasn't in Phase 2a

Phase 2a targeted AI agent access via Claude API and Claude Code CLI — both work with static Bearer tokens. The OAuth complexity wasn't justified for that scope. It became apparent only when trying to connect via the Claude.ai web UI, which requires a full interactive OAuth flow.

---

## Spec references

- [OAuth 2.1 Draft (draft-ietf-oauth-v2-1-15)](https://datatracker.ietf.org/doc/draft-ietf-oauth-v2-1/)
- [RFC 8414 — OAuth 2.0 Authorization Server Metadata](https://datatracker.ietf.org/doc/html/rfc8414)
- [RFC 9728 — OAuth 2.0 Protected Resource Metadata](https://datatracker.ietf.org/doc/html/rfc9728)
- [RFC 7591 — OAuth 2.0 Dynamic Client Registration](https://datatracker.ietf.org/doc/html/rfc7591)
- [RFC 9700 — OAuth 2.0 Security Best Current Practice](https://datatracker.ietf.org/doc/rfc9700/)
- [MCP Authorization Spec (2025-11-25)](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [MCP Authorization Spec (draft)](https://modelcontextprotocol.io/specification/draft/basic/authorization)
- [Cloudflare workers-oauth-provider](https://github.com/cloudflare/workers-oauth-provider)
- [Cloudflare MCP Authorization docs](https://developers.cloudflare.com/agents/model-context-protocol/authorization/)

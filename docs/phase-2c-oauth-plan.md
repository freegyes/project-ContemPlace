# Phase 2c — OAuth 2.1 for Claude.ai Web Connector

**GitHub issue:** #5
**Branch:** `feat/phase-2c-oauth` (not started)
**Status:** Planning

---

## Why OAuth, and why now

Phase 2a shipped a static Bearer token (`MCP_API_KEY`) that works correctly for:
- Claude Code CLI (`--header "Authorization: Bearer <key>"`)
- Anthropic API (`authorization_token` field on the MCP connector)
- OpenAI Responses API (same pattern)

It does **not** work with the **Claude.ai web connector UI** (`claude.ai/settings/connectors`), which is what surfaced this gap. The UI asks for a URL and "optional OAuth Client ID + Secret" — but that appearance is misleading. Claude.ai implements full **OAuth 2.1 Authorization Code + PKCE**. It is not Client Credentials.

Static Bearer tokens are the right fit for machine-to-machine (API/CLI) access, where no human is in the loop. Authorization Code is the right fit for interactive web UIs, where a human needs to consent in a browser. ContemPlace needs both paths.

---

## What Claude.ai's web connector actually does

1. Fetches `/.well-known/oauth-authorization-server` from the MCP server's base URL to discover auth endpoints (RFC 8414).
2. If the server supports Dynamic Client Registration (`/register`, RFC 7591), Claude auto-registers and gets a `client_id`/`client_secret`. If not, it uses the ones manually entered in the UI.
3. Constructs an authorization URL with a PKCE `code_challenge`, opens the user's browser to `/authorize`.
4. User completes the consent screen. Server redirects to `https://claude.ai/api/mcp/auth_callback` with an authorization code.
5. Claude exchanges the code + `code_verifier` for an access token at `/token` (`grant_type=authorization_code`).
6. All subsequent `/mcp` requests use `Authorization: Bearer <access_token>`.

A Client Credentials endpoint (`POST /token` with `client_id + client_secret`) would fail at step 3 — there is no `/authorize` endpoint, no browser flow, no consent.

---

## Connector compatibility matrix

| Client | Auth mechanism | Works today (Phase 2a)? | After Phase 2c? |
|---|---|---|---|
| Claude Code CLI `--header` | Static Bearer token | ✅ | ✅ |
| Claude Code CLI OAuth flow | Authorization Code + PKCE (browser) | ❌ | ✅ |
| Anthropic API `authorization_token` | Static Bearer token | ✅ | ✅ |
| Claude.ai web connector | OAuth 2.1 Auth Code + PKCE | ❌ | ✅ |
| ChatGPT Developer Mode | OAuth 2.1 Auth Code + PKCE | ❌ | ✅ |
| OpenAI Responses API | Static Bearer token (pre-obtained) | ✅ | ✅ |
| Cursor | OAuth 2.1 Auth Code + PKCE | ❌ | ✅ |

**Key insight:** Static Bearer works universally for API/SDK callers. OAuth 2.1 Auth Code is the standard for all interactive connectors. We need both.

---

## Why Client Credentials is not the right answer

Client Credentials (`grant_type=client_credentials`) is a machine-to-machine grant — the client proves its identity with a `client_id` + `client_secret` and receives a token directly, with no human in the loop. It appeared in the March 2025 MCP spec, was deemphasized in the June 2025 update, and is returning as a draft extension. Client support is inconsistent:

- Claude.ai web UI does **not** use it — it always drives Authorization Code.
- Claude Code CLI does **not** have native Client Credentials support — `--client-id`/`--client-secret` flags still initiate Authorization Code.
- ChatGPT web does **not** support it natively.

For ContemPlace, where the primary callers are already using static Bearer tokens (via API/CLI), Client Credentials adds ceremony with no benefit. Implementing it would not unlock the Claude.ai web UI.

---

## Recommended approach: `workers-oauth-provider`

Cloudflare publishes [`workers-oauth-provider`](https://developers.cloudflare.com/agents/model-context-protocol/authorization/), a library purpose-built for this use case: OAuth 2.1 Authorization Code + PKCE on a Cloudflare Worker, with Cloudflare KV for stateless-compatible token storage.

It handles:
- `/.well-known/oauth-authorization-server` — metadata discovery endpoint (required by MCP clients)
- `/register` — Dynamic Client Registration (optional; allows Claude.ai to self-register)
- `/authorize` — authorization endpoint with PKCE validation
- `/token` — code exchange endpoint
- Token issuance, signing, and verification

The consent screen at `/authorize` can be minimal — a simple "Approve" button since this is a single-owner deployment. If we skip DCR, the `client_id` and `client_secret` are fixed secrets entered manually in the Claude.ai UI.

---

## Implementation plan

### Prerequisites
- Cloudflare KV namespace for token storage (created via `wrangler kv:namespace create`)
- Decision on Dynamic Client Registration: **no DCR for now** (single owner, single client). Fixed `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` stored as secrets.

### New secrets (added to `mcp/wrangler.toml` comments)
```
OAUTH_CLIENT_ID       # a stable identifier string, e.g. "claude-ai"
OAUTH_CLIENT_SECRET   # openssl rand -hex 32
```
`JWT_SECRET` is managed by the library internally.

### Files to create
- `mcp/src/oauth.ts` — OAuthProvider setup, consent page HTML, token validation helper
- `tests/mcp-oauth.test.ts` — unit tests for the new routes

### Files to modify
- `mcp/wrangler.toml` — add KV binding, add new secret comments
- `mcp/src/index.ts` — hand off OAuth routes to the provider; update `/mcp` auth to accept either static key or OAuth-issued token
- `mcp/src/types.ts` — extend `Env` with new secret fields and KV binding
- `tests/mcp-smoke.test.ts` — optionally add smoke coverage for OAuth flow

### New routes (served by the library)
```
GET  /.well-known/oauth-authorization-server  → metadata discovery
POST /register                                 → Dynamic Client Registration (optional)
GET  /authorize                                → consent page
POST /token                                    → code exchange
```

### `/mcp` auth update
After the library issues access tokens (as signed JWTs), the `/mcp` handler validates them via the library's token-validation helper. The existing static key path (`MCP_API_KEY`) stays alongside as a fallback — removed in a follow-up once Claude.ai connection is confirmed.

### Migration path (zero-downtime)
1. Deploy with both auth paths live (static key + OAuth).
2. Set `OAUTH_CLIENT_ID` and `OAUTH_CLIENT_SECRET` as Worker secrets.
3. Configure Claude.ai connector: URL + Client ID + Client Secret.
4. Walk through the OAuth flow in the browser; verify Claude.ai can call tools.
5. Run all smoke tests — existing tests still pass (static key path).
6. In a follow-up commit: remove static key fallback, retire `MCP_API_KEY`.

---

## Why this wasn't in Phase 2a

Phase 2a's scope was AI agent access via Claude API and Claude Code CLI. Both use static Bearer tokens — no OAuth needed. The interactive connector use case (Claude.ai web UI) wasn't the target, so the OAuth complexity wasn't justified at the time. It became apparent only when trying to connect the deployed Worker to the Claude.ai web connector UI directly.

The Phase 2a auth design is correct for its intended scope. This phase extends it to cover the interactive web case.

---

## Open questions before starting

1. **Skip DCR?** For a single-owner deployment, fixed `client_id` + `client_secret` (entered manually in Claude.ai UI) is simpler. DCR would allow zero-config onboarding but adds storage complexity. **Recommendation: skip DCR for now.**
2. **Consent page UX?** A minimal "Authorize ContemPlace" page with an Approve button is enough. No need for scope selection (there is only one scope: full access).
3. **Token lifetime?** Access tokens: 1 hour. Refresh tokens: 30 days. These are configurable in the library.
4. **Phase 2b ordering?** Phase 2b (gardening pipeline) is independent. Can proceed in parallel or after.

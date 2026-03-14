import { OAuthProvider } from '@cloudflare/workers-oauth-provider';
import { WorkerEntrypoint } from 'cloudflare:workers';
import { createClient } from '@supabase/supabase-js';
import { loadConfig } from './config';
import { timingSafeEqual } from './auth';
import { createOpenAIClient } from './embed';
import { TOOL_DEFINITIONS, handleSearchNotes, handleGetNote, handleListRecent, handleGetRelated, handleCaptureNote } from './tools';
import { runCapturePipeline } from './pipeline';
import { AuthHandler } from './oauth';
import type { Env } from './types';
import type { ServiceCaptureResult } from './types';

// ── JSON-RPC helpers ─────────────────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function jsonRpcError(id: unknown, code: number, message: string): Response {
  return jsonResponse({ jsonrpc: '2.0', id, error: { code, message } });
}

function jsonRpcResult(id: unknown, result: unknown): Response {
  return jsonResponse({ jsonrpc: '2.0', id, result });
}

/**
 * Handle an authenticated MCP JSON-RPC request.
 * Called by the McpApiHandler (via OAuthProvider) for both OAuth and static token callers.
 */
export async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  // Parse JSON-RPC body
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return jsonRpcError(null, -32700, 'Parse error');
  }

  if (body['jsonrpc'] !== '2.0' || typeof body['method'] !== 'string') {
    return jsonRpcError(body['id'] ?? null, -32600, 'Invalid request');
  }

  // Notifications have no id — return 204, do not respond with JSON-RPC
  if (body['id'] === undefined) {
    return new Response(null, { status: 204 });
  }

  const id = body['id'];
  const method = body['method'] as string;
  const params = (body['params'] ?? {}) as Record<string, unknown>;

  // ── Initialize ────────────────────────────────────────────────────────────
  if (method === 'initialize') {
    return jsonRpcResult(id, {
      protocolVersion: '2024-11-05',
      serverInfo: { name: 'contemplace-mcp', version: '1.0.0' },
      capabilities: { tools: {} },
    });
  }

  // ── Tools list ────────────────────────────────────────────────────────────
  if (method === 'tools/list') {
    return jsonRpcResult(id, { tools: TOOL_DEFINITIONS });
  }

  // ── Tools call ────────────────────────────────────────────────────────────
  if (method === 'tools/call') {
    const toolName = params['name'] as string | undefined;
    const args = (params['arguments'] ?? {}) as Record<string, unknown>;

    if (!toolName) return jsonRpcError(id, -32602, 'Missing tool name');

    let config;
    try {
      config = loadConfig(env);
    } catch (err) {
      console.error(JSON.stringify({ event: 'config_error', error: String(err) }));
      return jsonRpcError(id, -32603, 'Server configuration error');
    }

    const db = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    const openai = createOpenAIClient(config);

    let result: object;
    switch (toolName) {
      case 'search_notes':
        result = await handleSearchNotes(args, db, openai, config);
        break;
      case 'get_note':
        result = await handleGetNote(args, db);
        break;
      case 'list_recent':
        result = await handleListRecent(args, db);
        break;
      case 'get_related':
        result = await handleGetRelated(args, db);
        break;
      case 'capture_note':
        result = await handleCaptureNote(args, db, openai, config);
        break;
      default:
        return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`);
    }

    return jsonRpcResult(id, result);
  }

  return jsonRpcError(id, -32601, 'Method not found');
}

// ── MCP API Handler (ExportedHandler for OAuthProvider) ──────────────────────
// The library requires `fetch` to be non-optional (ExportedHandlerWithFetch).
// Typed as Required<Pick<...>> to satisfy the constraint.

const McpApiHandler: ExportedHandler<Env> & Pick<Required<ExportedHandler<Env>>, 'fetch'> = {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleMcpRequest(request, env);
  },
};

// ── OAuthProvider configuration ──────────────────────────────────────────────

const oauthProvider = new OAuthProvider<Env>({
  apiRoute: '/mcp',
  apiHandler: McpApiHandler,
  defaultHandler: AuthHandler,
  authorizeEndpoint: '/authorize',
  tokenEndpoint: '/token',
  clientRegistrationEndpoint: '/register',
  accessTokenTTL: 3600,       // 1 hour
  refreshTokenTTL: 2592000,   // 30 days
  // SECURITY: S256 only — plain offers no cryptographic protection.
  // The library defaults to true (allowing plain). Override explicitly.
  allowPlainPKCE: false,
  scopesSupported: ['mcp'],
  /**
   * Static token bypass via resolveExternalToken.
   * When a Bearer token is not in the library's internal format (userId:grantId:secret),
   * this callback fires. We compare against MCP_API_KEY for backward-compatible static auth.
   * The hex MCP_API_KEY has no colons, so the library skips KV lookup entirely — no latency penalty.
   */
  async resolveExternalToken({ token, env }) {
    if (!env.MCP_API_KEY) return null;
    if (!timingSafeEqual(token, env.MCP_API_KEY)) return null;
    return { props: { userId: 'static-key', authMethod: 'static' } };
  },
  onError({ code, description, status }) {
    console.error(JSON.stringify({ event: 'oauth_error', code, description, status }));
  },
});

// ── CaptureService RPC entrypoint (for Service Binding from Telegram Worker) ─
// Named export — coexists with the OAuthProvider default export.
// The Telegram Worker binds to this via [[services]] in wrangler.toml.

export class CaptureService extends WorkerEntrypoint<Env> {
  async capture(rawInput: string, source: string): Promise<ServiceCaptureResult> {
    const config = loadConfig(this.env);
    const db = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    const openai = createOpenAIClient(config);
    return runCapturePipeline(rawInput, source, db, openai, config);
  }
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return oauthProvider.fetch(request, env, ctx);
  },
};

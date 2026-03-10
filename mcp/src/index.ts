import { createClient } from '@supabase/supabase-js';
import { loadConfig } from './config';
import { validateAuth } from './auth';
import { createOpenAIClient } from './embed';
import { TOOL_DEFINITIONS, handleSearchNotes, handleGetNote, handleListRecent, handleGetRelated, handleCaptureNote, handleListUnmatchedTags, handlePromoteConcept } from './tools';
import type { Env } from './types';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function jsonRpcError(id: unknown, code: number, message: string): Response {
  return jsonResponse({ jsonrpc: '2.0', id, error: { code, message } });
}

function jsonRpcResult(id: unknown, result: unknown): Response {
  return jsonResponse({ jsonrpc: '2.0', id, result });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    if (request.method !== 'POST' || url.pathname !== '/mcp') {
      return new Response('Not Found', { status: 404 });
    }

    // Auth — check before parsing body
    const authError = validateAuth(request, env);
    if (authError) return authError;

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
        case 'list_unmatched_tags':
          result = await handleListUnmatchedTags(args, db);
          break;
        case 'promote_concept':
          result = await handlePromoteConcept(args, db);
          break;
        default:
          return jsonRpcError(id, -32601, `Unknown tool: ${toolName}`);
      }

      return jsonRpcResult(id, result);
    }

    return jsonRpcError(id, -32601, 'Method not found');
  },
};

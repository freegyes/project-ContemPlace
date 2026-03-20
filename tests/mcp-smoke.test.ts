/**
 * MCP Worker smoke tests — hit the live deployed Worker.
 * Requires .dev.vars with:
 *   MCP_WORKER_URL, MCP_API_KEY,
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (for cleanup)
 *
 * Notes captured during the run have source='mcp-smoke-test' and are
 * deleted from the DB in afterAll.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

const MCP_URL = process.env['MCP_WORKER_URL'] ?? '';
const API_KEY = process.env['MCP_API_KEY'] ?? '';

function supabase() {
  return createClient(
    process.env['SUPABASE_URL'] ?? '',
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
  );
}

function rpcBody(method: string, params?: Record<string, unknown>, id: unknown = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', method, ...(params && { params }), id });
}

async function post(body: string, apiKey = API_KEY): Promise<Response> {
  return fetch(`${MCP_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body,
  });
}

async function rpc(method: string, params?: Record<string, unknown>, id: unknown = 1): Promise<Response> {
  return post(rpcBody(method, params, id));
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Response> {
  return rpc('tools/call', { name, arguments: args });
}

async function parseResult(res: Response): Promise<unknown> {
  const body = await res.json() as Record<string, unknown>;
  const result = body['result'] as Record<string, unknown> | undefined;
  if (!result) return null;
  const text = (result['content'] as Array<{ text: string }>)?.[0]?.text ?? '{}';
  return JSON.parse(text);
}

afterAll(async () => {
  const db = supabase();
  const { error } = await db.from('notes').delete().eq('source', 'mcp-smoke-test');
  if (error) console.warn('MCP smoke cleanup failed:', error.message);
});

describe('MCP Worker — CORS', () => {
  it('returns 204 with CORS headers for OPTIONS', async () => {
    const res = await fetch(`${MCP_URL}/mcp`, {
      method: 'OPTIONS',
      headers: { 'Origin': 'https://claude.ai' },
    });
    expect(res.status).toBe(204);
    // OAuthProvider mirrors the request Origin (not wildcard *)
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe('https://claude.ai');
  });
});

describe('MCP Worker — authentication', () => {
  it('returns 401 when Authorization header is absent', async () => {
    const res = await fetch(`${MCP_URL}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: rpcBody('initialize'),
    });
    expect(res.status).toBe(401);
  });

  it('returns 401 when Authorization header has wrong token', async () => {
    const res = await post(rpcBody('initialize'), 'wrong-key');
    // OAuthProvider returns 401 for unrecognized tokens (not 403)
    expect(res.status).toBe(401);
  });

  it('returns 200 with correct token', async () => {
    const res = await rpc('initialize');
    expect(res.status).toBe(200);
  });
});

describe('MCP Worker — routing', () => {
  it('GET /mcp is handled by OAuthProvider (not 404)', async () => {
    // OAuthProvider treats /mcp as an API route — returns 401 for unauthenticated GET
    const res = await fetch(`${MCP_URL}/mcp`, { method: 'GET' });
    expect(res.status).toBe(401);
  });

  it('returns 404 for POST to an unknown path', async () => {
    const res = await fetch(`${MCP_URL}/unknown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
      body: rpcBody('initialize'),
    });
    expect(res.status).toBe(404);
  });
});

describe('MCP Worker — OAuth discovery', () => {
  it('GET /.well-known/oauth-protected-resource returns RFC 9728 metadata', async () => {
    const res = await fetch(`${MCP_URL}/.well-known/oauth-protected-resource`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['resource']).toBeDefined();
    expect(body['authorization_servers']).toBeDefined();
    expect(Array.isArray(body['authorization_servers'])).toBe(true);
  });

  it('GET /.well-known/oauth-authorization-server returns RFC 8414 metadata', async () => {
    const res = await fetch(`${MCP_URL}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body['authorization_endpoint']).toBeDefined();
    expect(body['token_endpoint']).toBeDefined();
    expect(body['registration_endpoint']).toBeDefined();
    expect(body['code_challenge_methods_supported']).toEqual(['S256']);
  });

  it('POST /register accepts DCR registration', async () => {
    const res = await fetch(`${MCP_URL}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'Smoke Test Client',
        redirect_uris: ['https://example.com/callback'],
        grant_types: ['authorization_code'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body['client_id']).toBeDefined();
    expect(body['client_name']).toBe('Smoke Test Client');
  });
});

describe('MCP Worker — protocol', () => {
  it('initialize returns protocolVersion and serverInfo', async () => {
    const res = await rpc('initialize');
    const body = await res.json() as Record<string, unknown>;
    const result = body['result'] as Record<string, unknown>;
    expect(result['protocolVersion']).toBe('2024-11-05');
    expect((result['serverInfo'] as Record<string, unknown>)?.['name']).toBe('contemplace-mcp');
  });

  it('notification (no id) returns 204', async () => {
    const res = await post(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }));
    expect(res.status).toBe(204);
  });

  it('tools/list returns 8 tools with name and inputSchema', async () => {
    const res = await rpc('tools/list');
    const body = await res.json() as Record<string, unknown>;
    const tools = (body['result'] as Record<string, unknown>)?.['tools'] as Array<Record<string, unknown>>;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools).toHaveLength(8);
    for (const tool of tools) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('inputSchema');
    }
  });

  it('unknown method returns -32601', async () => {
    const res = await rpc('ping');
    const body = await res.json() as Record<string, unknown>;
    expect((body['error'] as Record<string, unknown>)?.['code']).toBe(-32601);
  });

  it('malformed JSON body returns -32700', async () => {
    const res = await post('not json at all');
    const body = await res.json() as Record<string, unknown>;
    expect((body['error'] as Record<string, unknown>)?.['code']).toBe(-32700);
  });
});

describe('MCP Worker — tool: list_recent', () => {
  it('returns a valid result with notes array and count', async () => {
    const res = await callTool('list_recent', { limit: 5 });
    expect(res.status).toBe(200);
    const result = await parseResult(res) as Record<string, unknown>;
    expect(Array.isArray(result['notes'])).toBe(true);
    expect(typeof result['count']).toBe('number');
  });

  it('result has isError: false', async () => {
    const res = await callTool('list_recent', {});
    const body = await res.json() as Record<string, unknown>;
    const toolResult = body['result'] as Record<string, unknown>;
    expect(toolResult['isError']).toBe(false);
  });
});

describe('MCP Worker — tool: search_notes', () => {
  it('returns results array and count', async () => {
    const res = await callTool('search_notes', { query: 'creativity constraints design' });
    const result = await parseResult(res) as Record<string, unknown>;
    expect(Array.isArray(result['results'])).toBe(true);
    expect(typeof result['count']).toBe('number');
  });

  it('each result has expected fields', async () => {
    const res = await callTool('search_notes', { query: 'creativity', limit: 3 });
    const result = await parseResult(res) as Record<string, unknown>;
    const results = result['results'] as Array<Record<string, unknown>>;
    for (const r of results) {
      expect(r).toHaveProperty('id');
      expect(r).toHaveProperty('title');
      expect(r).toHaveProperty('score');
      expect(r).toHaveProperty('created_at');
      // raw_input should NOT appear in search results
      expect(r['raw_input']).toBeUndefined();
    }
  });
});

describe('MCP Worker — capture_note, get_note, get_related', () => {
  let capturedId: string;

  it('capture_note creates a note and returns expected fields', async () => {
    const res = await callTool('capture_note', {
      raw_input: '[MCP-SMOKE] The test of a first-rate intelligence is the ability to hold two opposed ideas in mind at the same time.',
      source: 'mcp-smoke-test',
    });
    expect(res.status).toBe(200);
    const result = await parseResult(res) as Record<string, unknown>;
    expect(typeof result['id']).toBe('string');
    expect(typeof result['title']).toBe('string');
    expect(typeof result['body']).toBe('string');
    expect(Array.isArray(result['tags'])).toBe(true);
    expect(result['source']).toBe('mcp-smoke-test');
    capturedId = result['id'] as string;
  }, 30000);

  it('note exists in Supabase with correct source', async () => {
    const db = supabase();
    const { data, error } = await db
      .from('notes')
      .select('id, source')
      .eq('id', capturedId)
      .single();
    expect(error).toBeNull();
    expect(data).not.toBeNull();
    expect((data as Record<string, unknown>)['source']).toBe('mcp-smoke-test');
  });

  it('enrichment_log has at least 2 entries for the captured note', async () => {
    const db = supabase();
    const { data } = await db
      .from('enrichment_log')
      .select('enrichment_type, model_used')
      .eq('note_id', capturedId);
    expect(data).not.toBeNull();
    expect(data!.length).toBeGreaterThanOrEqual(2);
    expect(data!.every((l: Record<string, unknown>) => l['model_used'] !== null)).toBe(true);
  });

  it('get_note returns full note including raw_input', async () => {
    const res = await callTool('get_note', { id: capturedId });
    const result = await parseResult(res) as Record<string, unknown>;
    expect(result['id']).toBe(capturedId);
    expect(typeof result['raw_input']).toBe('string');
    expect(Array.isArray(result['links'])).toBe(true);
  });

  it('get_related returns source_id and links array', async () => {
    const res = await callTool('get_related', { id: capturedId });
    const result = await parseResult(res) as Record<string, unknown>;
    expect(result['source_id']).toBe(capturedId);
    expect(Array.isArray(result['links'])).toBe(true);
    expect(typeof result['count']).toBe('number');
  });
});

describe('MCP Worker — input validation (live)', () => {
  it('capture_note with empty raw_input returns isError: true', async () => {
    const res = await callTool('capture_note', { raw_input: '' });
    const body = await res.json() as Record<string, unknown>;
    const toolResult = body['result'] as Record<string, unknown>;
    expect(toolResult['isError']).toBe(true);
  });

  it('get_note with invalid UUID returns isError: true', async () => {
    const res = await callTool('get_note', { id: 'not-a-uuid' });
    const body = await res.json() as Record<string, unknown>;
    const toolResult = body['result'] as Record<string, unknown>;
    expect(toolResult['isError']).toBe(true);
  });

  it('search_notes with missing query returns isError: true', async () => {
    const res = await callTool('search_notes', {});
    const body = await res.json() as Record<string, unknown>;
    const toolResult = body['result'] as Record<string, unknown>;
    expect(toolResult['isError']).toBe(true);
  });

});

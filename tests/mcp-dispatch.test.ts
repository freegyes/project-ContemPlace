/**
 * Tests for handleMcpRequest (mcp/src/index.ts).
 * JSON-RPC protocol, tool dispatch, and response shapes — independent of auth/routing.
 *
 * All tool handlers are mocked — their logic is tested in mcp-tools.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock('../mcp/src/tools', () => ({
  TOOL_DEFINITIONS: [
    { name: 'search_notes', description: 'Search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
    { name: 'get_note', description: 'Get', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { name: 'list_recent', description: 'List', inputSchema: { type: 'object', properties: {} } },
    { name: 'get_related', description: 'Related', inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
    { name: 'capture_note', description: 'Capture', inputSchema: { type: 'object', properties: { raw_input: { type: 'string' } }, required: ['raw_input'] } },
  ],
  handleSearchNotes: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }], isError: false }),
  handleGetNote: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }], isError: false }),
  handleListRecent: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }], isError: false }),
  handleGetRelated: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }], isError: false }),
  handleCaptureNote: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }], isError: false }),
}));

vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class WorkerEntrypoint { env: unknown; constructor() { this.env = {}; } },
}));

vi.mock('@cloudflare/workers-oauth-provider', () => ({
  OAuthProvider: vi.fn().mockImplementation(() => ({ fetch: vi.fn() })),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn().mockReturnValue({}),
}));

vi.mock('../mcp/src/embed', () => ({
  createOpenAIClient: vi.fn().mockReturnValue({}),
  embedText: vi.fn(),
  buildEmbeddingInput: vi.fn(),
}));

vi.mock('../mcp/src/pipeline', () => ({
  runCapturePipeline: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import { handleMcpRequest } from '../mcp/src/index';
import { handleSearchNotes, handleGetNote, handleListRecent, handleGetRelated, handleCaptureNote } from '../mcp/src/tools';

const MOCK_TOOL_RESULT = { content: [{ type: 'text', text: '{"ok":true}' }], isError: false };

const MOCK_ENV = {
  MCP_API_KEY: 'test-mcp-api-key',
  OPENROUTER_API_KEY: 'or-key',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  CAPTURE_MODEL: 'anthropic/claude-haiku-4-5',
  EMBED_MODEL: 'openai/text-embedding-3-small',
  MATCH_THRESHOLD: '0.60',
};

function makeRequest(body: string): Request {
  return new Request('https://worker.example.com/mcp', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
}

function rpcBody(method: string, params?: Record<string, unknown>, id: unknown = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', method, ...(params && { params }), id });
}

async function dispatch(method: string, params?: Record<string, unknown>, id: unknown = 1): Promise<Response> {
  return handleMcpRequest(makeRequest(rpcBody(method, params, id)), MOCK_ENV);
}

async function parseRpc(res: Response): Promise<Record<string, unknown>> {
  return res.json() as Promise<Record<string, unknown>>;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('handleMcpRequest — JSON-RPC dispatch', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  describe('JSON-RPC parsing', () => {
    it('returns -32700 parse error when body is not valid JSON', async () => {
      const res = await handleMcpRequest(makeRequest('not valid json'), MOCK_ENV);
      const body = await parseRpc(res);
      expect((body['error'] as Record<string, unknown>)?.['code']).toBe(-32700);
    });

    it('returns -32600 when jsonrpc field is not "2.0"', async () => {
      const res = await handleMcpRequest(
        makeRequest(JSON.stringify({ jsonrpc: '1.0', method: 'initialize', id: 1 })),
        MOCK_ENV,
      );
      const body = await parseRpc(res);
      expect((body['error'] as Record<string, unknown>)?.['code']).toBe(-32600);
    });

    it('returns -32600 when method is not a string', async () => {
      const res = await handleMcpRequest(
        makeRequest(JSON.stringify({ jsonrpc: '2.0', method: 42, id: 1 })),
        MOCK_ENV,
      );
      const body = await parseRpc(res);
      expect((body['error'] as Record<string, unknown>)?.['code']).toBe(-32600);
    });
  });

  describe('notifications (no id)', () => {
    it('returns 204 for a request with no id field', async () => {
      const res = await handleMcpRequest(
        makeRequest(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })),
        MOCK_ENV,
      );
      expect(res.status).toBe(204);
    });

    it('does not call any tool handler for a notification', async () => {
      await handleMcpRequest(
        makeRequest(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })),
        MOCK_ENV,
      );
      expect(vi.mocked(handleSearchNotes)).not.toHaveBeenCalled();
    });
  });

  describe('initialize method', () => {
    it('returns protocolVersion', async () => {
      const res = await dispatch('initialize');
      const body = await parseRpc(res);
      expect((body['result'] as Record<string, unknown>)?.['protocolVersion']).toBe('2024-11-05');
    });

    it('returns serverInfo.name', async () => {
      const res = await dispatch('initialize');
      const body = await parseRpc(res);
      const result = body['result'] as Record<string, unknown>;
      expect((result['serverInfo'] as Record<string, unknown>)?.['name']).toBe('contemplace-mcp');
    });

    it('includes the request id in the response', async () => {
      const res = await dispatch('initialize', undefined, 42);
      const body = await parseRpc(res);
      expect(body['id']).toBe(42);
    });
  });

  describe('tools/list method', () => {
    it('returns the TOOL_DEFINITIONS array', async () => {
      const res = await dispatch('tools/list');
      const body = await parseRpc(res);
      const tools = (body['result'] as Record<string, unknown>)?.['tools'];
      expect(Array.isArray(tools)).toBe(true);
    });

    it('returns exactly 5 tool definitions', async () => {
      const res = await dispatch('tools/list');
      const body = await parseRpc(res);
      const tools = (body['result'] as Record<string, unknown>)?.['tools'] as unknown[];
      expect(tools).toHaveLength(5);
    });

    it('each tool definition has name, description, inputSchema', async () => {
      const res = await dispatch('tools/list');
      const body = await parseRpc(res);
      const tools = (body['result'] as Record<string, unknown>)?.['tools'] as Array<Record<string, unknown>>;
      for (const tool of tools) {
        expect(tool).toHaveProperty('name');
        expect(tool).toHaveProperty('description');
        expect(tool).toHaveProperty('inputSchema');
      }
    });
  });

  describe('tools/call dispatch', () => {
    it('dispatches to handleSearchNotes for name="search_notes"', async () => {
      await dispatch('tools/call', { name: 'search_notes', arguments: { query: 'test' } });
      expect(vi.mocked(handleSearchNotes)).toHaveBeenCalledOnce();
    });

    it('dispatches to handleGetNote for name="get_note"', async () => {
      await dispatch('tools/call', { name: 'get_note', arguments: { id: 'aaaaaaaa-0000-0000-0000-000000000001' } });
      expect(vi.mocked(handleGetNote)).toHaveBeenCalledOnce();
    });

    it('dispatches to handleListRecent for name="list_recent"', async () => {
      await dispatch('tools/call', { name: 'list_recent', arguments: {} });
      expect(vi.mocked(handleListRecent)).toHaveBeenCalledOnce();
    });

    it('dispatches to handleGetRelated for name="get_related"', async () => {
      await dispatch('tools/call', { name: 'get_related', arguments: { id: 'aaaaaaaa-0000-0000-0000-000000000001' } });
      expect(vi.mocked(handleGetRelated)).toHaveBeenCalledOnce();
    });

    it('dispatches to handleCaptureNote for name="capture_note"', async () => {
      await dispatch('tools/call', { name: 'capture_note', arguments: { raw_input: 'hello' } });
      expect(vi.mocked(handleCaptureNote)).toHaveBeenCalledOnce();
    });

    it('returns -32601 for an unknown tool name', async () => {
      const res = await dispatch('tools/call', { name: 'nonexistent_tool', arguments: {} });
      const body = await parseRpc(res);
      expect((body['error'] as Record<string, unknown>)?.['code']).toBe(-32601);
    });

    it('returns -32602 when params.name is missing', async () => {
      const res = await dispatch('tools/call', { arguments: {} });
      const body = await parseRpc(res);
      expect((body['error'] as Record<string, unknown>)?.['code']).toBe(-32602);
    });

    it('wraps tool result in JSON-RPC result envelope', async () => {
      const res = await dispatch('tools/call', { name: 'list_recent', arguments: {} });
      const body = await parseRpc(res);
      expect(body['jsonrpc']).toBe('2.0');
      expect(body['result']).toEqual(MOCK_TOOL_RESULT);
    });

    it('passes arguments to handler (not undefined)', async () => {
      await dispatch('tools/call', { name: 'search_notes', arguments: { query: 'my query' } });
      const call = vi.mocked(handleSearchNotes).mock.calls[0]!;
      expect(call[0]).toEqual({ query: 'my query' });
    });
  });

  describe('unknown method', () => {
    it('returns -32601 for an unrecognised method', async () => {
      const res = await dispatch('ping');
      const body = await parseRpc(res);
      expect((body['error'] as Record<string, unknown>)?.['code']).toBe(-32601);
    });
  });

  describe('response shape', () => {
    it('success responses have Content-Type: application/json', async () => {
      const res = await dispatch('initialize');
      expect(res.headers.get('Content-Type')).toContain('application/json');
    });

    it('success responses include Content-Type header', async () => {
      const res = await dispatch('initialize');
      // CORS is now handled by OAuthProvider wrapper, not by handleMcpRequest
      expect(res.headers.get('Content-Type')).toBe('application/json');
    });

    it('error responses include jsonrpc, id, and error.code + message', async () => {
      const res = await dispatch('ping');
      const body = await parseRpc(res);
      expect(body['jsonrpc']).toBe('2.0');
      expect(body['id']).toBe(1);
      const err = body['error'] as Record<string, unknown>;
      expect(typeof err['code']).toBe('number');
      expect(typeof err['message']).toBe('string');
    });
  });
});

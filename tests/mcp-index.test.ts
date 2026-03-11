/**
 * Tests for the MCP HTTP wrapper (mcp/src/index.ts default export).
 * Verifies that the OAuthProvider is wired up correctly and that the
 * static token bypass via resolveExternalToken works.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Module mocks ──────────────────────────────────────────────────────────────

// vi.hoisted() runs before vi.mock factories — safe to reference in both.
const oauthCapture = vi.hoisted(() => ({
  options: {} as Record<string, unknown>,
  fetch: vi.fn(),
}));

vi.mock('@cloudflare/workers-oauth-provider', () => ({
  OAuthProvider: vi.fn().mockImplementation((options: Record<string, unknown>) => {
    oauthCapture.options = options;
    return { fetch: oauthCapture.fetch };
  }),
}));

vi.mock('../mcp/src/tools', () => ({
  TOOL_DEFINITIONS: [
    { name: 'search_notes', description: 'Search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  ],
  handleSearchNotes: vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{"ok":true}' }], isError: false }),
  handleGetNote: vi.fn(),
  handleListRecent: vi.fn(),
  handleGetRelated: vi.fn(),
  handleCaptureNote: vi.fn(),
  handleListUnmatchedTags: vi.fn(),
  handlePromoteConcept: vi.fn(),
  handleSearchChunks: vi.fn(),
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn().mockReturnValue({}),
}));

vi.mock('../mcp/src/embed', () => ({
  createOpenAIClient: vi.fn().mockReturnValue({}),
  embedText: vi.fn(),
  buildEmbeddingInput: vi.fn(),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────
import handler from '../mcp/src/index';

const VALID_API_KEY = 'test-mcp-api-key';

const MOCK_ENV = {
  MCP_API_KEY: VALID_API_KEY,
  OPENROUTER_API_KEY: 'or-key',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  CAPTURE_MODEL: 'anthropic/claude-haiku-4-5',
  EMBED_MODEL: 'openai/text-embedding-3-small',
  MATCH_THRESHOLD: '0.60',
  OAUTH_KV: {},
};

const MOCK_CTX = {
  waitUntil: vi.fn(),
  passThroughOnException: vi.fn(),
} as unknown as ExecutionContext;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MCP HTTP wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    oauthCapture.fetch.mockResolvedValue(new Response('ok'));
  });

  describe('delegates all requests to OAuthProvider', () => {
    it('passes request, env, and ctx to OAuthProvider.fetch', async () => {
      const req = new Request('https://worker.example.com/mcp', { method: 'POST' });
      await handler.fetch(req, MOCK_ENV as never, MOCK_CTX);
      expect(oauthCapture.fetch).toHaveBeenCalledWith(req, MOCK_ENV, MOCK_CTX);
    });

    it('returns the response from OAuthProvider.fetch', async () => {
      const expected = new Response('test-response', { status: 200 });
      oauthCapture.fetch.mockResolvedValue(expected);
      const res = await handler.fetch(
        new Request('https://worker.example.com/mcp', { method: 'POST' }),
        MOCK_ENV as never,
        MOCK_CTX,
      );
      expect(res).toBe(expected);
    });
  });

  describe('OAuthProvider configuration', () => {
    it('configures apiRoute as /mcp', () => {
      expect(oauthCapture.options['apiRoute']).toBe('/mcp');
    });

    it('configures authorizeEndpoint as /authorize', () => {
      expect(oauthCapture.options['authorizeEndpoint']).toBe('/authorize');
    });

    it('configures tokenEndpoint as /token', () => {
      expect(oauthCapture.options['tokenEndpoint']).toBe('/token');
    });

    it('enables DCR at /register', () => {
      expect(oauthCapture.options['clientRegistrationEndpoint']).toBe('/register');
    });

    it('disallows plain PKCE (S256 only)', () => {
      expect(oauthCapture.options['allowPlainPKCE']).toBe(false);
    });

    it('sets access token TTL to 1 hour', () => {
      expect(oauthCapture.options['accessTokenTTL']).toBe(3600);
    });

    it('sets refresh token TTL to 30 days', () => {
      expect(oauthCapture.options['refreshTokenTTL']).toBe(2592000);
    });

    it('declares mcp scope', () => {
      expect(oauthCapture.options['scopesSupported']).toEqual(['mcp']);
    });

    it('provides a resolveExternalToken callback', () => {
      expect(typeof oauthCapture.options['resolveExternalToken']).toBe('function');
    });

    it('provides an onError callback', () => {
      expect(typeof oauthCapture.options['onError']).toBe('function');
    });
  });

  describe('resolveExternalToken (static token bypass)', () => {
    it('returns props for a valid static token', async () => {
      const resolve = oauthCapture.options['resolveExternalToken'] as (input: { token: string; env: typeof MOCK_ENV }) => Promise<unknown>;
      const result = await resolve({ token: VALID_API_KEY, env: MOCK_ENV });
      expect(result).toEqual({ props: { userId: 'static-key', authMethod: 'static' } });
    });

    it('returns null for an invalid static token', async () => {
      const resolve = oauthCapture.options['resolveExternalToken'] as (input: { token: string; env: typeof MOCK_ENV }) => Promise<unknown>;
      const result = await resolve({ token: 'wrong-key', env: MOCK_ENV });
      expect(result).toBeNull();
    });

    it('returns null when MCP_API_KEY is not set', async () => {
      const resolve = oauthCapture.options['resolveExternalToken'] as (input: { token: string; env: Record<string, unknown> }) => Promise<unknown>;
      const result = await resolve({ token: 'any-key', env: { ...MOCK_ENV, MCP_API_KEY: '' } });
      expect(result).toBeNull();
    });
  });
});

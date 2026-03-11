/**
 * Tests for OAuth consent page and AuthHandler (mcp/src/oauth.ts).
 * Pure unit tests — no network, no KV.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderConsentPage, renderDeniedPage, AuthHandler, OWNER_USER_ID } from '../mcp/src/oauth';
import type { AuthRequest, ClientInfo } from '@cloudflare/workers-oauth-provider';

// ── Mock OAuthProvider (module-level, prevents cloudflare:workers import) ─────
vi.mock('@cloudflare/workers-oauth-provider', () => ({}));

// ── Mock timingSafeEqual (module-level) ──────────────────────────────────────
vi.mock('../mcp/src/auth', () => ({
  timingSafeEqual: (a: string, b: string) => a === b,
}));

// ── Test helpers ─────────────────────────────────────────────────────────────

function makeAuthRequest(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    responseType: 'code',
    clientId: 'test-client-id',
    redirectUri: 'https://claude.ai/api/mcp/auth_callback',
    scope: ['mcp'],
    state: 'random-state-value',
    codeChallenge: 'abc123challenge',
    codeChallengeMethod: 'S256',
    ...overrides,
  };
}

function makeClientInfo(overrides: Partial<ClientInfo> = {}): ClientInfo {
  return {
    clientId: 'test-client-id',
    clientName: 'Claude.ai',
    redirectUris: ['https://claude.ai/api/mcp/auth_callback'],
    tokenEndpointAuthMethod: 'none',
    ...overrides,
  };
}

const TEST_CONSENT_SECRET = 'test-consent-secret-value';

function makeEnv(overrides: Record<string, unknown> = {}) {
  return {
    MCP_API_KEY: 'test-key',
    CONSENT_SECRET: TEST_CONSENT_SECRET,
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-key',
    OPENROUTER_API_KEY: 'or-key',
    CAPTURE_MODEL: 'test',
    EMBED_MODEL: 'test',
    MATCH_THRESHOLD: '0.60',
    MCP_SEARCH_THRESHOLD: '0.35',
    OAUTH_KV: {},
    OAUTH_PROVIDER: undefined as unknown,
    ...overrides,
  };
}

// ── renderConsentPage tests ──────────────────────────────────────────────────

describe('renderConsentPage', () => {
  it('renders valid HTML with client name and redirect URI', () => {
    const html = renderConsentPage(makeAuthRequest(), makeClientInfo());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Claude.ai');
    expect(html).toContain('https://claude.ai/api/mcp/auth_callback');
  });

  it('shows "Unknown client" when clientInfo is null', () => {
    const html = renderConsentPage(makeAuthRequest(), null);
    expect(html).toContain('Unknown client');
  });

  it('shows "Unknown client" when clientName is undefined', () => {
    const html = renderConsentPage(makeAuthRequest(), makeClientInfo({ clientName: undefined }));
    expect(html).toContain('Unknown client');
  });

  it('includes hidden form fields for OAuth parameters', () => {
    const html = renderConsentPage(makeAuthRequest(), makeClientInfo());
    expect(html).toContain('name="client_id"');
    expect(html).toContain('name="redirect_uri"');
    expect(html).toContain('name="state"');
    expect(html).toContain('name="scope"');
    expect(html).toContain('name="response_type"');
    expect(html).toContain('name="code_challenge"');
    expect(html).toContain('name="code_challenge_method"');
  });

  it('omits code_challenge fields when not provided', () => {
    const html = renderConsentPage(
      makeAuthRequest({ codeChallenge: undefined, codeChallengeMethod: undefined }),
      makeClientInfo(),
    );
    expect(html).not.toContain('name="code_challenge"');
    expect(html).not.toContain('name="code_challenge_method"');
  });

  it('escapes HTML in client name', () => {
    const html = renderConsentPage(
      makeAuthRequest(),
      makeClientInfo({ clientName: '<script>alert("xss")</script>' }),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
  });

  it('escapes HTML in redirect URI', () => {
    const html = renderConsentPage(
      makeAuthRequest({ redirectUri: 'https://evil.com/"><script>alert(1)</script>' }),
      makeClientInfo(),
    );
    expect(html).not.toContain('"><script>');
  });

  it('displays scope', () => {
    const html = renderConsentPage(
      makeAuthRequest({ scope: ['mcp', 'read'] }),
      makeClientInfo(),
    );
    expect(html).toContain('mcp read');
  });

  it('includes resource hidden field when provided', () => {
    const html = renderConsentPage(
      makeAuthRequest({ resource: 'https://mcp.example.com' }),
      makeClientInfo(),
    );
    expect(html).toContain('name="resource"');
    expect(html).toContain('value="https://mcp.example.com"');
  });

  it('omits passphrase field when requireSecret is false', () => {
    const html = renderConsentPage(makeAuthRequest(), makeClientInfo(), { requireSecret: false });
    expect(html).not.toContain('name="consent_secret"');
    expect(html).not.toContain('Passphrase');
  });

  it('omits passphrase field when options not provided', () => {
    const html = renderConsentPage(makeAuthRequest(), makeClientInfo());
    expect(html).not.toContain('name="consent_secret"');
  });

  it('includes passphrase field when requireSecret is true', () => {
    const html = renderConsentPage(makeAuthRequest(), makeClientInfo(), { requireSecret: true });
    expect(html).toContain('name="consent_secret"');
    expect(html).toContain('type="password"');
    expect(html).toContain('Passphrase');
  });
});

// ── renderDeniedPage tests ──────────────────────────────────────────────────

describe('renderDeniedPage', () => {
  it('renders valid HTML with denial message', () => {
    const html = renderDeniedPage();
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Authorization denied');
    expect(html).toContain('passphrase was incorrect');
  });
});

// ── AuthHandler tests ────────────────────────────────────────────────────────

describe('AuthHandler', () => {
  const mockParseAuthRequest = vi.fn();
  const mockLookupClient = vi.fn();
  const mockCompleteAuthorization = vi.fn();

  function envWithHelpers() {
    return makeEnv({
      OAUTH_PROVIDER: {
        parseAuthRequest: mockParseAuthRequest,
        lookupClient: mockLookupClient,
        completeAuthorization: mockCompleteAuthorization,
      },
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockParseAuthRequest.mockResolvedValue(makeAuthRequest());
    mockLookupClient.mockResolvedValue(makeClientInfo());
    mockCompleteAuthorization.mockResolvedValue({ redirectTo: 'https://claude.ai/callback?code=abc' });
  });

  describe('routing', () => {
    it('returns 404 for non-/authorize paths', async () => {
      const res = await AuthHandler.fetch!(
        new Request('https://worker.example.com/other'),
        envWithHelpers() as never,
        {} as ExecutionContext,
      );
      expect(res.status).toBe(404);
    });

    it('returns 405 for unsupported methods on /authorize', async () => {
      const res = await AuthHandler.fetch!(
        new Request('https://worker.example.com/authorize', { method: 'DELETE' }),
        envWithHelpers() as never,
        {} as ExecutionContext,
      );
      expect(res.status).toBe(405);
    });

    it('returns 500 when OAUTH_PROVIDER is not injected', async () => {
      const res = await AuthHandler.fetch!(
        new Request('https://worker.example.com/authorize'),
        makeEnv() as never,
        {} as ExecutionContext,
      );
      expect(res.status).toBe(500);
    });
  });

  describe('GET /authorize — consent page', () => {
    it('renders consent page HTML', async () => {
      const res = await AuthHandler.fetch!(
        new Request('https://worker.example.com/authorize?client_id=test'),
        envWithHelpers() as never,
        {} as ExecutionContext,
      );
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toContain('text/html');
      const html = await res.text();
      expect(html).toContain('Authorize access to ContemPlace');
      expect(html).toContain('Claude.ai');
    });

    it('calls parseAuthRequest and lookupClient', async () => {
      await AuthHandler.fetch!(
        new Request('https://worker.example.com/authorize?client_id=test'),
        envWithHelpers() as never,
        {} as ExecutionContext,
      );
      expect(mockParseAuthRequest).toHaveBeenCalledTimes(1);
      expect(mockLookupClient).toHaveBeenCalledWith('test-client-id');
    });

    it('returns 400 when parseAuthRequest throws', async () => {
      mockParseAuthRequest.mockRejectedValue(new Error('bad request'));
      const res = await AuthHandler.fetch!(
        new Request('https://worker.example.com/authorize'),
        envWithHelpers() as never,
        {} as ExecutionContext,
      );
      expect(res.status).toBe(400);
    });
  });

  describe('POST /authorize — consent submission', () => {
    function postBody(extra: Record<string, string> = {}) {
      return new URLSearchParams({
        client_id: 'test-client-id',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        state: 'random-state',
        scope: 'mcp',
        response_type: 'code',
        code_challenge: 'abc123',
        code_challenge_method: 'S256',
        consent_secret: TEST_CONSENT_SECRET,
        ...extra,
      });
    }

    it('completes authorization and redirects with correct secret', async () => {
      const res = await AuthHandler.fetch!(
        new Request('https://worker.example.com/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: postBody().toString(),
        }),
        envWithHelpers() as never,
        {} as ExecutionContext,
      );

      expect(res.status).toBe(302);
      expect(res.headers.get('Location')).toBe('https://claude.ai/callback?code=abc');
    });

    it('calls completeAuthorization with owner user ID', async () => {
      await AuthHandler.fetch!(
        new Request('https://worker.example.com/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: postBody().toString(),
        }),
        envWithHelpers() as never,
        {} as ExecutionContext,
      );

      expect(mockCompleteAuthorization).toHaveBeenCalledTimes(1);
      const call = mockCompleteAuthorization.mock.calls[0]![0];
      expect(call.userId).toBe(OWNER_USER_ID);
      expect(call.scope).toEqual(['mcp']);
      expect(call.props).toEqual({ userId: OWNER_USER_ID });
    });

    it('returns 400 when completeAuthorization throws', async () => {
      mockCompleteAuthorization.mockRejectedValue(new Error('bad grant'));
      const res = await AuthHandler.fetch!(
        new Request('https://worker.example.com/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: postBody().toString(),
        }),
        envWithHelpers() as never,
        {} as ExecutionContext,
      );
      expect(res.status).toBe(400);
    });

    it('returns 403 when consent_secret is wrong', async () => {
      const res = await AuthHandler.fetch!(
        new Request('https://worker.example.com/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: postBody({ consent_secret: 'wrong-value' }).toString(),
        }),
        envWithHelpers() as never,
        {} as ExecutionContext,
      );
      expect(res.status).toBe(403);
      const html = await res.text();
      expect(html).toContain('Authorization denied');
      expect(mockCompleteAuthorization).not.toHaveBeenCalled();
    });

    it('returns 403 when consent_secret is missing', async () => {
      const body = new URLSearchParams({
        client_id: 'test-client-id',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        state: 'random-state',
        scope: 'mcp',
        response_type: 'code',
      });
      const res = await AuthHandler.fetch!(
        new Request('https://worker.example.com/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        }),
        envWithHelpers() as never,
        {} as ExecutionContext,
      );
      expect(res.status).toBe(403);
      expect(mockCompleteAuthorization).not.toHaveBeenCalled();
    });

    it('returns 403 when consent_secret is empty string', async () => {
      const res = await AuthHandler.fetch!(
        new Request('https://worker.example.com/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: postBody({ consent_secret: '' }).toString(),
        }),
        envWithHelpers() as never,
        {} as ExecutionContext,
      );
      expect(res.status).toBe(403);
      expect(mockCompleteAuthorization).not.toHaveBeenCalled();
    });

    it('allows POST without secret when CONSENT_SECRET is not set (graceful degradation)', async () => {
      const body = new URLSearchParams({
        client_id: 'test-client-id',
        redirect_uri: 'https://claude.ai/api/mcp/auth_callback',
        state: 'random-state',
        scope: 'mcp',
        response_type: 'code',
      });
      const env = envWithHelpers();
      (env as Record<string, unknown>).CONSENT_SECRET = '';
      const res = await AuthHandler.fetch!(
        new Request('https://worker.example.com/authorize', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        }),
        env as never,
        {} as ExecutionContext,
      );
      expect(res.status).toBe(302);
      expect(mockCompleteAuthorization).toHaveBeenCalledTimes(1);
    });
  });
});

// ── OWNER_USER_ID constant ───────────────────────────────────────────────────

describe('OWNER_USER_ID', () => {
  it('is a non-empty string', () => {
    expect(typeof OWNER_USER_ID).toBe('string');
    expect(OWNER_USER_ID.length).toBeGreaterThan(0);
  });
});

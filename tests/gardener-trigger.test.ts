import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateTriggerAuth } from '../gardener/src/auth';
import type { Env } from '../gardener/src/types';

const BASE_ENV: Env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  GARDENER_SIMILARITY_THRESHOLD: '0.70',
  GARDENER_TAG_MATCH_THRESHOLD: '0.55',
  GARDENER_API_KEY: 'test-gardener-key',
};

function env(overrides: Partial<Env> = {}): Env {
  return { ...BASE_ENV, ...overrides };
}

function makeRequest(method: string, path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://contemplace-gardener.workers.dev${path}`, { method, headers });
}

// ── validateTriggerAuth ──────────────────────────────────────────────────────

describe('validateTriggerAuth', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null (success) for a valid Bearer token', () => {
    const req = makeRequest('POST', '/trigger', { Authorization: 'Bearer test-gardener-key' });
    const result = validateTriggerAuth(req, env());
    expect(result).toBeNull();
  });

  it('returns 401 when Authorization header is missing', () => {
    const req = makeRequest('POST', '/trigger');
    const result = validateTriggerAuth(req, env());
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('returns 401 when Authorization header does not start with Bearer', () => {
    const req = makeRequest('POST', '/trigger', { Authorization: 'Basic abc123' });
    const result = validateTriggerAuth(req, env());
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('returns 403 when the token is invalid', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const req = makeRequest('POST', '/trigger', { Authorization: 'Bearer wrong-key' });
    const result = validateTriggerAuth(req, env());
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
    expect(warnSpy).toHaveBeenCalledOnce();
  });

  it('returns 403 with message when GARDENER_API_KEY is not set', () => {
    const req = makeRequest('POST', '/trigger', { Authorization: 'Bearer some-key' });
    const result = validateTriggerAuth(req, env({ GARDENER_API_KEY: undefined }));
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it('returns 403 with "not configured" body when GARDENER_API_KEY is not set', async () => {
    const req = makeRequest('POST', '/trigger', { Authorization: 'Bearer some-key' });
    const result = validateTriggerAuth(req, env({ GARDENER_API_KEY: undefined }));
    const body = await result!.text();
    expect(body).toBe('Trigger endpoint not configured');
  });
});

// ── fetch handler (routing + integration) ────────────────────────────────────

describe('fetch handler', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // We import the default export which has fetch and scheduled
  async function callFetch(method: string, path: string, envOverrides: Partial<Env> = {}, headers: Record<string, string> = {}): Promise<Response> {
    // Dynamic import to allow vi.mock to take effect
    const mod = await import('../gardener/src/index');
    const req = makeRequest(method, path, headers);
    return mod.default.fetch(req, env(envOverrides));
  }

  it('returns 404 for unknown paths', async () => {
    const resp = await callFetch('POST', '/unknown', {}, { Authorization: 'Bearer test-gardener-key' });
    expect(resp.status).toBe(404);
  });

  it('returns 405 for GET /trigger', async () => {
    const resp = await callFetch('GET', '/trigger', {}, { Authorization: 'Bearer test-gardener-key' });
    expect(resp.status).toBe(405);
  });

  it('returns 405 for PUT /trigger', async () => {
    const resp = await callFetch('PUT', '/trigger', {}, { Authorization: 'Bearer test-gardener-key' });
    expect(resp.status).toBe(405);
  });

  it('returns 401 without auth header', async () => {
    const resp = await callFetch('POST', '/trigger');
    expect(resp.status).toBe(401);
  });

  it('returns 403 with wrong token', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const resp = await callFetch('POST', '/trigger', {}, { Authorization: 'Bearer wrong' });
    expect(resp.status).toBe(403);
  });

  it('returns 403 when GARDENER_API_KEY is not configured', async () => {
    const resp = await callFetch('POST', '/trigger', { GARDENER_API_KEY: undefined }, { Authorization: 'Bearer anything' });
    expect(resp.status).toBe(403);
    const body = await resp.text();
    expect(body).toBe('Trigger endpoint not configured');
  });
});

// ── runSimilarityLinker result shape ─────────────────────────────────────────

describe('runSimilarityLinker return type', () => {
  it('exports GardenerRunResult interface fields', async () => {
    // Verify the exported type exists by importing it
    const mod = await import('../gardener/src/index');
    expect(mod.runSimilarityLinker).toBeDefined();
    expect(typeof mod.runSimilarityLinker).toBe('function');
  });
});

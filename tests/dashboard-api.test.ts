import { describe, it, expect, vi } from 'vitest';
import { validateAuth, timingSafeEqual } from '../dashboard-api/src/auth';
import { loadConfig } from '../dashboard-api/src/config';
import type { Env } from '../dashboard-api/src/types';

// ── Auth helpers ─────────────────────────────────────────────────────────────

const VALID_KEY = 'dashboard-api-key-12345';

function makeRequest(authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers['Authorization'] = authHeader;
  return new Request('https://example.com/api/stats', { method: 'GET', headers });
}

// ── validateAuth ─────────────────────────────────────────────────────────────

describe('validateAuth', () => {
  it('returns null for a valid Bearer token', () => {
    const result = validateAuth(makeRequest(`Bearer ${VALID_KEY}`), VALID_KEY);
    expect(result).toBeNull();
  });

  it('returns 401 when Authorization header is missing', () => {
    const result = validateAuth(makeRequest(), VALID_KEY);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('returns 401 for non-Bearer scheme', () => {
    const result = validateAuth(makeRequest(`Token ${VALID_KEY}`), VALID_KEY);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('returns 401 for "Bearer" with no trailing space', () => {
    const result = validateAuth(makeRequest('Bearer'), VALID_KEY);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('returns 403 for wrong token', () => {
    const result = validateAuth(makeRequest('Bearer wrong-token'), VALID_KEY);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  it('returns 401 for empty Bearer token (trailing space only)', () => {
    const result = validateAuth(makeRequest('Bearer '), VALID_KEY);
    expect(result).not.toBeNull();
    // Fetch API may trim header values; either 401 or 403 is acceptable
    expect([401, 403]).toContain(result!.status);
  });

  it('logs warning on token mismatch', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateAuth(makeRequest('Bearer wrong-token'), VALID_KEY);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('does not log warning on success', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateAuth(makeRequest(`Bearer ${VALID_KEY}`), VALID_KEY);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ── timingSafeEqual ───────────────────────────────────────────────────────────

describe('timingSafeEqual', () => {
  it('returns true for identical strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
  });

  it('returns false for different strings of same length', () => {
    expect(timingSafeEqual('abc', 'xyz')).toBe(false);
  });

  it('returns false for strings of different length', () => {
    expect(timingSafeEqual('short', 'longer-string')).toBe(false);
  });

  it('returns true for empty strings', () => {
    expect(timingSafeEqual('', '')).toBe(true);
  });
});

// ── Config helpers ───────────────────────────────────────────────────────────

// Build test JWTs from parts to avoid secret-scanning false positives.
// These are fabricated tokens with signature "fakesig" — not real credentials.
const HEADER = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const ANON_PAYLOAD = btoa(JSON.stringify({ role: 'anon', iss: 'supabase' }));
const SERVICE_PAYLOAD = btoa(JSON.stringify({ role: 'service_role', iss: 'supabase' }));
const FAKE_SIG = 'fakesig';
const ANON_JWT = `${HEADER}.${ANON_PAYLOAD}.${FAKE_SIG}`;
const SERVICE_JWT = `${HEADER}.${SERVICE_PAYLOAD}.${FAKE_SIG}`;

const VALID_ENV: Env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  DASHBOARD_API_KEY: 'dash-key',
  CORS_ORIGIN: 'https://contemplace-dashboard.pages.dev',
  BACKUP_REPO: 'freegyes/contemplace-backup',
  GITHUB_BACKUP_PAT: 'ghp_testtoken',
};

function env(overrides: Partial<Record<keyof Env, string | undefined>> = {}): Env {
  return { ...VALID_ENV, ...overrides } as Env;
}

// ── loadConfig ───────────────────────────────────────────────────────────────

describe('loadConfig', () => {
  it('returns valid config when all secrets are present', () => {
    const config = loadConfig(VALID_ENV);
    expect(config.supabaseUrl).toBe('https://example.supabase.co');
    expect(config.supabaseServiceRoleKey).toBe('service-key');
    expect(config.dashboardApiKey).toBe('dash-key');
    expect(config.corsOrigin).toBe('https://contemplace-dashboard.pages.dev');
    expect(config.backupRepo).toBe('freegyes/contemplace-backup');
    expect(config.githubBackupPat).toBe('ghp_testtoken');
  });

  it('throws when SUPABASE_URL is missing', () => {
    expect(() => loadConfig(env({ SUPABASE_URL: undefined }))).toThrow('SUPABASE_URL');
  });

  it('throws when SUPABASE_SERVICE_ROLE_KEY is missing', () => {
    expect(() => loadConfig(env({ SUPABASE_SERVICE_ROLE_KEY: undefined }))).toThrow('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('throws when DASHBOARD_API_KEY is missing', () => {
    expect(() => loadConfig(env({ DASHBOARD_API_KEY: undefined }))).toThrow('DASHBOARD_API_KEY');
  });

  it('throws when SUPABASE_SERVICE_ROLE_KEY is an anon JWT', () => {
    expect(() => loadConfig(env({ SUPABASE_SERVICE_ROLE_KEY: ANON_JWT }))).toThrow('expected "service_role"');
  });

  it('accepts a service_role JWT for SUPABASE_SERVICE_ROLE_KEY', () => {
    const config = loadConfig(env({ SUPABASE_SERVICE_ROLE_KEY: SERVICE_JWT }));
    expect(config.supabaseServiceRoleKey).toBe(SERVICE_JWT);
  });

  it('accepts a non-JWT string for SUPABASE_SERVICE_ROLE_KEY', () => {
    const config = loadConfig(env({ SUPABASE_SERVICE_ROLE_KEY: 'plain-key' }));
    expect(config.supabaseServiceRoleKey).toBe('plain-key');
  });

  it('defaults corsOrigin to "*" when CORS_ORIGIN is empty', () => {
    const config = loadConfig(env({ CORS_ORIGIN: '' }));
    expect(config.corsOrigin).toBe('*');
  });

  it('defaults backupRepo to empty string when BACKUP_REPO is absent', () => {
    const config = loadConfig(env({ BACKUP_REPO: undefined }));
    expect(config.backupRepo).toBe('');
  });

  it('includes GITHUB_BACKUP_PAT when set', () => {
    const config = loadConfig(env({ GITHUB_BACKUP_PAT: 'ghp_abc123' }));
    expect(config.githubBackupPat).toBe('ghp_abc123');
  });

  it('returns null for GITHUB_BACKUP_PAT when not set', () => {
    const config = loadConfig(env({ GITHUB_BACKUP_PAT: undefined }));
    expect(config.githubBackupPat).toBeNull();
  });
});

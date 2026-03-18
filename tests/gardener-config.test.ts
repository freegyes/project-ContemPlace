import { describe, it, expect } from 'vitest';
import { loadConfig } from '../gardener/src/config';
import type { Env } from '../gardener/src/types';

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
  GARDENER_SIMILARITY_THRESHOLD: '0.65',
};

function env(overrides: Partial<Record<keyof Env, string | undefined>> = {}): Env {
  return { ...VALID_ENV, ...overrides } as Env;
}

describe('loadConfig', () => {
  it('returns a valid Config when all required secrets are present', () => {
    const config = loadConfig(VALID_ENV);
    expect(config.supabaseUrl).toBe('https://example.supabase.co');
    expect(config.supabaseServiceRoleKey).toBe('service-key');
    expect(config.similarityThreshold).toBe(0.65);
  });

  it('throws mentioning SUPABASE_URL when missing', () => {
    expect(() => loadConfig(env({ SUPABASE_URL: undefined }))).toThrow('SUPABASE_URL');
  });

  it('throws mentioning SUPABASE_URL when empty string', () => {
    expect(() => loadConfig(env({ SUPABASE_URL: '' }))).toThrow('SUPABASE_URL');
  });

  it('throws mentioning SUPABASE_SERVICE_ROLE_KEY when missing', () => {
    expect(() => loadConfig(env({ SUPABASE_SERVICE_ROLE_KEY: undefined }))).toThrow('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('uses 0.65 as default threshold when GARDENER_SIMILARITY_THRESHOLD is absent', () => {
    const config = loadConfig(env({ GARDENER_SIMILARITY_THRESHOLD: undefined }));
    expect(config.similarityThreshold).toBe(0.65);
  });

  it('uses 0.65 as default threshold when GARDENER_SIMILARITY_THRESHOLD is empty', () => {
    const config = loadConfig(env({ GARDENER_SIMILARITY_THRESHOLD: '' }));
    expect(config.similarityThreshold).toBe(0.65);
  });

  it('parses a valid GARDENER_SIMILARITY_THRESHOLD float', () => {
    const config = loadConfig(env({ GARDENER_SIMILARITY_THRESHOLD: '0.80' }));
    expect(config.similarityThreshold).toBe(0.80);
  });

  it('accepts 0 as a valid threshold', () => {
    const config = loadConfig(env({ GARDENER_SIMILARITY_THRESHOLD: '0' }));
    expect(config.similarityThreshold).toBe(0);
  });

  it('accepts 1 as a valid threshold', () => {
    const config = loadConfig(env({ GARDENER_SIMILARITY_THRESHOLD: '1' }));
    expect(config.similarityThreshold).toBe(1);
  });

  it('throws mentioning GARDENER_SIMILARITY_THRESHOLD when not a number', () => {
    expect(() => loadConfig(env({ GARDENER_SIMILARITY_THRESHOLD: 'not-a-number' }))).toThrow('GARDENER_SIMILARITY_THRESHOLD');
  });

  it('throws mentioning GARDENER_SIMILARITY_THRESHOLD when below 0', () => {
    expect(() => loadConfig(env({ GARDENER_SIMILARITY_THRESHOLD: '-0.1' }))).toThrow('GARDENER_SIMILARITY_THRESHOLD');
  });

  it('throws mentioning GARDENER_SIMILARITY_THRESHOLD when above 1', () => {
    expect(() => loadConfig(env({ GARDENER_SIMILARITY_THRESHOLD: '1.1' }))).toThrow('GARDENER_SIMILARITY_THRESHOLD');
  });

  it('throws when SUPABASE_SERVICE_ROLE_KEY is an anon key JWT', () => {
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
});

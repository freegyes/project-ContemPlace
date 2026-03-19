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
  GARDENER_COSINE_FLOOR: '0.40',
  GARDENER_CLUSTER_RESOLUTIONS: '1.0,1.5,2.0',
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
    expect(config.cosineFloor).toBe(0.40);
    expect(config.clusterResolutions).toEqual([1.0, 1.5, 2.0]);
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

  // ── GARDENER_COSINE_FLOOR ───────────────────────────────────────────────────

  it('uses 0.40 as default cosineFloor when GARDENER_COSINE_FLOOR is absent', () => {
    const config = loadConfig(env({ GARDENER_COSINE_FLOOR: undefined }));
    expect(config.cosineFloor).toBe(0.40);
  });

  it('parses a valid GARDENER_COSINE_FLOOR', () => {
    const config = loadConfig(env({ GARDENER_COSINE_FLOOR: '0.35' }));
    expect(config.cosineFloor).toBe(0.35);
  });

  it('throws when GARDENER_COSINE_FLOOR is not a number', () => {
    expect(() => loadConfig(env({ GARDENER_COSINE_FLOOR: 'bad' }))).toThrow('GARDENER_COSINE_FLOOR');
  });

  it('throws when GARDENER_COSINE_FLOOR is above 1', () => {
    expect(() => loadConfig(env({ GARDENER_COSINE_FLOOR: '1.5' }))).toThrow('GARDENER_COSINE_FLOOR');
  });

  // ── GARDENER_CLUSTER_RESOLUTIONS ────────────────────────────────────────────

  it('uses [1.0, 1.5, 2.0] as default resolutions when absent', () => {
    const config = loadConfig(env({ GARDENER_CLUSTER_RESOLUTIONS: undefined }));
    expect(config.clusterResolutions).toEqual([1.0, 1.5, 2.0]);
  });

  it('parses comma-separated resolutions', () => {
    const config = loadConfig(env({ GARDENER_CLUSTER_RESOLUTIONS: '0.5,1.0' }));
    expect(config.clusterResolutions).toEqual([0.5, 1.0]);
  });

  it('handles single resolution value', () => {
    const config = loadConfig(env({ GARDENER_CLUSTER_RESOLUTIONS: '2.0' }));
    expect(config.clusterResolutions).toEqual([2.0]);
  });

  it('trims whitespace in resolutions', () => {
    const config = loadConfig(env({ GARDENER_CLUSTER_RESOLUTIONS: ' 1.0 , 2.0 ' }));
    expect(config.clusterResolutions).toEqual([1.0, 2.0]);
  });

  it('throws when resolutions contain non-numeric values', () => {
    expect(() => loadConfig(env({ GARDENER_CLUSTER_RESOLUTIONS: '1.0,bad' }))).toThrow('GARDENER_CLUSTER_RESOLUTIONS');
  });

  it('throws when resolutions contain zero', () => {
    expect(() => loadConfig(env({ GARDENER_CLUSTER_RESOLUTIONS: '0' }))).toThrow('GARDENER_CLUSTER_RESOLUTIONS');
  });

  it('throws when resolutions contain negative values', () => {
    expect(() => loadConfig(env({ GARDENER_CLUSTER_RESOLUTIONS: '-1.0' }))).toThrow('GARDENER_CLUSTER_RESOLUTIONS');
  });

  // ── Entity extraction config ────────────────────────────────────────────────

  it('returns null entityConfig when OPENROUTER_API_KEY is absent', () => {
    const config = loadConfig(VALID_ENV);
    expect(config.entityConfig).toBeNull();
  });

  it('returns entityConfig with defaults when OPENROUTER_API_KEY is set', () => {
    const config = loadConfig(env({ OPENROUTER_API_KEY: 'or-test-key' }));
    expect(config.entityConfig).not.toBeNull();
    expect(config.entityConfig!.openrouterApiKey).toBe('or-test-key');
    expect(config.entityConfig!.entityModel).toBe('anthropic/claude-haiku-4-5');
    expect(config.entityConfig!.entityBatchSize).toBe(50);
  });

  it('uses custom entity model when GARDENER_ENTITY_MODEL is set', () => {
    const config = loadConfig(env({
      OPENROUTER_API_KEY: 'or-test-key',
      GARDENER_ENTITY_MODEL: 'openai/gpt-4o-mini',
    }));
    expect(config.entityConfig!.entityModel).toBe('openai/gpt-4o-mini');
  });

  it('uses custom batch size when GARDENER_ENTITY_BATCH_SIZE is set', () => {
    const config = loadConfig(env({
      OPENROUTER_API_KEY: 'or-test-key',
      GARDENER_ENTITY_BATCH_SIZE: '20',
    }));
    expect(config.entityConfig!.entityBatchSize).toBe(20);
  });

  it('accepts 0 as unlimited batch size', () => {
    const config = loadConfig(env({
      OPENROUTER_API_KEY: 'or-test-key',
      GARDENER_ENTITY_BATCH_SIZE: '0',
    }));
    expect(config.entityConfig!.entityBatchSize).toBe(0);
  });

  it('throws when GARDENER_ENTITY_BATCH_SIZE is not a number', () => {
    expect(() => loadConfig(env({
      OPENROUTER_API_KEY: 'or-test-key',
      GARDENER_ENTITY_BATCH_SIZE: 'bad',
    }))).toThrow('GARDENER_ENTITY_BATCH_SIZE');
  });

  it('throws when GARDENER_ENTITY_BATCH_SIZE is negative', () => {
    expect(() => loadConfig(env({
      OPENROUTER_API_KEY: 'or-test-key',
      GARDENER_ENTITY_BATCH_SIZE: '-1',
    }))).toThrow('GARDENER_ENTITY_BATCH_SIZE');
  });
});

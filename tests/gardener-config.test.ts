import { describe, it, expect } from 'vitest';
import { loadConfig } from '../gardener/src/config';
import type { Env } from '../gardener/src/types';

const VALID_ENV: Env = {
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  GARDENER_SIMILARITY_THRESHOLD: '0.70',
  GARDENER_TAG_MATCH_THRESHOLD: '0.55',
};

function env(overrides: Partial<Record<keyof Env, string | undefined>> = {}): Env {
  return { ...VALID_ENV, ...overrides } as Env;
}

describe('loadConfig', () => {
  it('returns a valid Config when all required secrets are present', () => {
    const config = loadConfig(VALID_ENV);
    expect(config.supabaseUrl).toBe('https://example.supabase.co');
    expect(config.supabaseServiceRoleKey).toBe('service-key');
    expect(config.similarityThreshold).toBe(0.70);
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

  it('uses 0.70 as default threshold when GARDENER_SIMILARITY_THRESHOLD is absent', () => {
    const config = loadConfig(env({ GARDENER_SIMILARITY_THRESHOLD: undefined }));
    expect(config.similarityThreshold).toBe(0.70);
  });

  it('uses 0.70 as default threshold when GARDENER_SIMILARITY_THRESHOLD is empty', () => {
    const config = loadConfig(env({ GARDENER_SIMILARITY_THRESHOLD: '' }));
    expect(config.similarityThreshold).toBe(0.70);
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

  // ── Tag match threshold ───────────────────────────────────────────────────

  it('uses 0.55 as default tagMatchThreshold when GARDENER_TAG_MATCH_THRESHOLD is absent', () => {
    const config = loadConfig(env({ GARDENER_TAG_MATCH_THRESHOLD: undefined }));
    expect(config.tagMatchThreshold).toBe(0.55);
  });

  it('parses a valid GARDENER_TAG_MATCH_THRESHOLD float', () => {
    const config = loadConfig(env({ GARDENER_TAG_MATCH_THRESHOLD: '0.60' }));
    expect(config.tagMatchThreshold).toBe(0.60);
  });

  it('throws mentioning GARDENER_TAG_MATCH_THRESHOLD when not a number', () => {
    expect(() => loadConfig(env({ GARDENER_TAG_MATCH_THRESHOLD: 'bad' }))).toThrow('GARDENER_TAG_MATCH_THRESHOLD');
  });

  // ── Optional OpenRouter config ────────────────────────────────────────────

  it('returns null for openrouterApiKey when OPENROUTER_API_KEY is absent', () => {
    const config = loadConfig(VALID_ENV);
    expect(config.openrouterApiKey).toBeNull();
  });

  it('returns the key when OPENROUTER_API_KEY is set', () => {
    const config = loadConfig(env({ OPENROUTER_API_KEY: 'or-key-123' }));
    expect(config.openrouterApiKey).toBe('or-key-123');
  });

  it('uses default embed model when EMBED_MODEL is absent', () => {
    const config = loadConfig(VALID_ENV);
    expect(config.embedModel).toBe('openai/text-embedding-3-small');
  });

  it('uses custom EMBED_MODEL when set', () => {
    const config = loadConfig(env({ EMBED_MODEL: 'custom/model' }));
    expect(config.embedModel).toBe('custom/model');
  });
});

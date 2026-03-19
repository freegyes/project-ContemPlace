import { describe, it, expect } from 'vitest';
import { loadConfig } from '../mcp/src/config';
import type { Env } from '../mcp/src/types';

// Build test JWTs from parts to avoid secret-scanning false positives.
// These are fabricated tokens with signature "fakesig" — not real credentials.
const HEADER = btoa(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const ANON_PAYLOAD = btoa(JSON.stringify({ role: 'anon', iss: 'supabase' }));
const SERVICE_PAYLOAD = btoa(JSON.stringify({ role: 'service_role', iss: 'supabase' }));
const FAKE_SIG = 'fakesig';
const ANON_JWT = `${HEADER}.${ANON_PAYLOAD}.${FAKE_SIG}`;
const SERVICE_JWT = `${HEADER}.${SERVICE_PAYLOAD}.${FAKE_SIG}`;

const VALID_ENV: Env = {
  MCP_API_KEY: 'key',
  OPENROUTER_API_KEY: 'or-key',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  CAPTURE_MODEL: 'anthropic/claude-haiku-4-5',
  EMBED_MODEL: 'openai/text-embedding-3-small',
  MATCH_THRESHOLD: '0.60',
};

function env(overrides: Partial<Record<keyof Env, string | undefined>> = {}): Env {
  return { ...VALID_ENV, ...overrides } as Env;
}

describe('loadConfig', () => {
  it('returns a valid Config when all required secrets are present', () => {
    const config = loadConfig(VALID_ENV);
    expect(config.mcpApiKey).toBe('key');
    expect(config.openrouterApiKey).toBe('or-key');
    expect(config.supabaseUrl).toBe('https://example.supabase.co');
    expect(config.supabaseServiceRoleKey).toBe('service-key');
    expect(config.captureModel).toBe('anthropic/claude-haiku-4-5');
    expect(config.embedModel).toBe('openai/text-embedding-3-small');
    expect(config.matchThreshold).toBe(0.60);
    expect(config.searchThreshold).toBe(0.35);
  });

  it('throws mentioning MCP_API_KEY when missing', () => {
    expect(() => loadConfig(env({ MCP_API_KEY: undefined }))).toThrow('MCP_API_KEY');
  });

  it('throws mentioning OPENROUTER_API_KEY when missing', () => {
    expect(() => loadConfig(env({ OPENROUTER_API_KEY: undefined }))).toThrow('OPENROUTER_API_KEY');
  });

  it('throws mentioning SUPABASE_URL when missing', () => {
    expect(() => loadConfig(env({ SUPABASE_URL: undefined }))).toThrow('SUPABASE_URL');
  });

  it('throws mentioning SUPABASE_SERVICE_ROLE_KEY when missing', () => {
    expect(() => loadConfig(env({ SUPABASE_SERVICE_ROLE_KEY: undefined }))).toThrow('SUPABASE_SERVICE_ROLE_KEY');
  });

  it('uses default captureModel when CAPTURE_MODEL is empty', () => {
    const config = loadConfig(env({ CAPTURE_MODEL: '' }));
    expect(config.captureModel).toBe('anthropic/claude-haiku-4-5');
  });

  it('uses default embedModel when EMBED_MODEL is empty', () => {
    const config = loadConfig(env({ EMBED_MODEL: '' }));
    expect(config.embedModel).toBe('openai/text-embedding-3-small');
  });

  it('uses 0.60 as default matchThreshold when MATCH_THRESHOLD is empty', () => {
    const config = loadConfig(env({ MATCH_THRESHOLD: '' }));
    expect(config.matchThreshold).toBe(0.60);
  });

  it('parses a valid MATCH_THRESHOLD float', () => {
    const config = loadConfig(env({ MATCH_THRESHOLD: '0.75' }));
    expect(config.matchThreshold).toBe(0.75);
  });

  it('throws when MATCH_THRESHOLD is not a number', () => {
    expect(() => loadConfig(env({ MATCH_THRESHOLD: 'not-a-number' }))).toThrow('MATCH_THRESHOLD');
  });

  it('throws when MATCH_THRESHOLD is below 0', () => {
    expect(() => loadConfig(env({ MATCH_THRESHOLD: '-0.1' }))).toThrow('MATCH_THRESHOLD');
  });

  it('throws when MATCH_THRESHOLD is above 1', () => {
    expect(() => loadConfig(env({ MATCH_THRESHOLD: '1.1' }))).toThrow('MATCH_THRESHOLD');
  });

  it('accepts 0 as a valid MATCH_THRESHOLD', () => {
    const config = loadConfig(env({ MATCH_THRESHOLD: '0' }));
    expect(config.matchThreshold).toBe(0);
  });

  it('accepts 1 as a valid MATCH_THRESHOLD', () => {
    const config = loadConfig(env({ MATCH_THRESHOLD: '1' }));
    expect(config.matchThreshold).toBe(1);
  });

  it('uses 0.35 as default searchThreshold when MCP_SEARCH_THRESHOLD is absent', () => {
    const config = loadConfig(env({ MCP_SEARCH_THRESHOLD: undefined }));
    expect(config.searchThreshold).toBe(0.35);
  });

  it('parses a valid MCP_SEARCH_THRESHOLD float', () => {
    const config = loadConfig(env({ MCP_SEARCH_THRESHOLD: '0.45' }));
    expect(config.searchThreshold).toBe(0.45);
  });

  it('throws mentioning MCP_SEARCH_THRESHOLD when invalid', () => {
    expect(() => loadConfig(env({ MCP_SEARCH_THRESHOLD: 'bad' }))).toThrow('MCP_SEARCH_THRESHOLD');
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

  it('uses 11 as default hardDeleteWindowMinutes when HARD_DELETE_WINDOW_MINUTES is absent', () => {
    const config = loadConfig(env({ HARD_DELETE_WINDOW_MINUTES: undefined }));
    expect(config.hardDeleteWindowMinutes).toBe(11);
  });

  it('parses a valid HARD_DELETE_WINDOW_MINUTES integer', () => {
    const config = loadConfig(env({ HARD_DELETE_WINDOW_MINUTES: '30' }));
    expect(config.hardDeleteWindowMinutes).toBe(30);
  });

  it('accepts 0 as a valid HARD_DELETE_WINDOW_MINUTES (always hard-delete)', () => {
    const config = loadConfig(env({ HARD_DELETE_WINDOW_MINUTES: '0' }));
    expect(config.hardDeleteWindowMinutes).toBe(0);
  });

  it('throws when HARD_DELETE_WINDOW_MINUTES is negative', () => {
    expect(() => loadConfig(env({ HARD_DELETE_WINDOW_MINUTES: '-1' }))).toThrow('HARD_DELETE_WINDOW_MINUTES');
  });

  it('throws when HARD_DELETE_WINDOW_MINUTES is not a number', () => {
    expect(() => loadConfig(env({ HARD_DELETE_WINDOW_MINUTES: 'bad' }))).toThrow('HARD_DELETE_WINDOW_MINUTES');
  });

  it('uses 5 as default recentFragmentsCount when RECENT_FRAGMENTS_COUNT is absent', () => {
    const config = loadConfig(env({ RECENT_FRAGMENTS_COUNT: undefined }));
    expect(config.recentFragmentsCount).toBe(5);
  });

  it('parses a valid RECENT_FRAGMENTS_COUNT integer', () => {
    const config = loadConfig(env({ RECENT_FRAGMENTS_COUNT: '3' }));
    expect(config.recentFragmentsCount).toBe(3);
  });

  it('accepts 0 as a valid RECENT_FRAGMENTS_COUNT (feature disabled)', () => {
    const config = loadConfig(env({ RECENT_FRAGMENTS_COUNT: '0' }));
    expect(config.recentFragmentsCount).toBe(0);
  });

  it('throws when RECENT_FRAGMENTS_COUNT is negative', () => {
    expect(() => loadConfig(env({ RECENT_FRAGMENTS_COUNT: '-1' }))).toThrow('RECENT_FRAGMENTS_COUNT');
  });

  it('throws when RECENT_FRAGMENTS_COUNT is not a number', () => {
    expect(() => loadConfig(env({ RECENT_FRAGMENTS_COUNT: 'bad' }))).toThrow('RECENT_FRAGMENTS_COUNT');
  });

  it('uses 60 as default recentFragmentsWindowMinutes when RECENT_FRAGMENTS_WINDOW_MINUTES is absent', () => {
    const config = loadConfig(env({ RECENT_FRAGMENTS_WINDOW_MINUTES: undefined }));
    expect(config.recentFragmentsWindowMinutes).toBe(60);
  });

  it('parses a valid RECENT_FRAGMENTS_WINDOW_MINUTES integer', () => {
    const config = loadConfig(env({ RECENT_FRAGMENTS_WINDOW_MINUTES: '30' }));
    expect(config.recentFragmentsWindowMinutes).toBe(30);
  });

  it('accepts 0 as a valid RECENT_FRAGMENTS_WINDOW_MINUTES (no time filter)', () => {
    const config = loadConfig(env({ RECENT_FRAGMENTS_WINDOW_MINUTES: '0' }));
    expect(config.recentFragmentsWindowMinutes).toBe(0);
  });

  it('throws when RECENT_FRAGMENTS_WINDOW_MINUTES is negative', () => {
    expect(() => loadConfig(env({ RECENT_FRAGMENTS_WINDOW_MINUTES: '-1' }))).toThrow('RECENT_FRAGMENTS_WINDOW_MINUTES');
  });

  it('throws when RECENT_FRAGMENTS_WINDOW_MINUTES is not a number', () => {
    expect(() => loadConfig(env({ RECENT_FRAGMENTS_WINDOW_MINUTES: 'bad' }))).toThrow('RECENT_FRAGMENTS_WINDOW_MINUTES');
  });
});

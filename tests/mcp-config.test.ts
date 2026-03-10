import { describe, it, expect } from 'vitest';
import { loadConfig } from '../mcp/src/config';
import type { Env } from '../mcp/src/types';

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
});

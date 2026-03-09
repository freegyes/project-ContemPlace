import type { Env } from './types';

export interface Config {
  mcpApiKey: string;
  openrouterApiKey: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  captureModel: string;
  embedModel: string;
  matchThreshold: number;
}

export function loadConfig(env: Env): Config {
  return {
    mcpApiKey: requireSecret(env.MCP_API_KEY, 'MCP_API_KEY'),
    openrouterApiKey: requireSecret(env.OPENROUTER_API_KEY, 'OPENROUTER_API_KEY'),
    supabaseUrl: requireSecret(env.SUPABASE_URL, 'SUPABASE_URL'),
    supabaseServiceRoleKey: requireSecret(env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY'),
    captureModel: env.CAPTURE_MODEL || 'anthropic/claude-haiku-4-5',
    embedModel: env.EMBED_MODEL || 'openai/text-embedding-3-small',
    matchThreshold: parseAndValidateThreshold(env.MATCH_THRESHOLD),
  };
}

function requireSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing required secret: ${name}`);
  return value;
}

function parseAndValidateThreshold(value: string | undefined): number {
  const parsed = parseFloat(value || '0.60');
  if (isNaN(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Invalid MATCH_THRESHOLD: "${value}" — must be a float between 0 and 1`);
  }
  return parsed;
}

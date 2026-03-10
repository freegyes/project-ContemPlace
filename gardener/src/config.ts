import type { Env } from './types';

export interface Config {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  similarityThreshold: number;
  tagMatchThreshold: number;
  // Optional — null when OPENROUTER_API_KEY is not set (lexical-only mode)
  openrouterApiKey: string | null;
  embedModel: string;
}

export function loadConfig(env: Env): Config {
  return {
    supabaseUrl: requireSecret(env.SUPABASE_URL, 'SUPABASE_URL'),
    supabaseServiceRoleKey: requireSecret(env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY'),
    similarityThreshold: parseThreshold(env.GARDENER_SIMILARITY_THRESHOLD, 0.70),
    tagMatchThreshold: parseThreshold(env.GARDENER_TAG_MATCH_THRESHOLD, 0.55),
    openrouterApiKey: env.OPENROUTER_API_KEY || null,
    embedModel: env.EMBED_MODEL || 'openai/text-embedding-3-small',
  };
}

function requireSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing required secret: ${name}`);
  return value;
}

function parseThreshold(value: string | undefined, defaultValue: number): number {
  const parsed = parseFloat(value || String(defaultValue));
  if (isNaN(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Invalid GARDENER_SIMILARITY_THRESHOLD: "${value}" — must be a float between 0 and 1`);
  }
  return parsed;
}

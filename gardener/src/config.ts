import type { Env } from './types';

export interface Config {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  similarityThreshold: number;
}

export function loadConfig(env: Env): Config {
  return {
    supabaseUrl: requireSecret(env.SUPABASE_URL, 'SUPABASE_URL'),
    supabaseServiceRoleKey: requireSecret(env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY'),
    similarityThreshold: parseThreshold(env.GARDENER_SIMILARITY_THRESHOLD, 0.70),
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

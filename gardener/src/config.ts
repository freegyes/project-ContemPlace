import type { Env } from './types';

export interface Config {
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  similarityThreshold: number;
}

export function loadConfig(env: Env): Config {
  const supabaseServiceRoleKey = requireSecret(env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY');
  validateServiceRoleKey(supabaseServiceRoleKey);
  return {
    supabaseUrl: requireSecret(env.SUPABASE_URL, 'SUPABASE_URL'),
    supabaseServiceRoleKey,
    similarityThreshold: parseThreshold(env.GARDENER_SIMILARITY_THRESHOLD, 0.65, 'GARDENER_SIMILARITY_THRESHOLD'),
  };
}

function requireSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing required secret: ${name}`);
  return value;
}

function validateServiceRoleKey(key: string): void {
  const parts = key.split('.');
  if (parts.length !== 3) return;
  try {
    const payload = parts[1];
    if (!payload) return;
    const json = atob(payload.replace(/-/g, '+').replace(/_/g, '/'));
    const claims = JSON.parse(json);
    if (claims.role && claims.role !== 'service_role') {
      throw new Error(
        `SUPABASE_SERVICE_ROLE_KEY has role "${claims.role}" — expected "service_role". ` +
        `Check Supabase dashboard → Project Settings → API → service_role (click Reveal).`
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.includes('SUPABASE_SERVICE_ROLE_KEY')) throw e;
  }
}

function parseThreshold(value: string | undefined, defaultValue: number, varName: string): number {
  const parsed = parseFloat(value || String(defaultValue));
  if (isNaN(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Invalid ${varName}: "${value}" — must be a float between 0 and 1`);
  }
  return parsed;
}

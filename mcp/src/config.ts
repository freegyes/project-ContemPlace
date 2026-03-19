import type { Env } from './types';

export interface Config {
  mcpApiKey: string;
  openrouterApiKey: string;
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
  captureModel: string;
  embedModel: string;
  matchThreshold: number;
  searchThreshold: number;
  hardDeleteWindowMinutes: number;
  recentFragmentsCount: number;
  recentFragmentsWindowMinutes: number;
  gardenerUrl: string | null;
  gardenerApiKey: string | null;
  gardeningCooldownMinutes: number;
}

export function loadConfig(env: Env): Config {
  const supabaseServiceRoleKey = requireSecret(env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY');
  validateServiceRoleKey(supabaseServiceRoleKey);
  return {
    mcpApiKey: requireSecret(env.MCP_API_KEY, 'MCP_API_KEY'),
    openrouterApiKey: requireSecret(env.OPENROUTER_API_KEY, 'OPENROUTER_API_KEY'),
    supabaseUrl: requireSecret(env.SUPABASE_URL, 'SUPABASE_URL'),
    supabaseServiceRoleKey,
    captureModel: env.CAPTURE_MODEL || 'anthropic/claude-haiku-4-5',
    embedModel: env.EMBED_MODEL || 'openai/text-embedding-3-small',
    matchThreshold: parseAndValidateThreshold(env.MATCH_THRESHOLD, 0.60, 'MATCH_THRESHOLD'),
    searchThreshold: parseAndValidateThreshold(env.MCP_SEARCH_THRESHOLD, 0.35, 'MCP_SEARCH_THRESHOLD'),
    hardDeleteWindowMinutes: parsePositiveInt(env.HARD_DELETE_WINDOW_MINUTES, 11, 'HARD_DELETE_WINDOW_MINUTES'),
    recentFragmentsCount: parsePositiveInt(env.RECENT_FRAGMENTS_COUNT, 5, 'RECENT_FRAGMENTS_COUNT'),
    recentFragmentsWindowMinutes: parsePositiveInt(env.RECENT_FRAGMENTS_WINDOW_MINUTES, 60, 'RECENT_FRAGMENTS_WINDOW_MINUTES'),
    gardenerUrl: env.GARDENER_WORKER_URL && env.GARDENER_API_KEY ? env.GARDENER_WORKER_URL : null,
    gardenerApiKey: env.GARDENER_WORKER_URL && env.GARDENER_API_KEY ? env.GARDENER_API_KEY : null,
    gardeningCooldownMinutes: parsePositiveInt(env.GARDENING_COOLDOWN_MINUTES, 5, 'GARDENING_COOLDOWN_MINUTES'),
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

function parsePositiveInt(value: string | undefined, defaultValue: number, varName: string): number {
  const parsed = parseInt(value || String(defaultValue), 10);
  if (isNaN(parsed) || parsed < 0) {
    throw new Error(`Invalid ${varName}: "${value}" — must be a non-negative integer`);
  }
  return parsed;
}

function parseAndValidateThreshold(value: string | undefined, defaultValue: number, varName: string): number {
  const parsed = parseFloat(value || String(defaultValue));
  if (isNaN(parsed) || parsed < 0 || parsed > 1) {
    throw new Error(`Invalid ${varName}: "${value}" — must be a float between 0 and 1`);
  }
  return parsed;
}

import type { Env } from './types';

export interface Config {
  telegramBotToken: string;
  telegramWebhookSecret: string;
  allowedChatIds: number[];
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
}

export function loadConfig(env: Env): Config {
  const supabaseServiceRoleKey = requireSecret(env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY');
  validateServiceRoleKey(supabaseServiceRoleKey);
  return {
    telegramBotToken: requireSecret(env.TELEGRAM_BOT_TOKEN, 'TELEGRAM_BOT_TOKEN'),
    telegramWebhookSecret: requireSecret(env.TELEGRAM_WEBHOOK_SECRET, 'TELEGRAM_WEBHOOK_SECRET'),
    allowedChatIds: (env.ALLOWED_CHAT_IDS || '').split(',').map(Number).filter(Boolean),
    supabaseUrl: requireSecret(env.SUPABASE_URL, 'SUPABASE_URL'),
    supabaseServiceRoleKey,
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

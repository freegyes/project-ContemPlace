import type { Env } from './types';

export interface Config {
  telegramBotToken: string;
  telegramWebhookSecret: string;
  allowedChatIds: number[];
  supabaseUrl: string;
  supabaseServiceRoleKey: string;
}

export function loadConfig(env: Env): Config {
  return {
    telegramBotToken: requireSecret(env.TELEGRAM_BOT_TOKEN, 'TELEGRAM_BOT_TOKEN'),
    telegramWebhookSecret: requireSecret(env.TELEGRAM_WEBHOOK_SECRET, 'TELEGRAM_WEBHOOK_SECRET'),
    allowedChatIds: (env.ALLOWED_CHAT_IDS || '').split(',').map(Number).filter(Boolean),
    supabaseUrl: requireSecret(env.SUPABASE_URL, 'SUPABASE_URL'),
    supabaseServiceRoleKey: requireSecret(env.SUPABASE_SERVICE_ROLE_KEY, 'SUPABASE_SERVICE_ROLE_KEY'),
  };
}

function requireSecret(value: string | undefined, name: string): string {
  if (!value) throw new Error(`Missing required secret: ${name}`);
  return value;
}

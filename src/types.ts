// ── Cloudflare Worker Env ───────────────────────────────────────────────────

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  OPENROUTER_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  ALLOWED_CHAT_IDS: string;
  CAPTURE_MODEL: string;
  EMBED_MODEL: string;
  MATCH_THRESHOLD: string;
}

// ── Telegram Types ──────────────────────────────────────────────────────────

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  sticker?: unknown;
  photo?: unknown[];
  audio?: unknown;
  voice?: unknown;
  document?: unknown;
  forward_origin?: unknown;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: unknown;
  callback_query?: unknown;
}

// ── Note Types ──────────────────────────────────────────────────────────────

export type NoteType = 'idea' | 'reflection' | 'source' | 'lookup';
export type LinkType = 'extends' | 'contradicts' | 'supports' | 'is-example-of';

export interface CaptureLink {
  to_id: string;
  link_type: LinkType;
}

export interface CaptureResult {
  title: string;
  body: string;
  type: NoteType;
  tags: string[];
  source_ref: string | null;
  links: CaptureLink[];
  corrections: string[] | null;
}

export interface MatchedNote {
  id: string;
  title: string;
  body: string;
  type: string;
  tags: string[];
  source_ref: string | null;
  source: string;
  created_at: string;
  similarity: number;
}

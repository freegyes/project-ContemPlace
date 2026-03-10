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

// Capture-time link types (LLM-assigned)
export type CaptureLinkType = 'extends' | 'contradicts' | 'supports' | 'is-example-of' | 'duplicate-of';

// All link types (capture + gardening)
export type LinkType = CaptureLinkType
  | 'is-similar-to' | 'is-part-of' | 'follows' | 'is-derived-from';

// 6 values — 'wish' merged into 'plan' [Review fix 10-§2]
export type Intent = 'reflect' | 'plan' | 'create' | 'remember' | 'reference' | 'log';

export type Modality = 'text' | 'link' | 'list' | 'mixed';

export interface Entity {
  name: string;
  type: 'person' | 'place' | 'tool' | 'project' | 'concept';
}

export interface CaptureLink {
  to_id: string;
  link_type: CaptureLinkType;
}

export interface CaptureResult {
  title: string;
  body: string;
  type: NoteType;
  tags: string[];
  source_ref: string | null;
  links: CaptureLink[];
  corrections: string[] | null;
  intent: Intent;
  modality: Modality;
  entities: Entity[];
}

export interface MatchedNote {
  id: string;
  title: string;
  body: string;
  raw_input: string;
  type: string;
  tags: string[];
  source_ref: string | null;
  source: string;
  intent: string | null;
  modality: string | null;
  entities: unknown;
  created_at: string;
  similarity: number;
}

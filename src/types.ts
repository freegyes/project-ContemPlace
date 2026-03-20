// ── Cloudflare Worker Env ───────────────────────────────────────────────────

// CaptureService stub for Service Binding typing.
// The actual implementation lives in mcp/src/index.ts (WorkerEntrypoint).
// At runtime, Cloudflare resolves this via the [[services]] binding in wrangler.toml.
export interface UndoResult {
  action: 'deleted' | 'grace_period_passed' | 'none';
  title?: string;
  id?: string;
}

export interface CaptureServiceStub {
  capture(rawInput: string, source: string, options?: { imageUrl?: string }): Promise<ServiceCaptureResult>;
  undoLatest(): Promise<UndoResult>;
}

export interface Env {
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  ALLOWED_CHAT_IDS: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  CAPTURE_SERVICE: CaptureServiceStub;
  IMAGE_BUCKET: R2Bucket;
  R2_PUBLIC_URL: string;
}

// ── Service Binding result ──────────────────────────────────────────────────
// Mirrors mcp/src/types.ts ServiceCaptureResult.
// Defined locally to avoid cross-project tsconfig dependencies.

export interface ServiceCaptureResult {
  id: string;
  title: string;
  body: string;
  tags: string[];
  source_ref: string | null;
  corrections: string[] | null;
  entities: Array<{ name: string; type: string }>;
  links: Array<{ to_id: string; to_title: string; link_type: string }>;
  source: string;
  image_url: string | null;
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

export interface TelegramPhotoSize {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  date: number;
  text?: string;
  caption?: string;
  sticker?: unknown;
  photo?: TelegramPhotoSize[];
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

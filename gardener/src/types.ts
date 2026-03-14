// ── Cloudflare Worker env bindings ───────────────────────────────────────────

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  GARDENER_SIMILARITY_THRESHOLD: string;
  // Optional — alerting degrades gracefully if not set
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALERT_CHAT_ID?: string;
  // Optional — enables POST /trigger endpoint for manual runs and smoke tests
  GARDENER_API_KEY?: string;
}

// ── Domain types ─────────────────────────────────────────────────────────────

// A note as fetched for similarity processing — includes embedding for RPC calls
// and tags for context generation.
export interface NoteForSimilarity {
  id: string;
  tags: string[];
  embedding: number[];
}

// A link to be inserted into the links table.
export interface SimilarityLink {
  fromId: string;
  toId: string;
  confidence: number;
  context: string;
}

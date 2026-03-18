// ── Cloudflare Worker env bindings ───────────────────────────────────────────

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  GARDENER_SIMILARITY_THRESHOLD: string;
  // Cosine floor for pair fetching — pairs below this are not fetched at all
  GARDENER_COSINE_FLOOR?: string;
  // Comma-separated resolutions for multi-resolution Louvain clustering
  GARDENER_CLUSTER_RESOLUTIONS?: string;
  // Optional — alerting degrades gracefully if not set
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALERT_CHAT_ID?: string;
  // Optional — enables POST /trigger endpoint for manual runs and smoke tests
  GARDENER_API_KEY?: string;
}

// ── Domain types ─────────────────────────────────────────────────────────────

// A note as fetched for similarity processing — tags for context generation,
// created_at for gravity calculation.
export interface NoteForSimilarity {
  id: string;
  tags: string[];
  created_at: string;
}

// A link to be inserted into the links table.
export interface SimilarityLink {
  fromId: string;
  toId: string;
  confidence: number;
  context: string;
}

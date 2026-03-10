// ── Cloudflare Worker env bindings ───────────────────────────────────────────

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  GARDENER_SIMILARITY_THRESHOLD: string;
  GARDENER_TAG_MATCH_THRESHOLD: string;
  // Optional — enables semantic tag matching fallback (lexical-only when absent)
  OPENROUTER_API_KEY?: string;
  EMBED_MODEL?: string;
  // Optional — alerting degrades gracefully if not set
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ALERT_CHAT_ID?: string;
  // Optional — enables POST /trigger endpoint for manual runs and smoke tests
  GARDENER_API_KEY?: string;
}

// ── Domain types ─────────────────────────────────────────────────────────────

export interface Entity {
  name: string;
  type: 'person' | 'place' | 'tool' | 'project' | 'concept';
}

// A note as fetched for similarity processing — includes embedding for RPC calls
// and tags/entities for context generation.
export interface NoteForSimilarity {
  id: string;
  tags: string[];
  entities: Entity[];
  embedding: number[];
}

// A note returned by match_notes RPC — includes similarity score.
export interface SimilarNote {
  id: string;
  tags: string[];
  entities: unknown; // jsonb from DB — cast via toEntityArray in similarity.ts
  similarity: number;
}

// A link to be inserted into the links table.
export interface SimilarityLink {
  fromId: string;
  toId: string;
  confidence: number;
  context: string;
}

// ── Tag normalization types ─────────────────────────────────────────────────

export interface Concept {
  id: string;
  scheme: string;
  pref_label: string;
  alt_labels: string[];
  definition: string | null;
  embedding: number[] | null;
}

// A note as fetched for tag normalization — includes tags but not embedding.
export interface NoteForTagNorm {
  id: string;
  tags: string[];
}

// A successful tag-to-concept match.
export interface TagMatch {
  conceptId: string;
  prefLabel: string;
}

// Result of a tag normalization run.
export interface TagNormResult {
  event: 'tag_normalization_complete';
  notes_processed: number;
  tags_matched: number;
  tags_unmatched: number;
  concepts_embedded: number;
  errors: string[];
}

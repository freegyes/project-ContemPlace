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
  // Entity extraction — optional, enables the entity dictionary phase
  OPENROUTER_API_KEY?: string;
  GARDENER_ENTITY_MODEL?: string;
  GARDENER_ENTITY_BATCH_SIZE?: string;
}

// ── Domain types ─────────────────────────────────────────────────────────────

// A note as fetched for similarity processing — tags for context generation,
// created_at for gravity calculation, title for LLM cluster labeling.
export interface NoteForSimilarity {
  id: string;
  title: string;
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

// ── Entity types ──────────────────────────────────────────────────────────────

// Entity types — 4-type taxonomy. 'concept' was dropped because it overlapped
// with tags and produced inconsistent classifications (#71, #113).
export type EntityType = 'person' | 'place' | 'tool' | 'project';

export const VALID_ENTITY_TYPES: readonly EntityType[] = ['person', 'place', 'tool', 'project'];

export interface ExtractedEntity {
  name: string;
  type: EntityType;
}

// A note fetched for entity extraction — needs title + body for LLM context.
export interface NoteForEntityExtraction {
  id: string;
  title: string;
  body: string;
  tags: string[];
  created_at: string;
}

// Raw per-note extraction result, stored in enrichment_log.metadata.
export interface RawExtraction {
  noteId: string;
  entities: ExtractedEntity[];
}

// Resolved dictionary entry ready for DB insertion.
export interface DictionaryEntry {
  name: string;
  type: EntityType;
  aliases: string[];
  note_count: number;
  note_ids: string[];
  first_seen: string;
  last_seen: string;
}

// ── Cloudflare Worker env bindings ───────────────────────────────────────────

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  GARDENER_SIMILARITY_THRESHOLD: string;
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

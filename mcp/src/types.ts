// ── MCP Worker Env ───────────────────────────────────────────────────────────

export interface Env {
  MCP_API_KEY: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  OPENROUTER_API_KEY: string;
  CAPTURE_MODEL: string;
  EMBED_MODEL: string;
  MATCH_THRESHOLD: string;
}

// ── Note Types ──────────────────────────────────────────────────────────────

export type NoteType = 'idea' | 'reflection' | 'source' | 'lookup';

// Capture-time link types (LLM-assigned)
export type CaptureLinkType = 'extends' | 'contradicts' | 'supports' | 'is-example-of';

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

// ── MCP-specific types ───────────────────────────────────────────────────────

export interface NoteRow {
  id: string;
  title: string;
  body: string;
  raw_input: string;
  type: string;
  intent: string | null;
  modality: string | null;
  tags: string[];
  entities: Entity[];
  corrections: string[] | null;
  source: string;
  source_ref: string | null;
  created_at: string;
}

export interface LinkWithTitle {
  to_id: string;      // always the OTHER note's ID (regardless of direction)
  to_title: string;
  link_type: string;
  context: string | null;
  confidence: number | null;
  created_by: string;
  direction: 'outbound' | 'inbound';
}

import type { OAuthHelpers } from '@cloudflare/workers-oauth-provider';

// ── MCP Worker Env ───────────────────────────────────────────────────────────

export interface Env {
  MCP_API_KEY: string;
  CONSENT_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  OPENROUTER_API_KEY: string;
  CAPTURE_MODEL: string;
  EMBED_MODEL: string;
  MATCH_THRESHOLD: string;
  MCP_SEARCH_THRESHOLD: string;
  HARD_DELETE_WINDOW_MINUTES: string;
  OAUTH_KV: KVNamespace;
  /** Injected at runtime by OAuthProvider before calling handlers */
  OAUTH_PROVIDER?: OAuthHelpers;
}

// ── Note Types ──────────────────────────────────────────────────────────────

// Capture-time link types (LLM-assigned)
export type CaptureLinkType = 'contradicts' | 'related';

// All link types (capture + gardening)
export type LinkType = CaptureLinkType | 'is-similar-to';

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
  tags: string[];
  source_ref: string | null;
  links: CaptureLink[];
  corrections: string[] | null;
}

export interface MatchedNote {
  id: string;
  title: string;
  body: string;
  raw_input: string;
  tags: string[];
  source_ref: string | null;
  source: string;
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

// ── Undo result ─────────────────────────────────────────────────────────────
// Returned by CaptureService.undoLatest() — safe for structured cloning across Service Bindings.

export interface UndoResult {
  action: 'deleted' | 'grace_period_passed' | 'none';
  title?: string;
  id?: string;
}

// ── Service Binding result ──────────────────────────────────────────────────
// Rich result returned by CaptureService.capture() — designed for all gateways.
// All fields are strings, arrays, or null — safe for structured cloning across Service Bindings.

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
}

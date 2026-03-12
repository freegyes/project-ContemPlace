/**
 * Gardener integration test — issue #33
 *
 * End-to-end: capture two similar notes via MCP, trigger a gardener run,
 * then verify is-similar-to links surface correctly through get_related.
 *
 * This hits three live Workers: MCP (capture + get_related), Gardener (/trigger).
 * All test notes use source='gardener-integration-test' and are cleaned up in afterAll.
 *
 * Requirements (in .dev.vars):
 *   MCP_WORKER_URL, MCP_API_KEY, GARDENER_WORKER_URL, GARDENER_API_KEY,
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Run:
 *   npx vitest run tests/gardener-integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

// ── Config ────────────────────────────────────────────────────────────────────

const MCP_URL = process.env['MCP_WORKER_URL'] ?? '';
const MCP_KEY = process.env['MCP_API_KEY'] ?? '';
const GARDENER_URL = process.env['GARDENER_WORKER_URL'] ?? '';
const GARDENER_KEY = process.env['GARDENER_API_KEY'] ?? '';
const SOURCE = 'gardener-integration-test';

function supabase() {
  return createClient(
    process.env['SUPABASE_URL'] ?? '',
    process.env['SUPABASE_SERVICE_ROLE_KEY'] ?? '',
  );
}

// ── MCP helpers ───────────────────────────────────────────────────────────────

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await fetch(`${MCP_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${MCP_KEY}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tools/call',
      params: { name, arguments: args },
      id: 1,
    }),
  });
  const body = await res.json() as Record<string, unknown>;
  const result = body['result'] as Record<string, unknown> | undefined;
  if (!result) throw new Error(`No result in response: ${JSON.stringify(body)}`);
  const content = result['content'] as Array<{ text: string }> | undefined;
  const text = content?.[0]?.text ?? '{}';
  return JSON.parse(text) as Record<string, unknown>;
}

async function capture(text: string): Promise<{ id: string; title: string }> {
  const result = await callTool('capture_note', { raw_input: text, source: SOURCE });
  if (result['isError']) throw new Error(`capture_note failed: ${JSON.stringify(result)}`);
  return { id: result['id'] as string, title: result['title'] as string };
}

async function getRelated(id: string): Promise<LinkResult[]> {
  const result = await callTool('get_related', { id });
  return (result['links'] as LinkResult[]) ?? [];
}

interface LinkResult {
  to_id: string;
  to_title: string;
  link_type: string;
  context: string | null;
  confidence: number | null;
  created_by: string;
  direction: 'outbound' | 'inbound';
}

// ── Gardener trigger ──────────────────────────────────────────────────────────

async function triggerGardener(): Promise<Record<string, unknown>> {
  const res = await fetch(`${GARDENER_URL}/trigger`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GARDENER_KEY}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gardener /trigger failed (${res.status}): ${text}`);
  }
  return await res.json() as Record<string, unknown>;
}

// ── Test fixtures ─────────────────────────────────────────────────────────────
// Two notes about the same topic (workstation DIY), designed to be highly similar
// and produce an is-similar-to link at the 0.70 threshold.
// A third unrelated note ensures gardener does NOT link across topics.

const SIMILAR_NOTE_A = `Building a slide-out cutting mat tray for the workstation — a shallow wooden frame on drawer slides mounted under the desk edge. The mat sits in the frame and pulls forward for use, then slides back flush when not needed. Keeps the work surface clear without having to relocate the mat every time.`;

const SIMILAR_NOTE_B = `The desk tray for the cutting mat works well, but next iteration should use full-extension slides instead of three-quarter. The mat needs to clear the desk edge completely for large cuts. Also considering adding a thin lip to the front edge so the mat can't slide forward off the tray during heavy pressure cuts.`;

const UNRELATED_NOTE = `Just discovered that the old 78rpm shellac records at the flea market are mostly Hungarian jazz from the 1930s — Chappy Jazz Band, Manolovits dance orchestra. The pressings are in rough shape but the labels are beautiful. Worth collecting for the graphic design alone, even if half of them are unplayable.`;

// ── Captured note IDs (populated in beforeAll) ────────────────────────────────

let noteA: { id: string; title: string };
let noteB: { id: string; title: string };
let noteC: { id: string; title: string };

// ── Setup & teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!MCP_URL || !MCP_KEY) throw new Error('MCP_WORKER_URL and MCP_API_KEY must be set');
  if (!GARDENER_URL || !GARDENER_KEY) throw new Error('GARDENER_WORKER_URL and GARDENER_API_KEY must be set');

  // Capture sequentially so each note is in the DB before the next
  noteA = await capture(SIMILAR_NOTE_A);
  noteB = await capture(SIMILAR_NOTE_B);
  noteC = await capture(UNRELATED_NOTE);

  // Trigger the gardener so it computes similarity links
  await triggerGardener();
}, 120_000); // 2 min — 3 captures + gardener run

afterAll(async () => {
  const db = supabase();
  const { error } = await db.from('notes').delete().eq('source', SOURCE);
  if (error) console.warn('Gardener integration test cleanup failed:', error.message);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Gardener integration — is-similar-to links via get_related', () => {
  it('get_related(noteA) includes is-similar-to link to noteB', async () => {
    const links = await getRelated(noteA.id);
    const similarToB = links.find(
      l => l.to_id === noteB.id && l.link_type === 'is-similar-to',
    );
    expect(similarToB).toBeDefined();
    expect(similarToB!.created_by).toBe('gardener');
  });

  it('get_related(noteB) includes is-similar-to link to noteA (direction symmetry)', async () => {
    const links = await getRelated(noteB.id);
    const similarToA = links.find(
      l => l.to_id === noteA.id && l.link_type === 'is-similar-to',
    );
    expect(similarToA).toBeDefined();
    expect(similarToA!.created_by).toBe('gardener');
  });

  it('is-similar-to link has a non-null context string', async () => {
    const links = await getRelated(noteA.id);
    const similarToB = links.find(
      l => l.to_id === noteB.id && l.link_type === 'is-similar-to',
    );
    expect(similarToB).toBeDefined();
    expect(typeof similarToB!.context).toBe('string');
    expect(similarToB!.context!.length).toBeGreaterThan(0);
    // Context should start with "Similarity: X.XX"
    expect(similarToB!.context).toMatch(/^Similarity: \d+\.\d{2}/);
  });

  it('is-similar-to link has a confidence score', async () => {
    const links = await getRelated(noteA.id);
    const similarToB = links.find(
      l => l.to_id === noteB.id && l.link_type === 'is-similar-to',
    );
    expect(similarToB).toBeDefined();
    expect(typeof similarToB!.confidence).toBe('number');
    expect(similarToB!.confidence).toBeGreaterThanOrEqual(0.70);
  });

  it('unrelated note (noteC) has no is-similar-to link to noteA or noteB', async () => {
    const links = await getRelated(noteC.id);
    const similarityLinks = links.filter(l => l.link_type === 'is-similar-to');
    const linkedToAB = similarityLinks.filter(
      l => l.to_id === noteA.id || l.to_id === noteB.id,
    );
    expect(linkedToAB.length).toBe(0);
  });

  it('noteA may have both capture-time and gardener links (no dedup collision)', async () => {
    const links = await getRelated(noteA.id);
    // noteB was captured after noteA, so the capture pipeline may have created
    // a capture-time link (extends/supports) in addition to the gardener is-similar-to.
    // Both should appear — they are different link types.
    const toB = links.filter(l => l.to_id === noteB.id);
    const gardenerLinks = toB.filter(l => l.created_by === 'gardener');
    expect(gardenerLinks.length).toBe(1);
    // Total links to B should be >= 1 (gardener) and possibly 2 (+ capture-time)
    expect(toB.length).toBeGreaterThanOrEqual(1);
  });
});

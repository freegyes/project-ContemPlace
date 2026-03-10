/**
 * Semantic correctness test suite — issue #7
 *
 * Captures a curated batch of inputs via the MCP capture_note tool, then
 * verifies tagging, linking, and search quality against human expectations.
 *
 * This is not a unit test. It fires the full capture pipeline — embedding,
 * LLM, DB — and checks that the system organises things usefully.
 *
 * Fixtures are grouped into 4 topic clusters:
 *   A: Journaling / reflection habit
 *   B: Deep work / focus
 *   C: Creativity and constraints
 *   D: Python async programming
 *   E: Standalone (URL note, typo correction)
 *
 * Related notes within a cluster are captured in order so the second note
 * can find the first in the vector search (capture-time linking).
 *
 * All notes are tagged source='semantic-test' and deleted in afterAll.
 *
 * Requirements (in .dev.vars):
 *   MCP_WORKER_URL, MCP_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
 *
 * Run:
 *   npx vitest run tests/semantic.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createClient } from '@supabase/supabase-js';

// ── Config ────────────────────────────────────────────────────────────────────

const MCP_URL = process.env['MCP_WORKER_URL'] ?? '';
const API_KEY = process.env['MCP_API_KEY'] ?? '';
const SOURCE = 'semantic-test';

// Search threshold — passed explicitly because the stored embeddings are
// metadata-augmented and bare-text queries typically score 0.3–0.5.
// See: docs/decisions.md "Embedding space mismatch between capture and search"
const SEARCH_THRESHOLD = 0.3;

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
      'Authorization': `Bearer ${API_KEY}`,
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

async function capture(text: string): Promise<CaptureResult> {
  const result = await callTool('capture_note', { text, source: SOURCE });
  if ((result as Record<string, unknown>)['isError'] !== undefined &&
      (result as Record<string, unknown>)['isError'] !== false) {
    throw new Error(`capture_note failed: ${JSON.stringify(result)}`);
  }
  return result as unknown as CaptureResult;
}

async function search(query: string, limit = 10): Promise<SearchResult[]> {
  const result = await callTool('search_notes', { query, threshold: SEARCH_THRESHOLD, limit });
  return (result['results'] as SearchResult[]) ?? [];
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface CaptureResult {
  id: string;
  title: string;
  body: string;
  type: string;
  intent: string;
  tags: string[];
  links_created: number;
  source: string;
}

interface SearchResult {
  id: string;
  title: string;
  type: string;
  intent: string;
  tags: string[];
  score: number;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FIXTURES = {
  // Cluster A: Journaling — plan then reflection, should link
  A1_journaling_plan: `I've been thinking about starting a daily journaling habit. The idea is to spend 10 minutes every morning writing down whatever is on my mind before I start work. No structure, no prompt — just raw stream of consciousness.`,

  A2_journaling_reflection: `Tried journaling this morning for the first time. It actually helped me realize I was anxious about a meeting I had been avoiding thinking about. The act of writing made the feeling visible. Genuinely surprised by how useful it was.`,

  // Cluster B: Deep work — concept then plan, should link
  B1_deep_work_concept: `Cal Newport's concept of deep work: long protected blocks of uninterrupted time spent on cognitively demanding tasks. The idea is that this kind of focused work is increasingly rare and increasingly valuable — most people never do it.`,

  B2_deep_work_plan: `Going to block 9-11am every weekday for focused coding. No Slack, no meetings scheduled. Treating it like an external meeting — it shows on the calendar and cannot be moved.`,

  // Cluster C: Creativity and constraints — three linked notes, C3 is a source URL
  C1_constraints_reflection: `The best design work I've done always had constraints. When you have unlimited budget and time, you spend most of it second-guessing yourself. The limits were never the obstacle — they were the brief.`,

  C2_constraints_idea: `Constraints are not just limitations — they are generative. They force you to find solutions inside a bounded space, which often leads to more interesting outcomes than pure open-ended exploration. Less freedom, more creativity.`,

  C3_oblique_strategies_source: `Oblique Strategies by Brian Eno — a deck of cards with provocative constraints designed to break creative blocks. Each card is a prompt like "Use an old idea" or "Abandon normal instruments." A practical artifact of constraint-based creativity. https://www.enoshop.co.uk/product/oblique-strategies.html`,

  // Cluster D: Python async — concept then log, should link
  D1_asyncio_concept: `Python asyncio: the event loop runs coroutines cooperatively. await suspends the current coroutine until the awaited thing resolves. Key primitives: coroutine, task, future, event loop. Concurrency without threading.`,

  D2_asyncio_log: `Used asyncio.gather() to fire three Supabase queries at the same time instead of awaiting them sequentially. Brought total query latency from 480ms down to 170ms. The queries were independent, so gather was the right primitive.`,

  // Cluster E: Standalone notes
  E1_url_source: `This paper by Lewis et al. introduced retrieval-augmented generation (RAG) — combining a parametric language model with a non-parametric retrieval component over a dense vector index. Foundational for modern AI memory systems. https://arxiv.org/abs/2005.11401`,

  E2_typo_correction: `I want to reed more non-fiction this year, specifically around behavioral economics and decision-making. Books like Thinking Fast and Slow or Predictably Irrational. Want to understand why people make the choices they do.`,
} as const;

// ── Captured results (populated in beforeAll) ─────────────────────────────────

type NotesMap = { [K in keyof typeof FIXTURES]: CaptureResult };
let notes: NotesMap;

// ── Setup & teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  if (!MCP_URL || !API_KEY) {
    throw new Error('MCP_WORKER_URL and MCP_API_KEY must be set in .dev.vars');
  }

  // Capture sequentially so each note is in the DB before the next
  // one's embedding search runs — this is what enables capture-time linking.
  const results: Partial<NotesMap> = {};
  for (const [key, text] of Object.entries(FIXTURES)) {
    results[key as keyof typeof FIXTURES] = await capture(text);
  }
  notes = results as NotesMap;
}, 300_000); // 5 min — 11 captures × ~15s each + headroom

afterAll(async () => {
  const db = supabase();
  const { error } = await db.from('notes').delete().eq('source', SOURCE);
  if (error) console.warn('Semantic test cleanup failed:', error.message);
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true if the note's tags include at least one of the expected terms. */
function hasAnyTag(note: CaptureResult, expected: string[]): boolean {
  const noteTags = note.tags.map(t => t.toLowerCase());
  return expected.some(e => noteTags.some(t => t.includes(e)));
}

/** Checks the DB links table for a link from fromId to toId (either direction). */
async function isLinked(fromId: string, toId: string): Promise<boolean> {
  const db = supabase();
  const { data } = await db
    .from('links')
    .select('from_id, to_id')
    .or(`and(from_id.eq.${fromId},to_id.eq.${toId}),and(from_id.eq.${toId},to_id.eq.${fromId})`);
  return Array.isArray(data) && data.length > 0;
}

// ── Cluster A: Journaling ─────────────────────────────────────────────────────

describe('Cluster A — Journaling habit', () => {
  it('A1 journaling plan: type is idea', () => {
    expect(notes.A1_journaling_plan.type).toBe('idea');
  });

  it('A1 journaling plan: intent is plan', () => {
    expect(notes.A1_journaling_plan.intent).toBe('plan');
  });

  it('A1 journaling plan: tags include journaling-related term', () => {
    expect(hasAnyTag(notes.A1_journaling_plan, ['journal', 'habit', 'morning', 'routine', 'writing'])).toBe(true);
  });

  it('A2 journaling reflection: type is reflection', () => {
    expect(notes.A2_journaling_reflection.type).toBe('reflection');
  });

  it('A2 journaling reflection: intent is reflect', () => {
    expect(notes.A2_journaling_reflection.intent).toBe('reflect');
  });

  it('A2 journaling reflection: tags include journaling-related term', () => {
    expect(hasAnyTag(notes.A2_journaling_reflection, ['journal', 'awareness', 'anxiety', 'emotion', 'feeling', 'writing', 'habit'])).toBe(true);
  });

  it('A2 is linked to A1 (capture-time linking)', async () => {
    const linked = await isLinked(notes.A2_journaling_reflection.id, notes.A1_journaling_plan.id);
    expect(linked).toBe(true);
  });
});

// ── Cluster B: Deep work ──────────────────────────────────────────────────────

describe('Cluster B — Deep work / focus', () => {
  it('B1 deep work concept: type is idea', () => {
    expect(notes.B1_deep_work_concept.type).toBe('idea');
  });

  it('B1 deep work concept: intent is remember', () => {
    expect(notes.B1_deep_work_concept.intent).toBe('remember');
  });

  it('B1 deep work concept: tags include focus-related term', () => {
    expect(hasAnyTag(notes.B1_deep_work_concept, ['deep-work', 'deep work', 'focus', 'productivity', 'cal-newport', 'cal newport', 'concentration'])).toBe(true);
  });

  it('B2 deep work plan: type is idea', () => {
    expect(notes.B2_deep_work_plan.type).toBe('idea');
  });

  it('B2 deep work plan: intent is plan', () => {
    expect(notes.B2_deep_work_plan.intent).toBe('plan');
  });

  it('B2 deep work plan: tags include focus or scheduling term', () => {
    expect(hasAnyTag(notes.B2_deep_work_plan, ['deep-work', 'focus', 'time-blocking', 'time blocking', 'schedule', 'productivity', 'calendar'])).toBe(true);
  });

  it('B2 is linked to B1 (capture-time linking)', async () => {
    const linked = await isLinked(notes.B2_deep_work_plan.id, notes.B1_deep_work_concept.id);
    expect(linked).toBe(true);
  });
});

// ── Cluster C: Creativity and constraints ────────────────────────────────────

describe('Cluster C — Creativity and constraints', () => {
  it('C1 constraints reflection: type is reflection', () => {
    expect(notes.C1_constraints_reflection.type).toBe('reflection');
  });

  it('C1 constraints reflection: intent is reflect', () => {
    expect(notes.C1_constraints_reflection.intent).toBe('reflect');
  });

  it('C1 constraints reflection: tags include design or creativity term', () => {
    expect(hasAnyTag(notes.C1_constraints_reflection, ['design', 'creativity', 'constraint', 'creative'])).toBe(true);
  });

  it('C2 constraints idea: type is idea', () => {
    expect(notes.C2_constraints_idea.type).toBe('idea');
  });

  it('C2 constraints idea: tags include creativity or constraint term', () => {
    expect(hasAnyTag(notes.C2_constraints_idea, ['creativity', 'constraint', 'creative', 'design', 'exploration'])).toBe(true);
  });

  it('C2 is linked to C1 (capture-time linking)', async () => {
    const linked = await isLinked(notes.C2_constraints_idea.id, notes.C1_constraints_reflection.id);
    expect(linked).toBe(true);
  });

  it('C3 Oblique Strategies: type is source (has URL)', () => {
    expect(notes.C3_oblique_strategies_source.type).toBe('source');
  });

  it('C3 Oblique Strategies: intent is reference', () => {
    expect(notes.C3_oblique_strategies_source.intent).toBe('reference');
  });

  it('C3 Oblique Strategies: tags include creativity-related term', () => {
    expect(hasAnyTag(notes.C3_oblique_strategies_source, ['creativity', 'oblique', 'eno', 'constraint', 'creative', 'tools'])).toBe(true);
  });

  it('C3 is linked to C1 or C2 (capture-time linking)', async () => {
    const linkedToC1 = await isLinked(notes.C3_oblique_strategies_source.id, notes.C1_constraints_reflection.id);
    const linkedToC2 = await isLinked(notes.C3_oblique_strategies_source.id, notes.C2_constraints_idea.id);
    expect(linkedToC1 || linkedToC2).toBe(true);
  });
});

// ── Cluster D: Python async ───────────────────────────────────────────────────

describe('Cluster D — Python asyncio', () => {
  it('D1 asyncio concept: type is idea', () => {
    expect(notes.D1_asyncio_concept.type).toBe('idea');
  });

  it('D1 asyncio concept: intent is remember', () => {
    expect(notes.D1_asyncio_concept.intent).toBe('remember');
  });

  it('D1 asyncio concept: tags include Python/async term', () => {
    expect(hasAnyTag(notes.D1_asyncio_concept, ['python', 'asyncio', 'async', 'concurrency', 'event-loop', 'event loop'])).toBe(true);
  });

  it('D2 asyncio log: type is idea', () => {
    expect(notes.D2_asyncio_log.type).toBe('idea');
  });

  it('D2 asyncio log: intent is log', () => {
    expect(notes.D2_asyncio_log.intent).toBe('log');
  });

  it('D2 asyncio log: tags include Python/performance term', () => {
    expect(hasAnyTag(notes.D2_asyncio_log, ['python', 'asyncio', 'async', 'performance', 'gather', 'concurrency'])).toBe(true);
  });

  it('D2 is linked to D1 (capture-time linking)', async () => {
    const linked = await isLinked(notes.D2_asyncio_log.id, notes.D1_asyncio_concept.id);
    expect(linked).toBe(true);
  });
});

// ── Standalone notes ──────────────────────────────────────────────────────────

describe('Standalone — URL/source note', () => {
  it('E1 RAG paper: type is source (contains URL)', () => {
    expect(notes.E1_url_source.type).toBe('source');
  });

  it('E1 RAG paper: intent is reference', () => {
    expect(notes.E1_url_source.intent).toBe('reference');
  });

  it('E1 RAG paper: tags include AI/retrieval term', () => {
    expect(hasAnyTag(notes.E1_url_source, ['rag', 'retrieval', 'ai', 'machine-learning', 'machine learning', 'nlp', 'vector', 'language-model'])).toBe(true);
  });
});

describe('Standalone — typo correction', () => {
  it('E2 typo: captures successfully', () => {
    expect(typeof notes.E2_typo_correction.id).toBe('string');
    expect(notes.E2_typo_correction.id.length).toBeGreaterThan(0);
  });

  it('E2 typo: intent is plan (expressed future reading goal)', () => {
    expect(notes.E2_typo_correction.intent).toBe('plan');
  });

  it('E2 typo: tags include reading-related term', () => {
    expect(hasAnyTag(notes.E2_typo_correction, ['reading', 'books', 'non-fiction', 'nonfiction', 'economics', 'decision', 'behavioral'])).toBe(true);
  });
});

// ── Search quality: recall ────────────────────────────────────────────────────

describe('Search — recall (relevant query → relevant notes)', () => {
  it('journaling query returns at least one A-cluster note', async () => {
    const results = await search('daily journaling habit morning routine');
    const ids = results.map(r => r.id);
    const clusterA = [notes.A1_journaling_plan.id, notes.A2_journaling_reflection.id];
    expect(ids.some(id => clusterA.includes(id))).toBe(true);
  });

  it('python async query returns at least one D-cluster note', async () => {
    const results = await search('python asyncio concurrent event loop');
    const ids = results.map(r => r.id);
    const clusterD = [notes.D1_asyncio_concept.id, notes.D2_asyncio_log.id];
    expect(ids.some(id => clusterD.includes(id))).toBe(true);
  });

  it('creativity constraints query returns at least one C-cluster note', async () => {
    const results = await search('creativity constraints design thinking');
    const ids = results.map(r => r.id);
    const clusterC = [
      notes.C1_constraints_reflection.id,
      notes.C2_constraints_idea.id,
      notes.C3_oblique_strategies_source.id,
    ];
    expect(ids.some(id => clusterC.includes(id))).toBe(true);
  });

  it('deep work focus query returns at least one B-cluster note', async () => {
    const results = await search('deep work focused time blocking productivity');
    const ids = results.map(r => r.id);
    const clusterB = [notes.B1_deep_work_concept.id, notes.B2_deep_work_plan.id];
    expect(ids.some(id => clusterB.includes(id))).toBe(true);
  });

  it('RAG paper query returns E1', async () => {
    const results = await search('retrieval augmented generation language model dense vector');
    const ids = results.map(r => r.id);
    expect(ids).toContain(notes.E1_url_source.id);
  });
});

// ── Search quality: cross-cluster isolation ───────────────────────────────────

describe('Search — isolation (topic query should NOT cross into unrelated cluster)', () => {
  it('python async query does NOT return journaling notes', async () => {
    const results = await search('python asyncio concurrent event loop', 5);
    const ids = results.map(r => r.id);
    const journalingIds = [notes.A1_journaling_plan.id, notes.A2_journaling_reflection.id];
    expect(ids.some(id => journalingIds.includes(id))).toBe(false);
  });

  it('journaling query does NOT return python asyncio notes', async () => {
    const results = await search('daily journaling morning reflection habit', 5);
    const ids = results.map(r => r.id);
    const asyncIds = [notes.D1_asyncio_concept.id, notes.D2_asyncio_log.id];
    expect(ids.some(id => asyncIds.includes(id))).toBe(false);
  });
});

// ── Cross-cluster non-linking ─────────────────────────────────────────────────

describe('Cross-cluster isolation — no spurious links', () => {
  it('journaling notes are NOT linked to Python notes', async () => {
    const db = supabase();
    const journalingIds = [notes.A1_journaling_plan.id, notes.A2_journaling_reflection.id];
    const asyncIds = [notes.D1_asyncio_concept.id, notes.D2_asyncio_log.id];
    const { data } = await db
      .from('links')
      .select('from_id, to_id')
      .in('from_id', [...journalingIds, ...asyncIds])
      .in('to_id', [...journalingIds, ...asyncIds]);
    // Any results here mean cross-cluster links exist — should be empty
    const crossCluster = (data ?? []).filter(
      (l: { from_id: string; to_id: string }) =>
        (journalingIds.includes(l.from_id) && asyncIds.includes(l.to_id)) ||
        (asyncIds.includes(l.from_id) && journalingIds.includes(l.to_id)),
    );
    expect(crossCluster.length).toBe(0);
  });
});

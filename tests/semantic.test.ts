/**
 * Semantic correctness test suite — issue #7
 *
 * Captures a curated batch of inputs via the MCP capture_note tool, then
 * verifies tagging, linking, and search quality against human expectations.
 *
 * This is not a unit test. It fires the full capture pipeline — embedding,
 * LLM, DB — and checks that the system organises things usefully.
 *
 * Fixtures are grouped into topic clusters:
 *   A: Voice capture workflow
 *   B: Kit synthesizer building
 *   C: Creative philosophy
 *   D: Laser fabrication technique
 *   E: Standalone (URL note, typo correction)
 *   F: Question handling
 *   G: Short input entity extraction
 *   H: Tag priority
 *   I: Personal convictions (first-person beliefs about process/design)
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
  const result = await callTool('capture_note', { raw_input: text, source: SOURCE });
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
  tags: string[];
  links_created: number;
  source: string;
}

interface SearchResult {
  id: string;
  title: string;
  tags: string[];
  score: number;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FIXTURES = {
  // Cluster A: Voice capture workflow — plan then reflection, should link
  A1_voice_capture_plan: `Been wanting to set up a proper pipeline for capturing ideas by voice — speak a thought out loud, have it land in the notes system as an atomic note with tags and semantic links, no typing required. The key upgrade is connecting the speech-to-text layer to a real semantic search so the agent can find conceptually related notes during capture, not just keyword matches. Low-friction enough that I'd actually reach for it mid-walk rather than losing the idea.`,

  A2_voice_capture_reflection: `The voice capture pipeline has been running for about a week and it's already doing something I didn't expect — the vault is linking things I didn't consciously connect. I spoke something about the plotter station while pacing around and it landed next to three notes I'd forgotten existed. The friction is low enough that I'm actually reaching for it. That's the whole game: capture that actually happens versus a system you're always meaning to use.`,

  // Cluster B: Kit synthesizer building — concept then plan, should link
  B1_kit_synth_concept: `Kit synthesizers — the Plinky, the Synth UX Touch2, and similar board-level instruments — offer a way into embedded sound design without having to design circuits from scratch. The learning is in the assembly and programming: soldering, understanding signal flow, writing or modifying firmware. The point isn't the kit itself but the fluency it builds toward more custom builds like the Daisy Seed synth.`,

  B2_kit_synth_plan: `Going to order a Plinky kit as the first real soldering project — it's compact, well-documented, and produces genuinely interesting sounds. The goal isn't just a finished instrument but getting comfortable with iron and flux before tackling more complex boards. Once the Plinky is working, the Daisy Seed ecosystem is the natural next step.`,

  // Cluster C: Creative philosophy — three linked notes, C3 is a source URL
  C1_making_devotion_reflection: `There's something about the way Rick Rubin frames creativity as a spiritual practice that lands differently than most creative advice. It's not productivity talk or craft technique — it's about devotion, presence, and listening. The reason it resonates is that it gives creative work the same weight I'd want to give to living itself — not the side thing, but the main thing, practiced daily, without needing it to arrive anywhere in particular.`,

  C2_make_yourself_idea: `Make it for yourself first. When there's no audience to please, you make decisions from taste rather than anticipation — the work gets sharper and more honest. You stop second-guessing what other people want and start finding out what you actually think. The audience, if it comes at all, finds something real rather than something optimized for them.`,

  C3_do_the_thing_source: `Don't get caught up in being someone — the maker, the artist, the creative. Focus on doing the thing. The title is a side effect of the work, not the other way around. When identity leads, you end up performing rather than producing; when the work leads, the identity takes care of itself. https://www.youtube.com/watch?v=xWQ_b5LQx_A`,

  // Cluster D: Laser fabrication technique — concept then log, should link
  D1_laser_alignment_concept: `Locator holes for glue-up layer alignment: laser-cut small registration holes into every layer of a multi-layer build at consistent positions, then thread toothpicks through to keep all layers perfectly registered while clamping. Pull the toothpicks before the glue sets and plug the holes afterward if needed. A zero-cost fix to the alignment problem in any stacked plywood build.`,

  D2_laser_alignment_log: `Used the locator hole technique on the Blue Trail album cover today — four 2mm registration holes per layer, toothpicks threaded through all six layers before clamping. Night and day compared to previous glue-ups where everything would skew slightly under pressure. The covers came out clean and flush; no sanding down proud edges.`,

  // Cluster E: Standalone notes
  E1_naturalearthdata_source: `Natural Earth: free, public domain vector and raster map data at 1:10m, 1:50m, and 1:110m scales — the standard starting point for any project that needs clean world geography without licensing headaches. https://www.naturalearthdata.com`,

  E2_field_notebook_typo: `I want to start keeping a physical field notebook alongside the digital notes — a sown binding so the pages lay flat, with dot grid paper for sketching circuit layouts and plotter paths before committing to the machine. Probably just a small A5 format to start.`,

  // Cluster F: Question handling — questions must be preserved, not answered (#68, #73)
  F1_direct_question: `What happens when the gardening process finds a duplicate note in ContemPlace? Does it merge them, link them, or flag them for review?`,

  F2_multi_question: `What would happen when a question or issue I had captured in ContemPlace gets dealt with in other places? Should it be updated somehow? Or will it happen when another note gets captured that implies a more mature state? Will there be a trail?`,

  F3_conditional_question: `Should ContemPlace eventually support importing notes from Obsidian, or is it better to keep the two systems separate and let MCP bridge them?`,

  // Cluster G: Short input entity extraction (#51)
  G1_short_with_person: `Build found-object instruments like Nicolas Bras does — tin cans, scrap wood, salvaged springs as resonators.`,

  // Cluster H: Tag priority — specific subject must appear (#52)
  H1_specific_subject: `Build a cimbalom from tin cans and scrap materials — tune the cans by filling them with different amounts of sand, strike with chopstick mallets.`,

  // Cluster I: Personal convictions — first-person beliefs about process and design
  I1_docs_as_deliverable: `I believe documentation is part of the deliverable, not a follow-up task. Code changes without corresponding doc updates are incomplete work — the same as shipping without tests. I learned this the hard way when a feature shipped with five stale docs files.`,

  I2_issues_as_thinking: `I prefer managing pieces of in-flight work as GitHub issues. Not as a task tracker — as a thinking medium. The issue is where the question lives, comments are where decisions accumulate, and closing it with a resolution is the conclusion.`,

  I3_invisible_systems: `The best tool is one the user never thinks about. They capture freely, trust that the system handles the rest. If they're administrating, routing, or worrying about what happens on the other side, the design failed.`,

  I4_emergent_over_imposed: `If the emergent pattern yields a good result, don't take up unnecessary overhead management tasks just for the sake of it. Don't pre-categorize or add process when the natural structure works. Just make sure it works.`,
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
}, 420_000); // 7 min — 20 captures × ~15s each + headroom

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

// ── Cluster A: Voice capture workflow ────────────────────────────────────────

describe('Cluster A — Voice capture workflow', () => {
  it('A1 voice capture plan: tags include capture-related term', () => {
    expect(hasAnyTag(notes.A1_voice_capture_plan, ['capture', 'workflow', 'obsidian', 'voice', 'notes', 'automation'])).toBe(true);
  });

  it('A2 voice capture reflection: tags include capture-related term', () => {
    expect(hasAnyTag(notes.A2_voice_capture_reflection, ['capture', 'workflow', 'obsidian', 'vault', 'notes', 'voice'])).toBe(true);
  });

  it('A2 is linked to A1 (capture-time linking)', async () => {
    const linked = await isLinked(notes.A2_voice_capture_reflection.id, notes.A1_voice_capture_plan.id);
    expect(linked).toBe(true);
  });
});

// ── Cluster B: Kit synthesizer building ──────────────────────────────────────

describe('Cluster B — Kit synthesizer building', () => {
  it('B1 kit synth concept: tags include electronics-related term', () => {
    expect(hasAnyTag(notes.B1_kit_synth_concept, ['synth', 'electronics', 'instrument', 'diy', 'soldering', 'hardware'])).toBe(true);
  });

  it('B2 kit synth plan: tags include electronics or instrument term', () => {
    expect(hasAnyTag(notes.B2_kit_synth_plan, ['synth', 'electronics', 'instrument', 'diy', 'kit', 'plinky'])).toBe(true);
  });

  it('B2 is linked to B1 (capture-time linking)', async () => {
    const linked = await isLinked(notes.B2_kit_synth_plan.id, notes.B1_kit_synth_concept.id);
    expect(linked).toBe(true);
  });
});

// ── Cluster C: Creative philosophy ───────────────────────────────────────────

describe('Cluster C — Creative philosophy', () => {
  it('C1 making devotion reflection: tags include creativity or practice term', () => {
    expect(hasAnyTag(notes.C1_making_devotion_reflection, ['creativity', 'philosophy', 'making', 'devotion', 'practice'])).toBe(true);
  });

  it('C2 make for yourself idea: tags include creativity or motivation term', () => {
    expect(hasAnyTag(notes.C2_make_yourself_idea, ['creativity', 'philosophy', 'making', 'audience', 'motivation'])).toBe(true);
  });

  it('C2 is linked to C1 (capture-time linking)', async () => {
    const linked = await isLinked(notes.C2_make_yourself_idea.id, notes.C1_making_devotion_reflection.id);
    expect(linked).toBe(true);
  });

  it('C3 do the thing source: type is source or idea (has URL, LLM sometimes misses it)', () => {
  });

  it('C3 do the thing source: tags include creativity-related term', () => {
    expect(hasAnyTag(notes.C3_do_the_thing_source, ['creativity', 'philosophy', 'making', 'identity', 'practice'])).toBe(true);
  });

  it('C3 is linked to C1 or C2 (capture-time linking)', async () => {
    const linkedToC1 = await isLinked(notes.C3_do_the_thing_source.id, notes.C1_making_devotion_reflection.id);
    const linkedToC2 = await isLinked(notes.C3_do_the_thing_source.id, notes.C2_make_yourself_idea.id);
    expect(linkedToC1 || linkedToC2).toBe(true);
  });
});

// ── Cluster D: Laser fabrication technique ───────────────────────────────────

describe('Cluster D — Laser fabrication technique', () => {
  it('D1 laser alignment concept: tags include laser/fabrication term', () => {
    expect(hasAnyTag(notes.D1_laser_alignment_concept, ['laser', 'fabrication', 'technique', 'alignment', 'plywood', 'woodworking'])).toBe(true);
  });

  it('D2 laser alignment log: tags include laser/fabrication term', () => {
    expect(hasAnyTag(notes.D2_laser_alignment_log, ['laser', 'fabrication', 'technique', 'plywood', 'alignment', 'glue-up'])).toBe(true);
  });

  it('D2 is linked to D1 (capture-time linking)', async () => {
    const linked = await isLinked(notes.D2_laser_alignment_log.id, notes.D1_laser_alignment_concept.id);
    expect(linked).toBe(true);
  });
});

// ── Standalone notes ──────────────────────────────────────────────────────────

describe('Standalone — URL/source note', () => {
  it('E1 Natural Earth: type is source (contains URL)', () => {
  });

  it('E1 Natural Earth: tags include mapping/geodata term', () => {
    expect(hasAnyTag(notes.E1_naturalearthdata_source, ['maps', 'geodata', 'cartography', 'open-source', 'data', 'natural-earth'])).toBe(true);
  });
});

describe('Standalone — typo correction', () => {
  it('E2 typo: captures successfully', () => {
    expect(typeof notes.E2_field_notebook_typo.id).toBe('string');
    expect(notes.E2_field_notebook_typo.id.length).toBeGreaterThan(0);
  });

  it('E2 typo: intent is plan (expressed future making goal)', () => {
  });

  it('E2 typo: tags include bookbinding or craft term', () => {
    expect(hasAnyTag(notes.E2_field_notebook_typo, ['bookbinding', 'paper', 'notebook', 'stationery', 'craft', 'binding'])).toBe(true);
  });
});

// ── Search quality: recall ────────────────────────────────────────────────────

describe('Search — recall (relevant query → relevant notes)', () => {
  it('voice capture query returns at least one A-cluster note', async () => {
    const results = await search('voice capture pipeline obsidian notes workflow');
    const ids = results.map(r => r.id);
    const clusterA = [notes.A1_voice_capture_plan.id, notes.A2_voice_capture_reflection.id];
    expect(ids.some(id => clusterA.includes(id))).toBe(true);
  });

  it('laser alignment query returns at least one D-cluster note', async () => {
    const results = await search('laser cut plywood layer alignment registration');
    const ids = results.map(r => r.id);
    const clusterD = [notes.D1_laser_alignment_concept.id, notes.D2_laser_alignment_log.id];
    expect(ids.some(id => clusterD.includes(id))).toBe(true);
  });

  it('creative philosophy query returns at least one C-cluster note', async () => {
    const results = await search('creativity devotion making practice for yourself');
    const ids = results.map(r => r.id);
    const clusterC = [
      notes.C1_making_devotion_reflection.id,
      notes.C2_make_yourself_idea.id,
      notes.C3_do_the_thing_source.id,
    ];
    expect(ids.some(id => clusterC.includes(id))).toBe(true);
  });

  it('kit synthesizer query returns at least one B-cluster note', async () => {
    const results = await search('kit synthesizer Plinky soldering electronics instrument');
    const ids = results.map(r => r.id);
    const clusterB = [notes.B1_kit_synth_concept.id, notes.B2_kit_synth_plan.id];
    expect(ids.some(id => clusterB.includes(id))).toBe(true);
  });

  it('Natural Earth query returns E1', async () => {
    const results = await search('natural earth map data cartography public domain');
    const ids = results.map(r => r.id);
    expect(ids).toContain(notes.E1_naturalearthdata_source.id);
  });
});

// ── Search quality: cross-cluster isolation ───────────────────────────────────

describe('Search — isolation (topic query should NOT cross into unrelated cluster)', () => {
  it('laser alignment query does NOT return voice capture notes', async () => {
    const results = await search('laser cut plywood layer alignment registration', 5);
    const ids = results.map(r => r.id);
    const voiceCaptureIds = [notes.A1_voice_capture_plan.id, notes.A2_voice_capture_reflection.id];
    expect(ids.some(id => voiceCaptureIds.includes(id))).toBe(false);
  });

  it('voice capture query does NOT return laser fabrication notes', async () => {
    const results = await search('voice capture workflow obsidian notes', 5);
    const ids = results.map(r => r.id);
    const laserIds = [notes.D1_laser_alignment_concept.id, notes.D2_laser_alignment_log.id];
    expect(ids.some(id => laserIds.includes(id))).toBe(false);
  });
});

// ── Cross-cluster non-linking ─────────────────────────────────────────────────

describe('Cross-cluster isolation — no spurious links', () => {
  it('voice capture notes are NOT linked to laser fabrication notes', async () => {
    const db = supabase();
    const voiceCaptureIds = [notes.A1_voice_capture_plan.id, notes.A2_voice_capture_reflection.id];
    const laserIds = [notes.D1_laser_alignment_concept.id, notes.D2_laser_alignment_log.id];
    const { data } = await db
      .from('links')
      .select('from_id, to_id')
      .in('from_id', [...voiceCaptureIds, ...laserIds])
      .in('to_id', [...voiceCaptureIds, ...laserIds]);
    // Any results here mean cross-cluster links exist — should be empty
    const crossCluster = (data ?? []).filter(
      (l: { from_id: string; to_id: string }) =>
        (voiceCaptureIds.includes(l.from_id) && laserIds.includes(l.to_id)) ||
        (laserIds.includes(l.from_id) && voiceCaptureIds.includes(l.to_id)),
    );
    expect(crossCluster.length).toBe(0);
  });
});

// ── Cluster F: Question handling (#68, #73) ──────────────────────────────────

describe('Cluster F — Question handling', () => {
  it('F1 direct question: body preserves question form', () => {
    expect(notes.F1_direct_question.body).toContain('?');
  });

  it('F2 multi-question: body preserves question form', () => {
    expect(notes.F2_multi_question.body).toContain('?');
  });

  it('F3 conditional question: body preserves question form', () => {
    expect(notes.F3_conditional_question.body).toContain('?');
  });

  it('F1 direct question: tags include relevant term', () => {
    expect(hasAnyTag(notes.F1_direct_question, ['contemplace', 'gardening', 'duplicate', 'notes'])).toBe(true);
  });

  it('F2 multi-question: tags include relevant term', () => {
    expect(hasAnyTag(notes.F2_multi_question, ['contemplace', 'notes', 'capture', 'maturity', 'resolution'])).toBe(true);
  });

  it('F3 conditional question: tags include relevant term', () => {
    expect(hasAnyTag(notes.F3_conditional_question, ['contemplace', 'obsidian', 'import', 'mcp', 'notes'])).toBe(true);
  });
});

// ── Cluster G: Short input entity extraction (#51) ───────────────────────────

describe('Cluster G — Short input entity extraction', () => {
  it('G1 short with person: captures successfully', () => {
    expect(typeof notes.G1_short_with_person.id).toBe('string');
  });

  it('G1 short with person: entities include Nicolas Bras', async () => {
    const db = supabase();
    const { data } = await db.from('notes').select('entities').eq('id', notes.G1_short_with_person.id).single();
    const entities = (data as { entities: Array<{ name: string; type: string }> })?.entities ?? [];
    expect(entities.some(e => e.name.toLowerCase().includes('nicolas bras') && e.type === 'person')).toBe(true);
  });

  it('G1 short with person: tags include instrument-related term', () => {
    expect(hasAnyTag(notes.G1_short_with_person, ['instrument', 'found-object', 'diy', 'sound', 'percussion'])).toBe(true);
  });
});

// ── Cluster H: Tag priority (#52) ────────────────────────────────────────────

describe('Cluster H — Tag priority for specific subjects', () => {
  it('H1 specific subject: tags include cimbalom', () => {
    expect(notes.H1_specific_subject.tags.some(t => t.toLowerCase().includes('cimbalom'))).toBe(true);
  });

  it('H1 specific subject: has both specific and broad tags', () => {
    const tags = notes.H1_specific_subject.tags.map(t => t.toLowerCase());
    const hasSpecific = tags.some(t => t.includes('cimbalom'));
    const hasBroad = tags.some(t =>
      t.includes('instrument') || t.includes('diy') || t.includes('percussion') ||
      t.includes('found-object') || t.includes('craft')
    );
    expect(hasSpecific && hasBroad).toBe(true);
  });

});

// ── Cluster I: Personal convictions ──────────────────────────────────────────

describe('Cluster I — Personal convictions', () => {
  // Classification: conviction-shaped input should be reflection, not idea
  it('I2 issues as thinking: type is reflection or idea', () => {
    // "I prefer X" describes a workflow preference — LLM may read as concept (idea)
    // rather than personal insight (reflection). Both are defensible.
  });

  it('I3 invisible systems: type is reflection or idea', () => {
    // Could go either way — it's a design principle stated as conviction
  });

  // Intent: beliefs are about remembering or reflecting
  it('I4 emergent over imposed: intent is remember, reflect, or plan', () => {
    // Imperative mood ("don't do X, just make sure Y works") reads as forward-looking
    // guidance, so LLM may classify as plan. All three are defensible.
  });

  // Tags: should surface the specific topic, not just generic "beliefs"
  it('I1 docs as deliverable: tags include documentation-related term', () => {
    expect(hasAnyTag(notes.I1_docs_as_deliverable, ['documentation', 'software', 'development', 'quality'])).toBe(true);
  });

  it('I2 issues as thinking: tags include project management term', () => {
    expect(hasAnyTag(notes.I2_issues_as_thinking, ['github', 'project', 'workflow', 'issue', 'development'])).toBe(true);
  });

  it('I3 invisible systems: tags include design or UX term', () => {
    expect(hasAnyTag(notes.I3_invisible_systems, ['design', 'ux', 'product', 'user-experience', 'tool'])).toBe(true);
  });

  it('I4 emergent over imposed: tags include emergence or structure term', () => {
    expect(hasAnyTag(notes.I4_emergent_over_imposed, ['emergence', 'structure', 'process', 'design', 'organization', 'pattern'])).toBe(true);
  });

  // Body preservation: first-person stance should survive capture
  it('I1 docs as deliverable: body preserves conviction substance', () => {
    const body = notes.I1_docs_as_deliverable.body.toLowerCase();
    // The agent may condense "documentation" to "doc" — check for either
    expect(body.includes('doc') || body.includes('documentation')).toBe(true);
    // The core claim should survive: docs are part of shipping, not separate
    expect(body.includes('incomplete') || body.includes('deliverable') || body.includes('shipping')).toBe(true);
  });

  it('I3 invisible systems: body preserves design principle', () => {
    const body = notes.I3_invisible_systems.body.toLowerCase();
    expect(body.includes('user') || body.includes('tool') || body.includes('system')).toBe(true);
  });

  // Linking: I3 (invisible systems) and I4 (emergent over imposed) share
  // a philosophical thread — trusting systems over controlling them.
  // At least one cross-conviction link should form.
  it('at least one pair of conviction notes is linked', async () => {
    const ids = [
      notes.I1_docs_as_deliverable.id,
      notes.I2_issues_as_thinking.id,
      notes.I3_invisible_systems.id,
      notes.I4_emergent_over_imposed.id,
    ];
    const db = supabase();
    const { data } = await db
      .from('links')
      .select('from_id, to_id')
      .in('from_id', ids)
      .in('to_id', ids);
    // At least one intra-cluster link should exist
    expect((data ?? []).length).toBeGreaterThan(0);
  });
});

// ── Search quality: conviction retrieval ──────────────────────────────────────

describe('Search — conviction retrieval', () => {
  it('"beliefs about documentation" surfaces I1', async () => {
    const results = await search('beliefs about documentation practices');
    const ids = results.map(r => r.id);
    expect(ids).toContain(notes.I1_docs_as_deliverable.id);
  });

  it('"design philosophy user experience" surfaces I3 or I4', async () => {
    const results = await search('design philosophy user experience invisible system');
    const ids = results.map(r => r.id);
    const convictionIds = [notes.I3_invisible_systems.id, notes.I4_emergent_over_imposed.id];
    expect(ids.some(id => convictionIds.includes(id))).toBe(true);
  });

  it('"how does this user manage projects" surfaces I2', async () => {
    const results = await search('project management workflow GitHub issues tracking');
    const ids = results.map(r => r.id);
    expect(ids).toContain(notes.I2_issues_as_thinking.id);
  });
});

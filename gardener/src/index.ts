import { createSupabaseClient, deleteGardenerSimilarityLinks, fetchNotesForSimilarity, findSimilarPairs, insertSimilarityLinks, logEnrichments } from './db';
import { loadConfig } from './config';
import { buildContext } from './similarity';
import { sendAlert } from './alert';
import { validateTriggerAuth } from './auth';
import type { Env, SimilarityLink } from './types';

export interface GardenerRunResult {
  event: 'gardener_run_complete';
  similarity: {
    notes_processed: number;
    links_deleted: number;
    links_created: number;
    enriched_notes: number;
    errors: string[];
  };
  duration_ms: number;
}

// ── Similarity linker ─────────────────────────────────────────────────────────

export async function runSimilarityLinker(env: Env): Promise<{
  notes_processed: number;
  links_deleted: number;
  links_created: number;
  enriched_notes: number;
  errors: string[];
}> {
  const errors: string[] = [];
  const config = loadConfig(env);
  const db = createSupabaseClient(config);

  // 1. Clean slate
  const linksDeleted = await deleteGardenerSimilarityLinks(db);

  // 2. Fetch notes (for tags needed by buildContext) and similar pairs in parallel
  const [notes, pairs] = await Promise.all([
    fetchNotesForSimilarity(db),
    findSimilarPairs(db, config.similarityThreshold),
  ]);

  // 3. Index notes by ID for fast lookup during context building
  const noteMap = new Map(notes.map(n => [n.id, n]));

  // 4. Build all links from pairs
  const allLinks: SimilarityLink[] = [];
  const enrichedNoteIds = new Set<string>();

  for (const pair of pairs) {
    const noteA = noteMap.get(pair.note_a);
    const noteB = noteMap.get(pair.note_b);
    if (!noteA || !noteB) continue;

    const context = buildContext(noteA, noteB, pair.similarity);
    allLinks.push({
      fromId: pair.note_a,
      toId: pair.note_b,
      confidence: pair.similarity,
      context,
    });
    enrichedNoteIds.add(pair.note_a);
    enrichedNoteIds.add(pair.note_b);
  }

  // 5. Batch insert all links in one call
  if (allLinks.length > 0) {
    try {
      await insertSimilarityLinks(db, allLinks);
    } catch (err) {
      errors.push(`similarity links insert: ${String(err)}`);
    }
  }

  await logEnrichments(db, [...enrichedNoteIds]);

  return {
    notes_processed: notes.length,
    links_deleted: linksDeleted,
    links_created: allLinks.length,
    enriched_notes: enrichedNoteIds.size,
    errors,
  };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

async function runGardener(env: Env): Promise<GardenerRunResult> {
  const startTime = Date.now();

  const simResult = await runSimilarityLinker(env);

  const result: GardenerRunResult = {
    event: 'gardener_run_complete',
    similarity: simResult,
    duration_ms: Date.now() - startTime,
  };

  console.log(JSON.stringify(result));

  if (simResult.errors.length > 0) {
    throw new Error(`Gardener run completed with ${simResult.errors.length} error(s) — see logs above`);
  }

  return result;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await runGardener(env);
    } catch (err) {
      console.error(JSON.stringify({
        event: 'gardener_run_failed',
        error: String(err),
      }));
      await sendAlert(env, err);
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== '/trigger') {
      return new Response('Not Found', { status: 404 });
    }

    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const authError = validateTriggerAuth(request, env);
    if (authError) return authError;

    try {
      const result = await runGardener(env);
      return new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      console.error(JSON.stringify({
        event: 'gardener_run_failed',
        error: String(err),
      }));
      await sendAlert(env, err);
      return new Response(JSON.stringify({
        event: 'gardener_run_failed',
        error: String(err),
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};

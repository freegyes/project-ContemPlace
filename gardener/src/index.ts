import { WorkerEntrypoint } from 'cloudflare:workers';
import { createSupabaseClient, deleteGardenerSimilarityLinks, fetchNotesForSimilarity, findSimilarPairs, insertSimilarityLinks, logEnrichments, deleteAllClusters, insertClusters, fetchNotesForEntityExtraction, fetchAllRawExtractions, fetchNoteCreatedAts, logEntityExtractions, rebuildEntityDictionary, batchUpdateNoteEntities, fetchEntityDictionary } from './db';
import { loadConfig } from './config';
import { buildContext } from './similarity';
import { runClustering, type ClusteringResult } from './clustering';
import { extractEntitiesFromNote, resolveEntities, mapNotesToCanonicalEntities } from './entities';
import { createOpenAIClient } from './ai';
import { sendAlert } from './alert';
import { validateTriggerAuth } from './auth';
import type { Env, NoteForSimilarity, SimilarityLink, RawExtraction } from './types';

export interface GardenerRunResult {
  event: 'gardener_run_complete';
  similarity: {
    notes_processed: number;
    links_deleted: number;
    links_created: number;
    enriched_notes: number;
    errors: string[];
  };
  clustering: {
    clusters_created: number;
    resolutions_run: number;
    clusters_deleted: number;
    error: string | null;
  };
  entities: {
    notes_extracted: number;
    dictionary_entries: number;
    notes_updated: number;
    error: string | null;
  };
  duration_ms: number;
}

// ── Similarity linker ─────────────────────────────────────────────────────────

export function runSimilarityLinker(
  notes: NoteForSimilarity[],
  pairs: Array<{ note_a: string; note_b: string; similarity: number }>,
): {
  links: SimilarityLink[];
  enrichedNoteIds: Set<string>;
} {
  const noteMap = new Map(notes.map(n => [n.id, n]));
  const links: SimilarityLink[] = [];
  const enrichedNoteIds = new Set<string>();

  for (const pair of pairs) {
    const noteA = noteMap.get(pair.note_a);
    const noteB = noteMap.get(pair.note_b);
    if (!noteA || !noteB) continue;

    const context = buildContext(noteA, noteB, pair.similarity);
    links.push({
      fromId: pair.note_a,
      toId: pair.note_b,
      confidence: pair.similarity,
      context,
    });
    enrichedNoteIds.add(pair.note_a);
    enrichedNoteIds.add(pair.note_b);
  }

  return { links, enrichedNoteIds };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

const CLUSTER_PAIR_LIMIT = 50000;

async function runGardener(env: Env): Promise<GardenerRunResult> {
  const startTime = Date.now();
  const config = loadConfig(env);
  const db = createSupabaseClient(config);
  const errors: string[] = [];

  // 1. Clean slate for similarity links
  const linksDeleted = await deleteGardenerSimilarityLinks(db);

  // 2. Fetch notes and all pairs at cosineFloor (shared data for both phases)
  const [notes, allPairs] = await Promise.all([
    fetchNotesForSimilarity(db),
    findSimilarPairs(db, config.cosineFloor, CLUSTER_PAIR_LIMIT),
  ]);

  if (allPairs.length === CLUSTER_PAIR_LIMIT) {
    console.warn(JSON.stringify({
      event: 'pair_limit_reached',
      limit: CLUSTER_PAIR_LIMIT,
      message: 'find_similar_pairs returned exactly the limit — some pairs may be missing',
    }));
  }

  // 3. Filter pairs >= similarityThreshold for the linker
  const linkerPairs = allPairs.filter(p => p.similarity >= config.similarityThreshold);

  // 4. Run similarity linker
  const { links, enrichedNoteIds } = runSimilarityLinker(notes, linkerPairs);

  if (links.length > 0) {
    try {
      await insertSimilarityLinks(db, links);
    } catch (err) {
      errors.push(`similarity links insert: ${String(err)}`);
    }
  }

  await logEnrichments(db, [...enrichedNoteIds]);

  // 5. Run clustering (failure must not kill the gardener run)
  let clusteringReport: GardenerRunResult['clustering'] = {
    clusters_created: 0,
    resolutions_run: 0,
    clusters_deleted: 0,
    error: null,
  };

  try {
    const clustersDeleted = await deleteAllClusters(db);
    const { rows, result: clusterResult } = runClustering(notes, allPairs, config.clusterResolutions);
    await insertClusters(db, rows);

    clusteringReport = {
      ...clusterResult,
      clusters_deleted: clustersDeleted,
      error: null,
    };
  } catch (err) {
    const errorMsg = String(err);
    clusteringReport.error = errorMsg;
    console.error(JSON.stringify({
      event: 'clustering_failed',
      error: errorMsg,
    }));
  }

  // 6. Entity extraction (failure must not kill the gardener run)
  let entitiesReport: GardenerRunResult['entities'] = {
    notes_extracted: 0,
    dictionary_entries: 0,
    notes_updated: 0,
    error: null,
  };

  // Subrequest budget: CF Workers limit is 50 per invocation.
  // Similarity + clustering use ~7-9. Entity extraction gets the rest.
  // Per-run cost: ~9 fixed DB calls + N LLM calls + N note updates = 9 + 2N.
  // Default batch size 15 → 9 + 30 = 39 subrequests. Under 50 with margin.
  if (config.entityConfig) {
    try {
      const entityConfig = config.entityConfig;
      const aiClient = createOpenAIClient(entityConfig);

      // 6a. Fetch notes needing extraction (incremental) — 2 DB calls
      const notesToExtract = await fetchNotesForEntityExtraction(db, entityConfig.entityBatchSize);

      const newExtractions: RawExtraction[] = [];
      if (notesToExtract.length > 0) {
        // 6b. Fetch existing dictionary for type consistency — 1 DB call
        const existingEntities = await fetchEntityDictionary(db);

        // 6c. Extract entities from new notes — N LLM calls
        for (const note of notesToExtract) {
          try {
            const entities = await extractEntitiesFromNote(aiClient, entityConfig, note, existingEntities);
            newExtractions.push({ noteId: note.id, entities });
          } catch (extractErr) {
            console.warn(JSON.stringify({
              event: 'entity_extraction_note_error',
              noteId: note.id,
              error: String(extractErr),
            }));
          }
        }

        // 6d. Log raw extractions to enrichment_log — 1 DB call
        if (newExtractions.length > 0) {
          await logEntityExtractions(db, newExtractions, entityConfig.entityModel);
        }
      }

      // 6e. Resolve + rebuild dictionary only when there are new extractions
      if (newExtractions.length > 0) {
        // Fetch ALL raw extractions for full resolution — 2 DB calls
        const allExtractions = await fetchAllRawExtractions(db);
        const noteCreatedAts = await fetchNoteCreatedAts(db); // 1 DB call
        const dictionary = resolveEntities(allExtractions, noteCreatedAts);

        // Clean-slate rebuild dictionary — 2 DB calls (delete + insert)
        const { inserted } = await rebuildEntityDictionary(db, dictionary);

        // Only update notes.entities for newly extracted notes — N DB calls
        // Full corpus reconciliation happens gradually as each batch is processed.
        const noteEntityMap = mapNotesToCanonicalEntities(newExtractions, dictionary);
        const notesUpdated = await batchUpdateNoteEntities(db, noteEntityMap);

        entitiesReport = {
          notes_extracted: newExtractions.length,
          dictionary_entries: inserted,
          notes_updated: notesUpdated,
          error: null,
        };
      }

      console.log(JSON.stringify({
        event: 'entity_extraction_complete',
        notes_extracted: entitiesReport.notes_extracted,
        dictionary_entries: entitiesReport.dictionary_entries,
        notes_updated: entitiesReport.notes_updated,
      }));
    } catch (err) {
      const errorMsg = String(err);
      entitiesReport.error = errorMsg;
      console.error(JSON.stringify({
        event: 'entity_extraction_failed',
        error: errorMsg,
      }));
    }
  }

  const result: GardenerRunResult = {
    event: 'gardener_run_complete',
    similarity: {
      notes_processed: notes.length,
      links_deleted: linksDeleted,
      links_created: links.length,
      enriched_notes: enrichedNoteIds.size,
      errors,
    },
    clustering: clusteringReport,
    entities: entitiesReport,
    duration_ms: Date.now() - startTime,
  };

  console.log(JSON.stringify(result));

  if (errors.length > 0) {
    throw new Error(`Gardener run completed with ${errors.length} error(s) — see logs above`);
  }

  return result;
}

// ── GardenerService RPC entrypoint (for Service Binding from MCP Worker) ─────
// Named export — coexists with the default export (cron + HTTP trigger).

export class GardenerService extends WorkerEntrypoint<Env> {
  async trigger(): Promise<GardenerRunResult> {
    return runGardener(this.env);
  }
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

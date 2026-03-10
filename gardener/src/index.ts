import { createSupabaseClient, deleteGardenerSimilarityLinks, fetchNotesForSimilarity, findSimilarNotes, insertSimilarityLinks, logEnrichments } from './db';
import { loadConfig } from './config';
import { buildContext } from './similarity';
import type { Env, SimilarityLink } from './types';

async function runSimilarityLinker(env: Env): Promise<void> {
  const startTime = Date.now();
  const errors: string[] = [];

  const config = loadConfig(env);
  const db = createSupabaseClient(config);

  // 1. Clean slate — delete all gardener is-similar-to links before re-computing.
  //    Must be first: a partial run leaves a partially-populated but consistent state
  //    (no stale links from a prior threshold remain) and the next run rebuilds fully.
  const linksDeleted = await deleteGardenerSimilarityLinks(db);

  // 2. Fetch all active notes with embeddings.
  const notes = await fetchNotesForSimilarity(db);

  // 3. For each note A, find similar notes via match_notes RPC.
  //
  //    Direction convention: is-similar-to is semantically undirected, but the links
  //    table is directed. We store exactly one row per pair with the lower UUID as
  //    from_id. fetchNoteLinks queries both directions via .or(), so get_related works
  //    correctly regardless of which end is stored as from_id.
  //
  //    Scale note: per-note RPC approach works up to ~200–300 notes (30s CPU limit).
  //    TODO: replace findSimilarNotes internals with a single SQL self-join function
  //    (find_similar_pairs RPC) when note count approaches this ceiling.
  let linksCreated = 0;
  const enrichedNoteIds = new Set<string>();

  for (const noteA of notes) {
    try {
      const similar = await findSimilarNotes(db, noteA.embedding, config.similarityThreshold);
      const linksToInsert: SimilarityLink[] = [];

      for (const noteB of similar) {
        if (noteA.id === noteB.id) continue; // filter self-similarity (score 1.0)
        if (noteA.id >= noteB.id) continue;  // deduplicate: only process when A is the lower UUID

        const context = buildContext(noteA, noteB, noteB.similarity);
        linksToInsert.push({
          fromId: noteA.id,
          toId: noteB.id,
          confidence: noteB.similarity,
          context,
        });
      }

      if (linksToInsert.length > 0) {
        await insertSimilarityLinks(db, linksToInsert);
        linksCreated += linksToInsert.length;
        enrichedNoteIds.add(noteA.id);
      }
    } catch (err) {
      errors.push(`note ${noteA.id}: ${String(err)}`);
    }
  }

  // 4. Log enrichment entries for notes that received new outbound links.
  await logEnrichments(db, [...enrichedNoteIds]);

  // 5. Structured run summary — queryable via: wrangler tail --name contemplace-gardener
  console.log(JSON.stringify({
    event: 'gardener_run_complete',
    notes_processed: notes.length,
    links_deleted: linksDeleted,
    links_created: linksCreated,
    enriched_notes: enrichedNoteIds.size,
    duration_ms: Date.now() - startTime,
    errors,
  }));

  if (errors.length > 0) {
    throw new Error(`Gardener run completed with ${errors.length} error(s) — see logs above`);
  }
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    try {
      await runSimilarityLinker(env);
    } catch (err) {
      console.error(JSON.stringify({
        event: 'gardener_run_failed',
        error: String(err),
      }));
    }
  },
};

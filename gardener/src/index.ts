import { createSupabaseClient, deleteGardenerSimilarityLinks, fetchNotesForSimilarity, findSimilarNotes, insertSimilarityLinks, logEnrichments,
         fetchConcepts, updateConceptEmbedding, fetchNotesForTagNorm, deleteGardenerNoteConcepts,
         insertNoteConcepts, updateRefinedTags, deleteUnmatchedTagLogs, logUnmatchedTags, logTagNormEnrichments } from './db';
import { loadConfig } from './config';
import { buildContext } from './similarity';
import { buildConceptEmbeddingInput, lexicalMatch, resolveNoteTags } from './normalize';
import { createOpenAIClient, batchEmbedTexts } from './embed';
import { sendAlert } from './alert';
import { validateTriggerAuth } from './auth';
import type { Env, SimilarityLink, TagNormResult, Concept } from './types';

export interface GardenerRunResult {
  event: 'gardener_run_complete';
  similarity: {
    notes_processed: number;
    links_deleted: number;
    links_created: number;
    enriched_notes: number;
    errors: string[];
  };
  tag_normalization: TagNormResult | { event: 'tag_normalization_skipped'; reason: string };
  duration_ms: number;
}

// ── Tag normalization ─────────────────────────────────────────────────────────

export async function runTagNormalization(env: Env): Promise<TagNormResult> {
  const errors: string[] = [];
  const config = loadConfig(env);
  const db = createSupabaseClient(config);

  // 1. Fetch all concepts
  const concepts = await fetchConcepts(db);
  if (concepts.length === 0) {
    return {
      event: 'tag_normalization_complete',
      notes_processed: 0,
      tags_matched: 0,
      tags_unmatched: 0,
      concepts_embedded: 0,
      errors: ['No concepts found — seed the vocabulary first'],
    };
  }

  // 2. Populate null concept embeddings (first run + newly promoted concepts)
  let conceptsEmbedded = 0;
  const conceptsNeedingEmbedding = concepts.filter(c => c.embedding === null);
  if (conceptsNeedingEmbedding.length > 0 && config.openrouterApiKey) {
    try {
      const openai = createOpenAIClient({ openrouterApiKey: config.openrouterApiKey, embedModel: config.embedModel });
      const texts = conceptsNeedingEmbedding.map(c => buildConceptEmbeddingInput(c));
      const embeddings = await batchEmbedTexts(openai, { openrouterApiKey: config.openrouterApiKey, embedModel: config.embedModel }, texts);

      for (let i = 0; i < conceptsNeedingEmbedding.length; i++) {
        const concept = conceptsNeedingEmbedding[i]!;
        const emb = embeddings[i]!;
        try {
          await updateConceptEmbedding(db, concept.id, emb);
          concept.embedding = emb;
          conceptsEmbedded++;
        } catch (err) {
          errors.push(`concept embed update ${concept.pref_label}: ${String(err)}`);
        }
      }
    } catch (err) {
      errors.push(`batch concept embedding failed: ${String(err)}`);
    }
  } else if (conceptsNeedingEmbedding.length > 0) {
    console.warn(JSON.stringify({
      event: 'concept_embedding_skipped',
      reason: 'OPENROUTER_API_KEY not configured',
      count: conceptsNeedingEmbedding.length,
    }));
  }

  // 3. Clean slate: delete gardener note_concepts + unmatched_tag logs
  await deleteGardenerNoteConcepts(db);
  await deleteUnmatchedTagLogs(db);

  // 4. Fetch all active notes with tags
  const notes = await fetchNotesForTagNorm(db);
  if (notes.length === 0) {
    return {
      event: 'tag_normalization_complete',
      notes_processed: 0,
      tags_matched: 0,
      tags_unmatched: 0,
      concepts_embedded: conceptsEmbedded,
      errors,
    };
  }

  // 5. Collect all unique tags that don't match lexically — for batch embedding
  const conceptsWithEmbeddings = concepts
    .filter((c): c is Concept & { embedding: number[] } => c.embedding !== null)
    .map(c => ({ concept: c, embedding: c.embedding }));

  let tagEmbeddings = new Map<string, number[]>();

  const apiKey = config.openrouterApiKey;
  if (apiKey && conceptsWithEmbeddings.length > 0) {
    const allUnmatchedTags = new Set<string>();
    for (const note of notes) {
      for (const tag of note.tags) {
        if (!lexicalMatch(tag, concepts)) {
          allUnmatchedTags.add(tag.toLowerCase());
        }
      }
    }

    if (allUnmatchedTags.size > 0) {
      try {
        const tagList = [...allUnmatchedTags];
        const embedConfig = { openrouterApiKey: apiKey, embedModel: config.embedModel };
        const openai = createOpenAIClient(embedConfig);
        const embeddings = await batchEmbedTexts(openai, embedConfig, tagList);
        for (let i = 0; i < tagList.length; i++) {
          tagEmbeddings.set(tagList[i]!, embeddings[i]!);
        }
      } catch (err) {
        errors.push(`batch tag embedding failed: ${String(err)}`);
        tagEmbeddings = new Map();
      }
    }
  }

  // 6. Process each note
  let totalMatched = 0;
  let totalUnmatched = 0;
  const allNoteConcepts: Array<{ note_id: string; concept_id: string }> = [];
  const allUnmatchedEntries: Array<{ note_id: string; tag: string }> = [];
  const processedNoteIds: string[] = [];

  for (const note of notes) {
    try {
      const { matched, unmatched } = resolveNoteTags(
        note, concepts, conceptsWithEmbeddings, tagEmbeddings, config.tagMatchThreshold,
      );

      // Collect refined_tags update
      const refinedTags = matched.map(m => m.prefLabel);
      await updateRefinedTags(db, note.id, refinedTags);

      // Collect note_concepts rows
      for (const m of matched) {
        allNoteConcepts.push({ note_id: note.id, concept_id: m.conceptId });
      }

      // Collect unmatched tag log entries
      for (const tag of unmatched) {
        allUnmatchedEntries.push({ note_id: note.id, tag });
      }

      totalMatched += matched.length;
      totalUnmatched += unmatched.length;
      processedNoteIds.push(note.id);
    } catch (err) {
      errors.push(`note ${note.id}: ${String(err)}`);
    }
  }

  // 7. Batch writes
  if (allNoteConcepts.length > 0) {
    try {
      await insertNoteConcepts(db, allNoteConcepts);
    } catch (err) {
      errors.push(`note_concepts insert: ${String(err)}`);
    }
  }

  await logUnmatchedTags(db, allUnmatchedEntries);
  await logTagNormEnrichments(db, processedNoteIds);

  const result: TagNormResult = {
    event: 'tag_normalization_complete',
    notes_processed: notes.length,
    tags_matched: totalMatched,
    tags_unmatched: totalUnmatched,
    concepts_embedded: conceptsEmbedded,
    errors,
  };

  console.log(JSON.stringify(result));
  return result;
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

  const linksDeleted = await deleteGardenerSimilarityLinks(db);
  const notes = await fetchNotesForSimilarity(db);

  let linksCreated = 0;
  const enrichedNoteIds = new Set<string>();

  for (const noteA of notes) {
    try {
      const similar = await findSimilarNotes(db, noteA.embedding, config.similarityThreshold);
      const linksToInsert: SimilarityLink[] = [];

      for (const noteB of similar) {
        if (noteA.id === noteB.id) continue;
        if (noteA.id >= noteB.id) continue;

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

  await logEnrichments(db, [...enrichedNoteIds]);

  return {
    notes_processed: notes.length,
    links_deleted: linksDeleted,
    links_created: linksCreated,
    enriched_notes: enrichedNoteIds.size,
    errors,
  };
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

async function runGardener(env: Env): Promise<GardenerRunResult> {
  const startTime = Date.now();

  // Phase 1: Tag normalization (runs first — see docs/decisions.md)
  let tagNormResult: TagNormResult | { event: 'tag_normalization_skipped'; reason: string };
  try {
    tagNormResult = await runTagNormalization(env);
  } catch (err) {
    console.error(JSON.stringify({ event: 'tag_normalization_failed', error: String(err) }));
    tagNormResult = { event: 'tag_normalization_skipped', reason: String(err) };
    // Continue to similarity linker — independent steps
  }

  // Phase 2: Similarity linking
  const simResult = await runSimilarityLinker(env);

  const result: GardenerRunResult = {
    event: 'gardener_run_complete',
    similarity: simResult,
    tag_normalization: tagNormResult,
    duration_ms: Date.now() - startTime,
  };

  console.log(JSON.stringify(result));

  // Check for errors in either phase
  const allErrors = [
    ...simResult.errors,
    ...('errors' in tagNormResult ? tagNormResult.errors : []),
  ];
  if (allErrors.length > 0) {
    throw new Error(`Gardener run completed with ${allErrors.length} error(s) — see logs above`);
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

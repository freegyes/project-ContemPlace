import { createSupabaseClient, deleteGardenerSimilarityLinks, fetchNotesForSimilarity, findSimilarPairs, insertSimilarityLinks, logEnrichments,
         fetchConcepts, batchUpdateConceptEmbeddings, fetchNotesForTagNorm, deleteGardenerNoteConcepts,
         insertNoteConcepts, batchUpdateRefinedTags, deleteUnmatchedTagLogs, logUnmatchedTags, logTagNormEnrichments,
         fetchNotesForChunking, fetchChunkingHashes, deleteChunksForNotes, deleteChunkingLogs, insertChunks, logChunkingEnrichments } from './db';
import { loadConfig } from './config';
import { buildContext } from './similarity';
import { buildConceptEmbeddingInput, lexicalMatch, resolveNoteTags } from './normalize';
import { splitIntoChunks, buildChunkEmbeddingInput, MIN_BODY_LENGTH } from './chunk';
import { createOpenAIClient, batchEmbedTexts } from './embed';
import { sendAlert } from './alert';
import { validateTriggerAuth } from './auth';
import type { Env, SimilarityLink, TagNormResult, ChunkGenResult, Concept } from './types';

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
  chunk_generation: ChunkGenResult | { event: 'chunk_generation_skipped'; reason: string };
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

      // Prepare batch update (single round-trip instead of N individual calls)
      const updates: Array<{ id: string; scheme: string; pref_label: string; embedding: number[] }> = [];
      for (let i = 0; i < conceptsNeedingEmbedding.length; i++) {
        const concept = conceptsNeedingEmbedding[i]!;
        const emb = embeddings[i]!;
        concept.embedding = emb;
        updates.push({ id: concept.id, scheme: concept.scheme, pref_label: concept.pref_label, embedding: emb });
      }

      await batchUpdateConceptEmbeddings(db, updates);
      conceptsEmbedded = updates.length;
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
  const allRefinedTags: Array<{ id: string; refined_tags: string[] }> = [];
  const processedNoteIds: string[] = [];

  for (const note of notes) {
    try {
      const { matched, unmatched } = resolveNoteTags(
        note, concepts, conceptsWithEmbeddings, tagEmbeddings, config.tagMatchThreshold,
      );

      // Collect refined_tags for batch update
      allRefinedTags.push({ id: note.id, refined_tags: matched.map(m => m.prefLabel) });

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
  if (allRefinedTags.length > 0) {
    try {
      await batchUpdateRefinedTags(db, allRefinedTags);
    } catch (err) {
      errors.push(`refined_tags batch update: ${String(err)}`);
    }
  }

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

// ── Chunk generation ──────────────────────────────────────────────────────────

// SHA-256 hash using Web Crypto API (available in CF Workers).
async function hashBody(body: string): Promise<string> {
  const data = new TextEncoder().encode(body);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Max inputs per batchEmbedTexts call (OpenAI limit is 2048).
const EMBED_BATCH_LIMIT = 2000;

export async function runChunkGeneration(env: Env): Promise<ChunkGenResult> {
  const errors: string[] = [];
  const config = loadConfig(env);

  if (!config.openrouterApiKey) {
    return {
      event: 'chunk_generation_complete',
      notes_eligible: 0,
      notes_chunked: 0,
      notes_skipped: 0,
      chunks_created: 0,
      errors: ['OPENROUTER_API_KEY not configured — cannot embed chunks'],
    };
  }

  const db = createSupabaseClient(config);
  const openai = createOpenAIClient({ openrouterApiKey: config.openrouterApiKey, embedModel: config.embedModel });
  const embedConfig = { openrouterApiKey: config.openrouterApiKey, embedModel: config.embedModel };

  // 1. Fetch eligible notes and existing body hashes in parallel
  const [notes, existingHashes] = await Promise.all([
    fetchNotesForChunking(db, MIN_BODY_LENGTH),
    fetchChunkingHashes(db),
  ]);

  if (notes.length === 0) {
    return {
      event: 'chunk_generation_complete',
      notes_eligible: 0,
      notes_chunked: 0,
      notes_skipped: 0,
      chunks_created: 0,
      errors,
    };
  }

  // 2. Compute body hashes and determine which notes need (re-)chunking
  const notesToProcess: Array<{ note: typeof notes[0]; bodyHash: string; chunks: ReturnType<typeof splitIntoChunks> }> = [];
  let skipped = 0;

  for (const note of notes) {
    const bodyHash = await hashBody(note.body);
    const existingHash = existingHashes.get(note.id);

    if (existingHash === bodyHash) {
      skipped++;
      continue;
    }

    const chunks = splitIntoChunks(note.body);
    if (chunks.length === 0) {
      skipped++;
      continue;
    }

    notesToProcess.push({ note, bodyHash, chunks });
  }

  if (notesToProcess.length === 0) {
    return {
      event: 'chunk_generation_complete',
      notes_eligible: notes.length,
      notes_chunked: 0,
      notes_skipped: skipped,
      chunks_created: 0,
      errors,
    };
  }

  // 3. Delete existing chunks and enrichment logs for notes being (re-)processed
  const noteIdsToProcess = notesToProcess.map(n => n.note.id);
  await Promise.all([
    deleteChunksForNotes(db, noteIdsToProcess),
    deleteChunkingLogs(db, noteIdsToProcess),
  ]);

  // 4. Build all chunk embedding inputs
  const allChunkTexts: string[] = [];
  const chunkMetadata: Array<{ noteIdx: number; chunkIdx: number }> = [];

  for (let ni = 0; ni < notesToProcess.length; ni++) {
    const { note, chunks } = notesToProcess[ni]!;
    for (const chunk of chunks) {
      allChunkTexts.push(buildChunkEmbeddingInput(note.title, note.tags, chunk.content));
      chunkMetadata.push({ noteIdx: ni, chunkIdx: chunk.index });
    }
  }

  // 5. Batch embed (with batch size guard)
  let allEmbeddings: number[][] = [];
  try {
    if (allChunkTexts.length <= EMBED_BATCH_LIMIT) {
      allEmbeddings = await batchEmbedTexts(openai, embedConfig, allChunkTexts);
    } else {
      // Split into batches
      for (let i = 0; i < allChunkTexts.length; i += EMBED_BATCH_LIMIT) {
        const batch = allChunkTexts.slice(i, i + EMBED_BATCH_LIMIT);
        const batchEmbeddings = await batchEmbedTexts(openai, embedConfig, batch);
        allEmbeddings.push(...batchEmbeddings);
      }
    }
  } catch (err) {
    errors.push(`batch chunk embedding failed: ${String(err)}`);
    const result: ChunkGenResult = {
      event: 'chunk_generation_complete',
      notes_eligible: notes.length,
      notes_chunked: 0,
      notes_skipped: skipped,
      chunks_created: 0,
      errors,
    };
    console.log(JSON.stringify(result));
    return result;
  }

  // 6. Build insert rows and enrichment log entries
  const chunkRows: Array<{ note_id: string; chunk_index: number; content: string; embedding: number[] }> = [];
  const enrichmentEntries: Array<{ note_id: string; body_hash: string; model_used: string }> = [];
  let notesChunked = 0;

  // Track per-note success for error isolation
  const noteSuccess = new Set<number>();

  for (let i = 0; i < chunkMetadata.length; i++) {
    const meta = chunkMetadata[i]!;
    const entry = notesToProcess[meta.noteIdx]!;
    const embedding = allEmbeddings[i];
    if (!embedding) {
      errors.push(`missing embedding for chunk ${meta.chunkIdx} of note ${entry.note.id}`);
      continue;
    }
    chunkRows.push({
      note_id: entry.note.id,
      chunk_index: meta.chunkIdx,
      content: entry.chunks[meta.chunkIdx]!.content,
      embedding,
    });
    noteSuccess.add(meta.noteIdx);
  }

  // Build enrichment entries only for notes with all chunks embedded
  for (const ni of noteSuccess) {
    const entry = notesToProcess[ni]!;
    enrichmentEntries.push({
      note_id: entry.note.id,
      body_hash: entry.bodyHash,
      model_used: config.embedModel,
    });
    notesChunked++;
  }

  // 7. Batch insert chunks + log enrichments
  if (chunkRows.length > 0) {
    try {
      await insertChunks(db, chunkRows);
    } catch (err) {
      errors.push(`chunk insert failed: ${String(err)}`);
      notesChunked = 0;
    }
  }

  if (notesChunked > 0) {
    await logChunkingEnrichments(db, enrichmentEntries);
  }

  const result: ChunkGenResult = {
    event: 'chunk_generation_complete',
    notes_eligible: notes.length,
    notes_chunked: notesChunked,
    notes_skipped: skipped,
    chunks_created: chunkRows.length,
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

  // 1. Clean slate
  const linksDeleted = await deleteGardenerSimilarityLinks(db);

  // 2. Fetch notes (for tags/entities needed by buildContext) and similar pairs in parallel
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

  // Phase 3: Chunk generation
  let chunkGenResult: ChunkGenResult | { event: 'chunk_generation_skipped'; reason: string };
  try {
    chunkGenResult = await runChunkGeneration(env);
  } catch (err) {
    console.error(JSON.stringify({ event: 'chunk_generation_failed', error: String(err) }));
    chunkGenResult = { event: 'chunk_generation_skipped', reason: String(err) };
    // Continue — independent step
  }

  const result: GardenerRunResult = {
    event: 'gardener_run_complete',
    similarity: simResult,
    tag_normalization: tagNormResult,
    chunk_generation: chunkGenResult,
    duration_ms: Date.now() - startTime,
  };

  console.log(JSON.stringify(result));

  // Check for errors in any phase
  const allErrors = [
    ...simResult.errors,
    ...('errors' in tagNormResult ? tagNormResult.errors : []),
    ...('errors' in chunkGenResult ? chunkGenResult.errors : []),
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

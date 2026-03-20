import type { SupabaseClient } from '@supabase/supabase-js';
import type OpenAI from 'openai';
import type { Config } from './config';
import type { ServiceCaptureResult } from './types';
import { embedText, buildEmbeddingInput } from './embed';
import { runCaptureAgent } from './capture';
import { getCaptureVoice, findRelatedNotes, fetchRecentFragments, insertNote, insertLinks, logEnrichments } from './db';

// Replace typographic double-quote variants with ASCII " (U+0022).
// Prevents the capture LLM from echoing these characters into JSON output
// where they break JSON.parse(). Applied to LLM input only — raw_input is stored verbatim.
const TYPOGRAPHIC_DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\uFF02]/g;
export function normalizeForLLM(text: string): string {
  return text.replace(TYPOGRAPHIC_DOUBLE_QUOTES, '"');
}

/**
 * Run the full capture pipeline: embed → find related → LLM → re-embed → insert → log.
 * Single source of truth — called by both the MCP capture_note tool and the CaptureService RPC entrypoint.
 */
export async function runCapturePipeline(
  rawInput: string,
  source: string,
  db: SupabaseClient,
  openai: OpenAI,
  config: Config,
  options?: { imageUrl?: string },
): Promise<ServiceCaptureResult> {
  // Step 1: embed raw text + fetch capture voice + fetch recent fragments in parallel
  const [rawEmbedding, captureVoice, recentFragments] = await Promise.all([
    embedText(openai, config, rawInput),
    getCaptureVoice(db),
    config.recentFragmentsCount > 0
      ? fetchRecentFragments(db, config.recentFragmentsCount, config.recentFragmentsWindowMinutes)
      : Promise.resolve([]),
  ]);

  // Step 2: find related notes using raw embedding
  const relatedNotes = await findRelatedNotes(db, rawEmbedding, config.matchThreshold);

  // Step 2.5: deduplicate recent fragments against related notes
  const relatedIds = new Set(relatedNotes.map(n => n.id));
  const dedupedRecent = recentFragments.filter(r => !relatedIds.has(r.id));

  // Step 3: run capture LLM (normalize input to prevent typographic quotes breaking JSON output)
  const capture = await runCaptureAgent(openai, config, normalizeForLLM(rawInput), relatedNotes, captureVoice, dedupedRecent);

  // Step 4: augmented embedding (fallback to raw on failure)
  let finalEmbedding = rawEmbedding;
  let embeddingType: 'augmented' | 'raw_fallback' = 'augmented';
  try {
    finalEmbedding = await embedText(openai, config, buildEmbeddingInput(capture.body, capture));
  } catch (embedErr) {
    console.warn(JSON.stringify({ event: 'augmented_embed_fallback', error: String(embedErr) }));
    embeddingType = 'raw_fallback';
  }

  // Step 5: insert note + links
  const noteId = await insertNote(db, capture, finalEmbedding, rawInput, source, options?.imageUrl);
  await insertLinks(db, noteId, capture.links);

  // Step 6: log enrichments
  await logEnrichments(db, noteId, [
    { enrichment_type: 'capture', model_used: config.captureModel },
    { enrichment_type: `embedding_${embeddingType}`, model_used: config.embedModel },
  ]);

  // Step 7: resolve link titles from relatedNotes (no extra DB query)
  const resolvedLinks = capture.links.map(l => {
    const matched = relatedNotes.find(n => n.id === l.to_id);
    return {
      to_id: l.to_id,
      to_title: matched?.title ?? '',
      link_type: l.link_type,
    };
  });

  return {
    id: noteId,
    title: capture.title,
    body: capture.body,
    tags: capture.tags,
    source_ref: capture.source_ref,
    corrections: capture.corrections,
    entities: [],
    links: resolvedLinks,
    source,
    image_url: options?.imageUrl ?? null,
  };
}

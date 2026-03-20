// scripts/retag-corpus.ts
// One-time re-tag of existing corpus using the improved tag-anchoring prompt (PR #192).
// Processes notes chronologically for warm-start — early notes bootstrap tag vocabulary.
//
// Usage:
//   npx tsx scripts/retag-corpus.ts                  # dry-run: show what would change
//   npx tsx scripts/retag-corpus.ts --write           # apply changes to database
//   npx tsx scripts/retag-corpus.ts --limit 5         # process only first 5 notes
//   npx tsx scripts/retag-corpus.ts --write --limit 5

import { readFileSync, existsSync } from 'fs';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import { runCaptureAgent } from '../mcp/src/capture';
import { embedText, buildEmbeddingInput } from '../mcp/src/embed';
import type { Config } from '../mcp/src/config';
import type { MatchedNote } from '../mcp/src/types';

// ── CLI flags ────────────────────────────────────────────────────────────────

const WRITE_MODE = process.argv.includes('--write');
const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx !== -1 ? parseInt(process.argv[limitIdx + 1] || '0', 10) : 0;

// ── Env loading ──────────────────────────────────────────────────────────────

function loadEnv(): Record<string, string> {
  const path = '.dev.vars';
  if (!existsSync(path)) {
    throw new Error('.dev.vars not found — run from project root');
  }
  const content = readFileSync(path, 'utf-8');
  const vars: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) continue;
    vars[trimmed.slice(0, eqIndex)] = trimmed.slice(eqIndex + 1);
  }
  return vars;
}

// ── Types ────────────────────────────────────────────────────────────────────

interface NoteForRetag {
  id: string;
  title: string;
  body: string;
  tags: string[];
  raw_input: string;
  source: string;
  created_at: string;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const env = loadEnv();

  const supabaseUrl = env['SUPABASE_URL'];
  const supabaseKey = env['SUPABASE_SERVICE_ROLE_KEY'];
  const openrouterKey = env['OPENROUTER_API_KEY'];

  if (!supabaseUrl || !supabaseKey || !openrouterKey) {
    console.error('Missing required env vars: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, OPENROUTER_API_KEY');
    process.exit(1);
  }

  const db = createClient(supabaseUrl, supabaseKey);
  const openai = new OpenAI({
    apiKey: openrouterKey,
    baseURL: 'https://openrouter.ai/api/v1',
    defaultHeaders: {
      'HTTP-Referer': 'https://github.com/freegyes/project-ContemPlace',
      'X-Title': 'ContemPlace',
    },
  });

  // Config compatible with runCaptureAgent — only captureModel and embedModel matter at runtime
  const config: Config = {
    mcpApiKey: '',
    openrouterApiKey: openrouterKey,
    supabaseUrl,
    supabaseServiceRoleKey: supabaseKey,
    captureModel: env['CAPTURE_MODEL'] || 'anthropic/claude-haiku-4-5',
    embedModel: env['EMBED_MODEL'] || 'openai/text-embedding-3-small',
    matchThreshold: parseFloat(env['MATCH_THRESHOLD'] || '0.60'),
    searchThreshold: 0.35,
    hardDeleteWindowMinutes: 11,
    recentFragmentsCount: 0,
    recentFragmentsWindowMinutes: 0,
  };

  console.log(`\n=== Corpus Re-Tag ${WRITE_MODE ? '(WRITE MODE)' : '(DRY RUN)'} ===`);
  console.log(`Model: ${config.captureModel}`);
  console.log(`Embed: ${config.embedModel}`);
  console.log(`Match threshold: ${config.matchThreshold}`);
  if (LIMIT > 0) console.log(`Limit: first ${LIMIT} notes`);
  console.log('');

  // Fetch capture voice once
  const captureVoice = await fetchCaptureVoice(db);

  // Fetch all active notes chronologically
  const { data: notes, error: notesErr } = await db
    .from('notes')
    .select('id, title, body, tags, raw_input, source, created_at')
    .is('archived_at', null)
    .order('created_at', { ascending: true });

  if (notesErr || !notes) {
    console.error('Failed to fetch notes:', notesErr?.message);
    process.exit(1);
  }

  let allNotes = notes as NoteForRetag[];
  if (LIMIT > 0) allNotes = allNotes.slice(0, LIMIT);

  console.log(`Notes to process: ${allNotes.length}\n`);

  // Stats
  let processed = 0;
  let changed = 0;
  let unchanged = 0;
  let errors = 0;

  for (const note of allNotes) {
    processed++;
    const progress = `[${processed}/${allNotes.length}]`;

    try {
      // Step 1: embed raw_input for finding related notes
      const rawEmbedding = await embedText(openai, config, note.raw_input);

      // Step 2: find related notes (fetch 6, filter self, keep 5)
      const { data: matchData } = await db.rpc('match_notes', {
        query_embedding: rawEmbedding,
        match_threshold: config.matchThreshold,
        match_count: 6,
        filter_source: null,
        filter_tags: null,
        search_text: null,
      });

      const relatedNotes = ((matchData as MatchedNote[]) ?? [])
        .filter(n => n.id !== note.id)
        .slice(0, 5);

      // Step 3: run capture LLM (same prompt as production, no recent fragments)
      const capture = await runCaptureAgent(
        openai, config, note.raw_input, relatedNotes, captureVoice, [],
      );

      // Step 4: compare tags
      const oldSorted = [...note.tags].sort();
      const newSorted = [...capture.tags].sort();
      const tagsChanged = JSON.stringify(oldSorted) !== JSON.stringify(newSorted);

      if (!tagsChanged) {
        unchanged++;
        console.log(`${progress} unchanged "${note.title.slice(0, 60)}"`);
        await sleep(100);
        continue;
      }

      changed++;

      // Show tag diff
      const removed = note.tags.filter(t => !capture.tags.includes(t));
      const added = capture.tags.filter(t => !note.tags.includes(t));
      const kept = note.tags.filter(t => capture.tags.includes(t));

      if (WRITE_MODE) {
        // Step 5: re-embed with new tags
        const augmentedInput = buildEmbeddingInput(note.body, capture);
        const newEmbedding = await embedText(openai, config, augmentedInput);

        // Step 6: update note (tags + embedding only — title/body/links untouched)
        const { error: updateErr } = await db
          .from('notes')
          .update({
            tags: capture.tags,
            embedding: newEmbedding,
            embedded_at: new Date().toISOString(),
          })
          .eq('id', note.id);

        if (updateErr) {
          console.error(`${progress} UPDATE FAILED "${note.title.slice(0, 60)}": ${updateErr.message}`);
          errors++;
          changed--;
          await sleep(1000);
          continue;
        }

        // Step 7: log enrichment
        await db.from('enrichment_log').insert([
          { note_id: note.id, enrichment_type: 'retag', model_used: config.captureModel },
          { note_id: note.id, enrichment_type: 'retag_embedding', model_used: config.embedModel },
        ]);

        console.log(`${progress} UPDATED "${note.title.slice(0, 60)}"`);
      } else {
        console.log(`${progress} WOULD CHANGE "${note.title.slice(0, 60)}"`);
      }

      if (kept.length > 0) console.log(`         kept: ${kept.join(', ')}`);
      if (removed.length > 0) console.log(`       - removed: ${removed.join(', ')}`);
      if (added.length > 0) console.log(`       + added: ${added.join(', ')}`);

      await sleep(200);

    } catch (err) {
      console.error(`${progress} ERROR "${note.title.slice(0, 60)}": ${err}`);
      errors++;
      await sleep(1000);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────

  console.log(`\n=== Summary ===`);
  console.log(`Processed: ${processed}`);
  console.log(`Changed:   ${changed} (${(100 * changed / Math.max(processed, 1)).toFixed(1)}%)`);
  console.log(`Unchanged: ${unchanged}`);
  console.log(`Errors:    ${errors}`);

  if (!WRITE_MODE && changed > 0) {
    console.log(`\nThis was a dry run. Re-run with --write to apply changes.`);
  }
  if (WRITE_MODE && changed > 0) {
    console.log(`\nRun npx tsx scripts/tag-quality-analysis.ts to measure improvement.`);
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const DEFAULT_CAPTURE_VOICE = `## Your capture style

**Title**: A claim or insight when one is present. If the input doesn't contain a claim, use a descriptive phrase.

**Body**: Use the user's own words. Every sentence must be traceable to the input. 1-3 sentences for short inputs. For longer inputs, use as many sentences as needed to preserve all actionable content - up to 8. Shorter is still better than padded.`;

async function fetchCaptureVoice(db: SupabaseClient): Promise<string> {
  const { data, error } = await db
    .from('capture_profiles')
    .select('capture_voice')
    .eq('name', 'default')
    .single();

  if (error || !data) {
    console.warn('Using default capture voice (DB fetch failed)');
    return DEFAULT_CAPTURE_VOICE;
  }
  return (data as { capture_voice: string }).capture_voice;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});

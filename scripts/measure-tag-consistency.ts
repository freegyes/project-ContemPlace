// READ-ONLY SCRIPT — never writes to the database.
// Measure tag consistency within burst capture sessions for issue #194.
// Evaluates whether recent temporal context (#123) and tag anchoring (#151)
// improve tag vocabulary consistency across temporally adjacent captures.
//
// Usage: npx tsx scripts/measure-tag-consistency.ts

import { readFileSync, existsSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

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

interface Note {
  id: string;
  title: string;
  tags: string[];
  source: string;
  created_at: string;
}

interface BurstSession {
  notes: Note[];
  start: Date;
  end: Date;
  source: string;
}

// ── Constants ────────────────────────────────────────────────────────────────

// Captures within this window are considered part of the same burst session.
const BURST_WINDOW_MINUTES = 30;

// Features deployed on this date — captures after this had recent-fragments
// context (#123) and tag anchoring (#151).
const DEPLOYMENT_DATE = '2026-03-19';

// ── Burst detection ──────────────────────────────────────────────────────────

function detectBursts(notes: Note[]): BurstSession[] {
  // Sort by created_at ascending
  const sorted = [...notes].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  const bursts: BurstSession[] = [];
  let currentBurst: Note[] = [];

  for (const note of sorted) {
    if (currentBurst.length === 0) {
      currentBurst.push(note);
      continue;
    }

    const lastTime = new Date(currentBurst[currentBurst.length - 1]!.created_at).getTime();
    const thisTime = new Date(note.created_at).getTime();
    const gapMinutes = (thisTime - lastTime) / (1000 * 60);

    if (gapMinutes <= BURST_WINDOW_MINUTES) {
      currentBurst.push(note);
    } else {
      if (currentBurst.length >= 2) {
        bursts.push({
          notes: currentBurst,
          start: new Date(currentBurst[0]!.created_at),
          end: new Date(currentBurst[currentBurst.length - 1]!.created_at),
          source: currentBurst[0]!.source,
        });
      }
      currentBurst = [note];
    }
  }

  // Flush final burst
  if (currentBurst.length >= 2) {
    bursts.push({
      notes: currentBurst,
      start: new Date(currentBurst[0]!.created_at),
      end: new Date(currentBurst[currentBurst.length - 1]!.created_at),
      source: currentBurst[0]!.source,
    });
  }

  return bursts;
}

// ── Synonym detection (heuristic) ────────────────────────────────────────────

// Generic words that frequently appear as tag components but don't indicate
// synonymy (e.g., "lamp-design" and "tool-design" share "design" but aren't synonyms).
const GENERIC_STEMS = new Set([
  'design', 'system', 'making', 'practice', 'capture', 'knowledge',
  'management', 'thinking', 'writing', 'process', 'building', 'testing',
  'workflow', 'creative', 'learning', 'personal', 'physical', 'custom',
  'digital', 'instrument', 'workshop', 'plotting', 'cutting', 'printing',
]);

function sharesStem(a: string, b: string): boolean {
  const wordsA = a.split('-').filter(w => w.length >= 4);
  const wordsB = b.split('-').filter(w => w.length >= 4);
  // Require a shared word that isn't a generic tag component
  return wordsA.some(w => wordsB.includes(w) && !GENERIC_STEMS.has(w));
}

function areLikelySynonyms(a: string, b: string): boolean {
  if (a === b) return false;
  // Only substring containment for short tags (one is a prefix/suffix of another)
  if (a.includes(b) || b.includes(a)) return true;
  return sharesStem(a, b);
}

// ── Metrics ──────────────────────────────────────────────────────────────────

interface BurstMetrics {
  burstCount: number;
  totalNotesInBursts: number;
  avgBurstSize: number;
  // Tag reuse: fraction of tags in burst notes (after the first) that appeared
  // in an earlier note within the same burst.
  tagReuseRate: number;
  tagReuseCount: number;
  tagNewCount: number;
  // Synonym introductions: within a burst, a new tag that's a likely synonym
  // of a tag already used in the burst.
  synonymIntroductions: number;
  synonymExamples: Array<{ existing: string; introduced: string; burst: string }>;
  // Per-burst breakdown
  perBurst: Array<{
    date: string;
    size: number;
    uniqueTags: number;
    reusedTags: number;
    newTags: number;
    synonyms: number;
  }>;
}

function computeBurstMetrics(bursts: BurstSession[]): BurstMetrics {
  let tagReuseCount = 0;
  let tagNewCount = 0;
  let synonymIntroductions = 0;
  const synonymExamples: BurstMetrics['synonymExamples'] = [];
  const perBurst: BurstMetrics['perBurst'] = [];

  for (const burst of bursts) {
    const seenTags = new Set<string>();
    let burstReused = 0;
    let burstNew = 0;
    let burstSynonyms = 0;

    for (let i = 0; i < burst.notes.length; i++) {
      const note = burst.notes[i]!;

      if (i === 0) {
        // First note in burst: all tags are "new" (baseline)
        for (const tag of note.tags) seenTags.add(tag);
        continue;
      }

      for (const tag of note.tags) {
        if (seenTags.has(tag)) {
          tagReuseCount++;
          burstReused++;
        } else {
          tagNewCount++;
          burstNew++;

          // Check if this new tag is a synonym of something already seen
          for (const existing of seenTags) {
            if (areLikelySynonyms(tag, existing)) {
              synonymIntroductions++;
              burstSynonyms++;
              if (synonymExamples.length < 20) {
                synonymExamples.push({
                  existing,
                  introduced: tag,
                  burst: `${burst.start.toISOString().slice(0, 16)} (${burst.notes.length} notes)`,
                });
              }
              break; // Count once per new tag
            }
          }
        }
        seenTags.add(tag);
      }
    }

    perBurst.push({
      date: burst.start.toISOString().slice(0, 16),
      size: burst.notes.length,
      uniqueTags: seenTags.size,
      reusedTags: burstReused,
      newTags: burstNew,
      synonyms: burstSynonyms,
    });
  }

  const totalTags = tagReuseCount + tagNewCount;

  return {
    burstCount: bursts.length,
    totalNotesInBursts: bursts.reduce((sum, b) => sum + b.notes.length, 0),
    avgBurstSize: bursts.length > 0
      ? bursts.reduce((sum, b) => sum + b.notes.length, 0) / bursts.length
      : 0,
    tagReuseRate: totalTags > 0 ? tagReuseCount / totalTags : 0,
    tagReuseCount,
    tagNewCount,
    synonymIntroductions,
    synonymExamples,
    perBurst,
  };
}

// ── Cross-burst baseline ─────────────────────────────────────────────────────

interface CrossBurstBaseline {
  // What fraction of a note's tags appeared in any other note across the corpus?
  globalTagReuseRate: number;
  // Average pairwise Jaccard between non-burst-adjacent notes
  avgJaccard: number;
}

function computeCrossBurstBaseline(notes: Note[]): CrossBurstBaseline {
  const globalTagFreq = new Map<string, number>();
  for (const note of notes) {
    for (const tag of note.tags) {
      globalTagFreq.set(tag, (globalTagFreq.get(tag) ?? 0) + 1);
    }
  }

  // A tag is "reused" if it appears on more than one note in the corpus
  let reusedSlots = 0;
  let totalSlots = 0;
  for (const note of notes) {
    for (const tag of note.tags) {
      totalSlots++;
      if ((globalTagFreq.get(tag) ?? 0) > 1) reusedSlots++;
    }
  }

  // Average pairwise Jaccard (sample if corpus is large)
  const maxPairs = 5000;
  let jaccardSum = 0;
  let jaccardCount = 0;
  const totalPossible = (notes.length * (notes.length - 1)) / 2;
  const sampleRate = totalPossible > maxPairs ? maxPairs / totalPossible : 1;

  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      if (sampleRate < 1 && Math.random() > sampleRate) continue;
      const a = new Set(notes[i]!.tags);
      const b = new Set(notes[j]!.tags);
      const intersection = [...a].filter(t => b.has(t)).length;
      const union = new Set([...a, ...b]).size;
      jaccardSum += union > 0 ? intersection / union : 0;
      jaccardCount++;
    }
  }

  return {
    globalTagReuseRate: totalSlots > 0 ? reusedSlots / totalSlots : 0,
    avgJaccard: jaccardCount > 0 ? jaccardSum / jaccardCount : 0,
  };
}

// ── Output ───────────────────────────────────────────────────────────────────

function printResults(
  allNotes: Note[],
  allBursts: BurstSession[],
  allMetrics: BurstMetrics,
  preBursts: BurstSession[],
  preMetrics: BurstMetrics,
  postBursts: BurstSession[],
  postMetrics: BurstMetrics,
  baseline: CrossBurstBaseline,
): void {
  console.log(`\n═══ Tag Consistency Measurement (issue #194) ═══`);
  console.log(`Date: ${new Date().toISOString().slice(0, 10)}`);
  console.log(`Corpus: ${allNotes.length} active notes`);
  console.log(`Burst window: ${BURST_WINDOW_MINUTES} minutes`);
  console.log(`Deployment date: ${DEPLOYMENT_DATE}`);

  // ── 1. Burst detection summary ──
  console.log(`\n── 1. Burst Detection ──`);
  console.log(`Total bursts: ${allBursts.length}`);
  console.log(`Notes in bursts: ${allMetrics.totalNotesInBursts} / ${allNotes.length} (${(100 * allMetrics.totalNotesInBursts / allNotes.length).toFixed(1)}%)`);
  console.log(`Average burst size: ${allMetrics.avgBurstSize.toFixed(1)} notes`);
  console.log(`Burst sizes: ${allBursts.map(b => b.notes.length).join(', ')}`);

  // ── 2. Overall burst tag metrics ──
  console.log(`\n── 2. Within-Burst Tag Consistency ──`);
  console.log(`Tag reuse rate (within bursts): ${(100 * allMetrics.tagReuseRate).toFixed(1)}%`);
  console.log(`  Reused tags: ${allMetrics.tagReuseCount}`);
  console.log(`  New tags: ${allMetrics.tagNewCount}`);
  console.log(`Synonym introductions: ${allMetrics.synonymIntroductions}`);

  if (allMetrics.synonymExamples.length > 0) {
    console.log(`\nSynonym examples (existing → introduced):`);
    for (const ex of allMetrics.synonymExamples) {
      console.log(`  "${ex.existing}" → "${ex.introduced}" in burst ${ex.burst}`);
    }
  }

  // ── 3. Cross-burst baseline ──
  console.log(`\n── 3. Cross-Burst Baseline ──`);
  console.log(`Global tag reuse rate: ${(100 * baseline.globalTagReuseRate).toFixed(1)}% of tag slots use a tag that appears on >1 note`);
  console.log(`Average pairwise Jaccard: ${baseline.avgJaccard.toFixed(4)}`);
  console.log(`\nComparison: within-burst reuse ${(100 * allMetrics.tagReuseRate).toFixed(1)}% vs global reuse ${(100 * baseline.globalTagReuseRate).toFixed(1)}%`);

  // ── 4. Pre vs post deployment ──
  console.log(`\n── 4. Pre vs Post Deployment (${DEPLOYMENT_DATE}) ──`);

  const preNoteCount = preBursts.reduce((sum, b) => sum + b.notes.length, 0);
  const postNoteCount = postBursts.reduce((sum, b) => sum + b.notes.length, 0);

  console.log(`\n  PRE-deployment:`);
  console.log(`    Bursts: ${preBursts.length}, notes in bursts: ${preNoteCount}`);
  console.log(`    Tag reuse rate: ${(100 * preMetrics.tagReuseRate).toFixed(1)}%`);
  console.log(`    Synonym introductions: ${preMetrics.synonymIntroductions}`);

  console.log(`\n  POST-deployment:`);
  console.log(`    Bursts: ${postBursts.length}, notes in bursts: ${postNoteCount}`);
  console.log(`    Tag reuse rate: ${(100 * postMetrics.tagReuseRate).toFixed(1)}%`);
  console.log(`    Synonym introductions: ${postMetrics.synonymIntroductions}`);

  if (postBursts.length === 0) {
    console.log(`\n  ⚠ No post-deployment bursts yet. Re-run after 50+ new captures.`);
  } else {
    const delta = postMetrics.tagReuseRate - preMetrics.tagReuseRate;
    console.log(`\n  Delta: ${delta > 0 ? '+' : ''}${(100 * delta).toFixed(1)} percentage points`);
  }

  // ── 5. Per-burst breakdown ──
  console.log(`\n── 5. Per-Burst Breakdown ──`);
  console.log(`${'Date'.padEnd(18)} ${'Size'.padStart(4)} ${'Unique'.padStart(6)} ${'Reused'.padStart(6)} ${'New'.padStart(5)} ${'Syn'.padStart(4)}`);
  for (const b of allMetrics.perBurst) {
    const marker = b.date >= DEPLOYMENT_DATE ? ' *' : '';
    console.log(
      `${b.date.padEnd(18)} ${String(b.size).padStart(4)} ${String(b.uniqueTags).padStart(6)} ${String(b.reusedTags).padStart(6)} ${String(b.newTags).padStart(5)} ${String(b.synonyms).padStart(4)}${marker}`,
    );
  }
  console.log(`\n  * = post-deployment`);

  // ── 6. Tag vocabulary drift within bursts ──
  console.log(`\n── 6. Tag Vocabulary Within Bursts ──`);
  for (const burst of allBursts.slice(0, 10)) {
    const dateStr = burst.start.toISOString().slice(0, 16);
    console.log(`\n  Burst ${dateStr} (${burst.notes.length} notes):`);
    for (const note of burst.notes) {
      console.log(`    "${note.title.slice(0, 50)}" → [${note.tags.join(', ')}]`);
    }
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const env = loadEnv();
  const supabaseUrl = env['SUPABASE_URL'];
  const serviceRoleKey = env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in .dev.vars');
  }

  const db = createClient(supabaseUrl, serviceRoleKey);

  // Fetch all active notes
  const { data: notes, error } = await db
    .from('notes')
    .select('id, title, tags, source, created_at')
    .is('archived_at', null)
    .order('created_at', { ascending: true });

  if (error || !notes) {
    console.error('Failed to fetch notes:', error?.message);
    return;
  }

  const allNotes = notes as Note[];
  console.log(`Fetched ${allNotes.length} active notes`);

  // Detect all bursts
  const allBursts = detectBursts(allNotes);
  const allMetrics = computeBurstMetrics(allBursts);

  // Split pre/post deployment
  const deploymentTime = new Date(DEPLOYMENT_DATE).getTime();

  const preBursts = allBursts.filter(b => b.end.getTime() < deploymentTime);
  const postBursts = allBursts.filter(b => b.start.getTime() >= deploymentTime);
  // Bursts that straddle the deployment date are excluded from both groups

  const preMetrics = computeBurstMetrics(preBursts);
  const postMetrics = computeBurstMetrics(postBursts);

  // Cross-burst baseline
  const baseline = computeCrossBurstBaseline(allNotes);

  printResults(allNotes, allBursts, allMetrics, preBursts, preMetrics, postBursts, postMetrics, baseline);
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

// READ-ONLY SCRIPT — never writes to the database.
// Threshold analysis for issue #158: empirical data for gardener + capture threshold tuning.
//
// Usage: npx tsx scripts/threshold-analysis.ts
//
// Reads credentials from .dev.vars at runtime. Never logs secrets.

import { readFileSync, existsSync } from 'fs';
import { createClient } from '@supabase/supabase-js';

// ── Env loading (secrets stay in-process, never logged) ─────────────────────

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

// ── Types ───────────────────────────────────────────────────────────────────

interface Note {
  id: string;
  title: string;
  tags: string[];
  source: string;
  embedding: number[];
  created_at: string;
}

interface MatchResult {
  id: string;
  title: string;
  similarity: number;
  source: string;
}

// ── Math ────────────────────────────────────────────────────────────────────

function cosineSimilarity(a: number[], b: number[]): number {
  // text-embedding-3-small produces L2-normalized vectors, so cosine = dot product
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

// ── Data fetching (read-only) ───────────────────────────────────────────────

async function fetchNotes(supabaseUrl: string, serviceRoleKey: string): Promise<Note[]> {
  const db = createClient(supabaseUrl, serviceRoleKey);
  const { data, error } = await db
    .from('notes')
    .select('id, title, tags, source, embedding, created_at')
    .is('archived_at', null)
    .not('embedding', 'is', null);

  if (error) throw new Error(`Failed to fetch notes: ${error.message}`);

  return ((data as Array<{
    id: string;
    title: string;
    tags: string[] | null;
    source: string;
    embedding: number[] | string;
    created_at: string;
  }>) ?? []).map(row => ({
    id: row.id,
    title: row.title,
    tags: row.tags ?? [],
    source: row.source,
    embedding: typeof row.embedding === 'string'
      ? (JSON.parse(row.embedding) as number[])
      : row.embedding,
    created_at: row.created_at,
  }));
}

async function callMatchNotes(
  supabaseUrl: string,
  serviceRoleKey: string,
  embedding: number[],
  threshold: number,
  count: number,
): Promise<MatchResult[]> {
  const db = createClient(supabaseUrl, serviceRoleKey);
  const { data, error } = await db.rpc('match_notes', {
    query_embedding: embedding,
    match_threshold: threshold,
    match_count: count,
    filter_source: null,
    filter_tags: null,
    search_text: null,
  });

  if (error) throw new Error(`match_notes RPC failed: ${error.message}`);

  return ((data as Array<{ id: string; title: string; similarity: number; source: string }>) ?? [])
    .map(r => ({ id: r.id, title: r.title, similarity: r.similarity, source: r.source }));
}

// ── Formatting ──────────────────────────────────────────────────────────────

function printHeader(text: string): void {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(` ${text}`);
  console.log('═'.repeat(60));
}

function printSubheader(text: string): void {
  console.log(`\n── ${text} ${'─'.repeat(Math.max(0, 55 - text.length))}`);
}

// ── Section 1: Pairwise cosine distribution histogram ───────────────────────

function printPairwiseHistogram(notes: Note[]): void {
  printHeader('1. Pairwise Cosine Distribution');

  // Buckets from 0.30 to 1.00 at 0.05 intervals
  const bucketMin = 0.30;
  const bucketStep = 0.05;
  const bucketCount = Math.round((1.00 - bucketMin) / bucketStep); // 14 buckets
  const buckets = new Array<number>(bucketCount).fill(0);
  let belowFloor = 0;
  let totalPairs = 0;
  let totalSim = 0;
  let minSim = 1;
  let maxSim = 0;

  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const sim = cosineSimilarity(notes[i]!.embedding, notes[j]!.embedding);
      totalPairs++;
      totalSim += sim;
      if (sim < minSim) minSim = sim;
      if (sim > maxSim) maxSim = sim;

      if (sim < bucketMin) {
        belowFloor++;
        continue;
      }

      const bucketIdx = Math.min(
        Math.floor((sim - bucketMin) / bucketStep),
        bucketCount - 1,
      );
      buckets[bucketIdx]++;
    }
  }

  console.log(`Notes: ${notes.length}  |  Total pairs: ${totalPairs}`);
  console.log(`Mean: ${(totalSim / totalPairs).toFixed(4)}  |  Min: ${minSim.toFixed(4)}  |  Max: ${maxSim.toFixed(4)}`);
  console.log(`\nPairs below ${bucketMin.toFixed(2)}: ${belowFloor}`);
  console.log('');

  // Find max bucket for scaling
  const maxBucket = Math.max(...buckets);
  const barMaxWidth = 40;

  // Cumulative from top (pairs at or above each threshold)
  let cumAbove = 0;
  const cumAboveBuckets: number[] = [];
  for (let i = bucketCount - 1; i >= 0; i--) {
    cumAbove += buckets[i]!;
    cumAboveBuckets[i] = cumAbove;
  }

  console.log('  Range       Count   Bar                                       Pairs ≥ lower');
  for (let i = 0; i < bucketCount; i++) {
    const lo = bucketMin + i * bucketStep;
    const hi = lo + bucketStep;
    const count = buckets[i]!;
    const barLen = maxBucket > 0 ? Math.round((count / maxBucket) * barMaxWidth) : 0;
    const bar = '█'.repeat(barLen);
    const label = `${lo.toFixed(2)}–${hi.toFixed(2)}`;
    console.log(`  ${label}  ${String(count).padStart(6)}  ${bar.padEnd(barMaxWidth)}  ${cumAboveBuckets[i]}`);
  }

  // Threshold implications
  printSubheader('Threshold implications');
  for (const t of [0.55, 0.60, 0.65, 0.70, 0.75]) {
    const bucketIdx = Math.round((t - bucketMin) / bucketStep);
    let pairsAbove = 0;
    for (let i = bucketIdx; i < bucketCount; i++) pairsAbove += buckets[i]!;
    const pct = ((pairsAbove / totalPairs) * 100).toFixed(2);
    console.log(`  ≥ ${t.toFixed(2)}: ${String(pairsAbove).padStart(6)} pairs (${pct}% of all pairs)`);
  }
}

// ── Section 2: Gardener threshold sweep ─────────────────────────────────────

function printGardenerSweep(notes: Note[]): void {
  printHeader('2. Gardener Threshold Sweep');

  const noteMap = new Map(notes.map(n => [n.id, n]));
  const thresholds = [0.60, 0.65, 0.70];

  // Collect all pairs above lowest threshold
  const pairs: Array<{ a: string; b: string; sim: number }> = [];
  for (let i = 0; i < notes.length; i++) {
    for (let j = i + 1; j < notes.length; j++) {
      const sim = cosineSimilarity(notes[i]!.embedding, notes[j]!.embedding);
      if (sim >= thresholds[0]!) {
        pairs.push({ a: notes[i]!.id, b: notes[j]!.id, sim });
      }
    }
  }

  pairs.sort((a, b) => b.sim - a.sim);

  for (const threshold of thresholds) {
    const candidates = pairs.filter(p => p.sim >= threshold);
    printSubheader(`Threshold ${threshold.toFixed(2)} → ${candidates.length} link candidates`);

    // Show sample pairs from different bands
    const nextThreshold = thresholds[thresholds.indexOf(threshold) + 1];
    const bandPairs = nextThreshold
      ? pairs.filter(p => p.sim >= threshold && p.sim < nextThreshold)
      : pairs.filter(p => p.sim >= threshold);

    const bandLabel = nextThreshold
      ? `${threshold.toFixed(2)}–${nextThreshold.toFixed(2)}`
      : `≥ ${threshold.toFixed(2)}`;

    console.log(`  Band ${bandLabel}: ${bandPairs.length} pairs`);
    console.log('  Sample pairs:');

    // Show up to 5 from this band
    const samples = bandPairs.slice(0, 5);
    for (const p of samples) {
      const noteA = noteMap.get(p.a);
      const noteB = noteMap.get(p.b);
      console.log(`    ${p.sim.toFixed(4)}  "${noteA?.title}" ↔ "${noteB?.title}"`);
    }

    if (bandPairs.length > 5) {
      console.log(`    ... and ${bandPairs.length - 5} more in this band`);
    }
  }
}

// ── Section 3: Source-stratified breakdown ───────────────────────────────────

function printSourceStratified(notes: Note[]): void {
  printHeader('3. Source-Stratified Breakdown');

  // Group by source
  const bySource = new Map<string, Note[]>();
  for (const note of notes) {
    const src = note.source;
    if (!bySource.has(src)) bySource.set(src, []);
    bySource.get(src)!.push(note);
  }

  console.log('Source distribution:');
  for (const [src, srcNotes] of bySource) {
    console.log(`  ${src}: ${srcNotes.length} notes`);
  }

  // Compute mean pairwise cosine for each source combination
  const sources = [...bySource.keys()].sort();

  type PairStats = { sum: number; count: number; min: number; max: number };

  function newStats(): PairStats {
    return { sum: 0, count: 0, min: 1, max: 0 };
  }

  function addStat(stats: PairStats, val: number): void {
    stats.sum += val;
    stats.count++;
    if (val < stats.min) stats.min = val;
    if (val > stats.max) stats.max = val;
  }

  function fmtStats(stats: PairStats): string {
    if (stats.count === 0) return 'no pairs';
    const mean = stats.sum / stats.count;
    return `mean=${mean.toFixed(4)}, min=${stats.min.toFixed(4)}, max=${stats.max.toFixed(4)}, n=${stats.count}`;
  }

  // Within-source stats
  printSubheader('Within-source pairwise cosine');
  for (const src of sources) {
    const srcNotes = bySource.get(src)!;
    const stats = newStats();
    for (let i = 0; i < srcNotes.length; i++) {
      for (let j = i + 1; j < srcNotes.length; j++) {
        addStat(stats, cosineSimilarity(srcNotes[i]!.embedding, srcNotes[j]!.embedding));
      }
    }
    console.log(`  ${src} ↔ ${src}: ${fmtStats(stats)}`);

    // How many would be linked at each gardener threshold?
    for (const t of [0.60, 0.65, 0.70]) {
      let above = 0;
      for (let i = 0; i < srcNotes.length; i++) {
        for (let j = i + 1; j < srcNotes.length; j++) {
          if (cosineSimilarity(srcNotes[i]!.embedding, srcNotes[j]!.embedding) >= t) above++;
        }
      }
      console.log(`    ≥ ${t.toFixed(2)}: ${above} pairs`);
    }
  }

  // Cross-source stats
  if (sources.length > 1) {
    printSubheader('Cross-source pairwise cosine');
    for (let si = 0; si < sources.length; si++) {
      for (let sj = si + 1; sj < sources.length; sj++) {
        const srcA = sources[si]!;
        const srcB = sources[sj]!;
        const notesA = bySource.get(srcA)!;
        const notesB = bySource.get(srcB)!;
        const stats = newStats();
        for (const a of notesA) {
          for (const b of notesB) {
            addStat(stats, cosineSimilarity(a.embedding, b.embedding));
          }
        }
        console.log(`  ${srcA} ↔ ${srcB}: ${fmtStats(stats)}`);

        for (const t of [0.60, 0.65, 0.70]) {
          let above = 0;
          for (const a of notesA) {
            for (const b of notesB) {
              if (cosineSimilarity(a.embedding, b.embedding) >= t) above++;
            }
          }
          console.log(`    ≥ ${t.toFixed(2)}: ${above} pairs`);
        }
      }
    }
  }
}

// ── Section 4: Capture threshold comparison ─────────────────────────────────

async function printCaptureThresholdComparison(
  notes: Note[],
  supabaseUrl: string,
  serviceRoleKey: string,
): Promise<void> {
  printHeader('4. Capture Threshold Comparison (match_notes)');

  // Pick 10 most recent notes
  const sorted = [...notes].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
  );
  const recentNotes = sorted.slice(0, 10);

  const thresholds = [0.55, 0.60, 0.65];

  console.log(`Testing ${recentNotes.length} most recent notes against match_notes at thresholds: ${thresholds.join(', ')}`);

  for (const note of recentNotes) {
    printSubheader(`"${note.title}" (${note.source}, ${note.created_at.slice(0, 10)})`);

    for (const threshold of thresholds) {
      // match_notes returns candidates; exclude self
      const results = await callMatchNotes(
        supabaseUrl,
        serviceRoleKey,
        note.embedding,
        threshold,
        20, // fetch more to see what each threshold yields
      );

      const filtered = results.filter(r => r.id !== note.id);

      console.log(`  threshold ${threshold.toFixed(2)}: ${filtered.length} candidates`);
      for (const r of filtered.slice(0, 5)) {
        console.log(`    ${r.similarity.toFixed(4)}  "${r.title}" [${r.source}]`);
      }
      if (filtered.length > 5) {
        console.log(`    ... and ${filtered.length - 5} more`);
      }
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const env = loadEnv();
  const supabaseUrl = env['SUPABASE_URL'];
  const serviceRoleKey = env['SUPABASE_SERVICE_ROLE_KEY'];
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY required in .dev.vars');
  }

  // Fetch all active notes with embeddings
  const notes = await fetchNotes(supabaseUrl, serviceRoleKey);

  console.log(`\nThreshold Analysis (#158)`);
  console.log(`Date: ${new Date().toISOString().slice(0, 10)}`);
  console.log(`Notes: ${notes.length} active with embeddings`);

  // Sections 1–3 are computed locally from embeddings
  printPairwiseHistogram(notes);
  printGardenerSweep(notes);
  printSourceStratified(notes);

  // Section 4 uses match_notes RPC
  await printCaptureThresholdComparison(notes, supabaseUrl, serviceRoleKey);

  printHeader('Analysis Complete');
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});

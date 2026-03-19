// READ-ONLY SCRIPT — never writes to the database.
// Tag quality analysis for issue #151: quantify tag fragmentation,
// identify synonym groups, and measure tag consistency across related notes.
//
// Usage: npx tsx scripts/tag-quality-analysis.ts

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

interface Link {
  from_id: string;
  to_id: string;
  link_type: string;
  created_by: string;
}

// ── Analysis ─────────────────────────────────────────────────────────────────

async function main() {
  const env = loadEnv();
  const db = createClient(env['SUPABASE_URL']!, env['SUPABASE_SERVICE_ROLE_KEY']!);

  // Fetch all active notes with tags
  const { data: notes, error: notesErr } = await db
    .from('notes')
    .select('id, title, tags, source, created_at')
    .is('archived_at', null)
    .order('created_at', { ascending: true });

  if (notesErr || !notes) {
    console.error('Failed to fetch notes:', notesErr?.message);
    return;
  }

  // Fetch all links
  const { data: links, error: linksErr } = await db
    .from('links')
    .select('from_id, to_id, link_type, created_by');

  if (linksErr) {
    console.error('Failed to fetch links:', linksErr.message);
    return;
  }

  const allNotes = notes as Note[];
  const allLinks = (links ?? []) as Link[];
  const noteMap = new Map(allNotes.map(n => [n.id, n]));

  console.log(`\n═══ Tag Quality Analysis ═══`);
  console.log(`Corpus: ${allNotes.length} active notes\n`);

  // ── 1. Tag frequency distribution ──────────────────────────────────────

  const tagFreq = new Map<string, number>();
  const tagNotes = new Map<string, string[]>(); // tag → note IDs

  for (const note of allNotes) {
    for (const tag of note.tags) {
      tagFreq.set(tag, (tagFreq.get(tag) ?? 0) + 1);
      if (!tagNotes.has(tag)) tagNotes.set(tag, []);
      tagNotes.get(tag)!.push(note.id);
    }
  }

  const sortedTags = [...tagFreq.entries()].sort((a, b) => b[1] - a[1]);
  const uniqueCount = sortedTags.length;
  const singletonCount = sortedTags.filter(([, c]) => c === 1).length;
  const totalTagSlots = allNotes.reduce((sum, n) => sum + n.tags.length, 0);

  console.log(`── 1. Tag Frequency ──`);
  console.log(`Unique tags: ${uniqueCount}`);
  console.log(`Total tag slots: ${totalTagSlots}`);
  console.log(`Avg tags/note: ${(totalTagSlots / allNotes.length).toFixed(1)}`);
  console.log(`Singletons (appear once): ${singletonCount} (${(100 * singletonCount / uniqueCount).toFixed(1)}%)`);
  console.log(`\nTop 30 tags by frequency:`);
  for (const [tag, count] of sortedTags.slice(0, 30)) {
    console.log(`  ${tag}: ${count}`);
  }

  // ── 2. Tags per note distribution ──────────────────────────────────────

  const tagCountDist = new Map<number, number>();
  for (const note of allNotes) {
    const c = note.tags.length;
    tagCountDist.set(c, (tagCountDist.get(c) ?? 0) + 1);
  }

  console.log(`\n── 2. Tags Per Note ──`);
  for (const count of [...tagCountDist.keys()].sort((a, b) => a - b)) {
    console.log(`  ${count} tags: ${tagCountDist.get(count)} notes`);
  }

  // ── 3. Tag co-occurrence between linked notes ──────────────────────────

  // For capture-time links: do linked notes share tags?
  const captureLinks = allLinks.filter(l => l.created_by === 'capture');
  let linksWithSharedTags = 0;
  let totalSharedTags = 0;
  const sharedTagExamples: Array<{ from: string; to: string; shared: string[]; fromTags: string[]; toTags: string[] }> = [];

  for (const link of captureLinks) {
    const from = noteMap.get(link.from_id);
    const to = noteMap.get(link.to_id);
    if (!from || !to) continue;

    const shared = from.tags.filter(t => to.tags.includes(t));
    if (shared.length > 0) {
      linksWithSharedTags++;
      totalSharedTags += shared.length;
    }
    if (sharedTagExamples.length < 20) {
      sharedTagExamples.push({
        from: from.title.slice(0, 50),
        to: to.title.slice(0, 50),
        shared,
        fromTags: from.tags,
        toTags: to.tags,
      });
    }
  }

  console.log(`\n── 3. Tag Sharing in Capture-Time Links ──`);
  console.log(`Capture-time links: ${captureLinks.length}`);
  console.log(`Links with shared tags: ${linksWithSharedTags} (${(100 * linksWithSharedTags / Math.max(captureLinks.length, 1)).toFixed(1)}%)`);
  console.log(`\nSample linked pairs (tags):`);
  for (const ex of sharedTagExamples.slice(0, 10)) {
    const sharedStr = ex.shared.length > 0 ? `SHARED: [${ex.shared.join(', ')}]` : 'NO SHARED TAGS';
    console.log(`  "${ex.from}..." → "${ex.to}..."`);
    console.log(`    from: [${ex.fromTags.join(', ')}]`);
    console.log(`    to:   [${ex.toTags.join(', ')}]`);
    console.log(`    ${sharedStr}`);
  }

  // ── 4. Likely synonym groups ───────────────────────────────────────────

  // Simple heuristic: tags that share a stem or have edit distance ≤ 3
  console.log(`\n── 4. Likely Synonym Groups ──`);
  console.log(`(Tags sharing a stem or substring relationship)\n`);

  const tagList = sortedTags.map(([t]) => t);
  const synonymGroups: Array<{ canonical: string; variants: string[] }> = [];
  const claimed = new Set<string>();

  // Find groups by shared stem (longest common substring ≥ 5 chars)
  for (let i = 0; i < tagList.length; i++) {
    if (claimed.has(tagList[i]!)) continue;
    const group = [tagList[i]!];

    for (let j = i + 1; j < tagList.length; j++) {
      if (claimed.has(tagList[j]!)) continue;
      const a = tagList[i]!;
      const b = tagList[j]!;

      // Check if one contains the other, or they share a stem
      if (a.includes(b) || b.includes(a) || sharesStem(a, b)) {
        group.push(b);
      }
    }

    if (group.length > 1) {
      for (const t of group) claimed.add(t);
      synonymGroups.push({
        canonical: group[0]!,
        variants: group.slice(1),
      });
    }
  }

  for (const g of synonymGroups) {
    const allTags = [g.canonical, ...g.variants];
    const freqs = allTags.map(t => `${t}(${tagFreq.get(t) ?? 0})`);
    console.log(`  ${freqs.join(' / ')}`);
  }

  // ── 5. Source-stratified analysis ──────────────────────────────────────

  console.log(`\n── 5. Tags by Source ──`);
  const sourceGroups = new Map<string, Note[]>();
  for (const note of allNotes) {
    if (!sourceGroups.has(note.source)) sourceGroups.set(note.source, []);
    sourceGroups.get(note.source)!.push(note);
  }

  for (const [source, sourceNotes] of sourceGroups) {
    const sourceTags = new Map<string, number>();
    for (const note of sourceNotes) {
      for (const tag of note.tags) {
        sourceTags.set(tag, (sourceTags.get(tag) ?? 0) + 1);
      }
    }
    const sourceUnique = sourceTags.size;
    const sourceSingletons = [...sourceTags.values()].filter(c => c === 1).length;
    const sourceTotalSlots = sourceNotes.reduce((sum, n) => sum + n.tags.length, 0);
    console.log(`  ${source}: ${sourceNotes.length} notes, ${sourceUnique} unique tags, ${sourceSingletons} singletons (${(100 * sourceSingletons / Math.max(sourceUnique, 1)).toFixed(0)}%), avg ${(sourceTotalSlots / sourceNotes.length).toFixed(1)} tags/note`);
  }

  // ── 6. Pairwise tag Jaccard across all notes ───────────────────────────

  console.log(`\n── 6. Pairwise Tag Jaccard ──`);
  let pairsWithShared = 0;
  let totalPairs = 0;
  const jaccardBuckets = [0, 0, 0, 0, 0]; // 0, (0,0.1], (0.1,0.25], (0.25,0.5], (0.5,1]

  for (let i = 0; i < allNotes.length; i++) {
    for (let j = i + 1; j < allNotes.length; j++) {
      totalPairs++;
      const a = new Set(allNotes[i]!.tags);
      const b = new Set(allNotes[j]!.tags);
      const intersection = [...a].filter(t => b.has(t)).length;
      const union = new Set([...a, ...b]).size;
      const jaccard = union > 0 ? intersection / union : 0;

      if (jaccard === 0) jaccardBuckets[0]!++;
      else if (jaccard <= 0.1) { jaccardBuckets[1]!++; pairsWithShared++; }
      else if (jaccard <= 0.25) { jaccardBuckets[2]!++; pairsWithShared++; }
      else if (jaccard <= 0.5) { jaccardBuckets[3]!++; pairsWithShared++; }
      else { jaccardBuckets[4]!++; pairsWithShared++; }
    }
  }

  console.log(`  Total pairs: ${totalPairs}`);
  console.log(`  Pairs with any shared tag: ${pairsWithShared} (${(100 * pairsWithShared / totalPairs).toFixed(1)}%)`);
  console.log(`  Jaccard = 0:       ${jaccardBuckets[0]} (${(100 * jaccardBuckets[0]! / totalPairs).toFixed(1)}%)`);
  console.log(`  Jaccard (0, 0.1]:  ${jaccardBuckets[1]} (${(100 * jaccardBuckets[1]! / totalPairs).toFixed(1)}%)`);
  console.log(`  Jaccard (0.1,0.25]:${jaccardBuckets[2]} (${(100 * jaccardBuckets[2]! / totalPairs).toFixed(1)}%)`);
  console.log(`  Jaccard (0.25,0.5]:${jaccardBuckets[3]} (${(100 * jaccardBuckets[3]! / totalPairs).toFixed(1)}%)`);
  console.log(`  Jaccard (0.5, 1]:  ${jaccardBuckets[4]} (${(100 * jaccardBuckets[4]! / totalPairs).toFixed(1)}%)`);
}

function sharesStem(a: string, b: string): boolean {
  // Split on hyphens and check if they share ≥1 meaningful word (length ≥ 4)
  const wordsA = a.split('-').filter(w => w.length >= 4);
  const wordsB = b.split('-').filter(w => w.length >= 4);
  return wordsA.some(w => wordsB.includes(w));
}

main().catch(console.error);

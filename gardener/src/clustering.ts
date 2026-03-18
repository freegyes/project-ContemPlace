import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';
import type { NoteForSimilarity } from './types';

export interface ClusterRow {
  resolution: number;
  label: string;
  note_ids: string[];
  top_tags: string[];
  gravity: number;
  modularity: number | null;
}

export interface ClusteringResult {
  clusters_created: number;
  resolutions_run: number;
}

/**
 * Run multi-resolution Louvain clustering on the similarity graph.
 * Returns flat cluster rows ready for DB insertion.
 */
export function runClustering(
  notes: NoteForSimilarity[],
  pairs: Array<{ note_a: string; note_b: string; similarity: number }>,
  resolutions: number[],
): { rows: ClusterRow[]; result: ClusteringResult } {
  const graph = buildGraph(notes, pairs);

  if (graph.order === 0 || graph.size === 0) {
    return {
      rows: [],
      result: { clusters_created: 0, resolutions_run: 0 },
    };
  }

  const noteMap = new Map(notes.map(n => [n.id, n]));
  const allRows: ClusterRow[] = [];

  for (const resolution of resolutions) {
    const { communities, modularity } = louvain.detailed(graph, {
      resolution,
      getEdgeWeight: 'weight',
    });

    // Group by community
    const communityMap = new Map<number, string[]>();
    for (const [nodeId, communityId] of Object.entries(communities)) {
      const comm = communityId as number;
      if (!communityMap.has(comm)) communityMap.set(comm, []);
      communityMap.get(comm)!.push(nodeId);
    }

    // Build rows, skip singletons
    for (const [, memberIds] of communityMap) {
      if (memberIds.length < 2) continue;

      const topTags = computeTopTags(memberIds, noteMap, 3);
      const label = topTags.length > 0 ? topTags.join(' / ') : `Cluster (${memberIds.length} notes)`;
      const gravity = computeGravity(memberIds, graph, noteMap);

      allRows.push({
        resolution,
        label,
        note_ids: memberIds,
        top_tags: topTags,
        gravity,
        modularity,
      });
    }
  }

  return {
    rows: allRows,
    result: {
      clusters_created: allRows.length,
      resolutions_run: resolutions.length,
    },
  };
}

/**
 * Build an undirected Graphology graph from similarity pairs.
 * Edge weight = cosine similarity.
 */
function buildGraph(
  notes: NoteForSimilarity[],
  pairs: Array<{ note_a: string; note_b: string; similarity: number }>,
): Graph {
  const graph = new Graph({ type: 'undirected' });

  // Add all notes as nodes
  for (const note of notes) {
    graph.addNode(note.id);
  }

  // Add edges from similarity pairs
  for (const pair of pairs) {
    // Guard against nodes not in graph (shouldn't happen, but defensive)
    if (!graph.hasNode(pair.note_a) || !graph.hasNode(pair.note_b)) continue;
    // Guard against duplicate edges
    if (graph.hasEdge(pair.note_a, pair.note_b)) continue;
    graph.addEdge(pair.note_a, pair.note_b, { weight: pair.similarity });
  }

  return graph;
}

/**
 * Top-N most frequent tags across cluster members.
 */
function computeTopTags(
  memberIds: string[],
  noteMap: Map<string, NoteForSimilarity>,
  n: number,
): string[] {
  const tagCounts = new Map<string, number>();
  for (const id of memberIds) {
    const note = noteMap.get(id);
    if (!note) continue;
    for (const tag of note.tags) {
      const t = tag.toLowerCase();
      tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
  }

  return [...tagCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([tag]) => tag);
}

/**
 * Gravity = size * avg(1 / (1 + age_days)).
 * Recency-weighted — biases toward clusters with recent activity.
 */
function computeGravity(
  memberIds: string[],
  graph: Graph,
  noteMap: Map<string, NoteForSimilarity>,
): number {
  const now = Date.now();
  let recencySum = 0;
  let count = 0;

  for (const id of memberIds) {
    const note = noteMap.get(id);
    if (!note) continue;
    const ageDays = Math.max(0, (now - new Date(note.created_at).getTime()) / (1000 * 60 * 60 * 24));
    recencySum += 1 / (1 + ageDays);
    count++;
  }

  if (count === 0) return 0;

  const avgRecency = recencySum / count;
  return parseFloat((memberIds.length * avgRecency).toFixed(4));
}

import { describe, it, expect } from 'vitest';
import { runClustering, type ClusterRow } from '../gardener/src/clustering';
import type { NoteForSimilarity } from '../gardener/src/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeNote(id: string, tags: string[] = [], daysAgo: number = 0): NoteForSimilarity {
  const date = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return { id, title: `Note ${id}`, tags, created_at: date.toISOString() };
}

type Pair = { note_a: string; note_b: string; similarity: number };

function makePair(a: string, b: string, similarity: number): Pair {
  return { note_a: a, note_b: b, similarity };
}

// ── runClustering ────────────────────────────────────────────────────────────

describe('runClustering', () => {
  it('returns empty when no notes', () => {
    const { rows, result } = runClustering([], [], [1.0]);
    expect(rows).toHaveLength(0);
    expect(result.clusters_created).toBe(0);
    expect(result.resolutions_run).toBe(0);
  });

  it('returns empty when no pairs (no edges)', () => {
    const notes = [makeNote('a'), makeNote('b'), makeNote('c')];
    const { rows, result } = runClustering(notes, [], [1.0]);
    expect(rows).toHaveLength(0);
    expect(result.clusters_created).toBe(0);
  });

  it('skips singletons', () => {
    // Create a pair that connects a-b but leaves c isolated
    const notes = [makeNote('a'), makeNote('b'), makeNote('c')];
    const pairs = [makePair('a', 'b', 0.80)];
    const { rows } = runClustering(notes, pairs, [1.0]);

    // c should not appear in any cluster
    const allNoteIds = rows.flatMap(r => r.note_ids);
    expect(allNoteIds).not.toContain('c');
  });

  it('creates clusters for connected components', () => {
    const notes = [
      makeNote('a', ['cooking']),
      makeNote('b', ['cooking']),
      makeNote('c', ['music']),
      makeNote('d', ['music']),
    ];
    const pairs = [
      makePair('a', 'b', 0.90),
      makePair('c', 'd', 0.85),
    ];
    const { rows, result } = runClustering(notes, pairs, [1.0]);

    expect(result.clusters_created).toBeGreaterThanOrEqual(2);
    expect(result.resolutions_run).toBe(1);

    // Each cluster should have exactly 2 members
    for (const row of rows) {
      expect(row.note_ids.length).toBe(2);
    }
  });

  it('runs at multiple resolutions', () => {
    const notes = [
      makeNote('a', ['cooking']),
      makeNote('b', ['cooking']),
      makeNote('c', ['cooking']),
    ];
    const pairs = [
      makePair('a', 'b', 0.90),
      makePair('b', 'c', 0.85),
      makePair('a', 'c', 0.80),
    ];
    const resolutions = [1.0, 1.5, 2.0];
    const { result } = runClustering(notes, pairs, resolutions);

    expect(result.resolutions_run).toBe(3);
  });

  it('computes top_tags from member tags', () => {
    const notes = [
      makeNote('a', ['cooking', 'italian']),
      makeNote('b', ['cooking', 'pasta']),
      makeNote('c', ['cooking', 'italian']),
    ];
    const pairs = [
      makePair('a', 'b', 0.90),
      makePair('b', 'c', 0.85),
      makePair('a', 'c', 0.80),
    ];
    const { rows } = runClustering(notes, pairs, [1.0]);

    // All 3 notes should be in one cluster
    expect(rows.length).toBeGreaterThanOrEqual(1);
    const cluster = rows[0]!;
    // 'cooking' appears 3 times, should be first
    expect(cluster.top_tags[0]).toBe('cooking');
    // top_tags should have at most 3 entries
    expect(cluster.top_tags.length).toBeLessThanOrEqual(3);
  });

  it('uses label from top_tags when available', () => {
    const notes = [
      makeNote('a', ['ai', 'ml']),
      makeNote('b', ['ai', 'ml']),
    ];
    const pairs = [makePair('a', 'b', 0.90)];
    const { rows } = runClustering(notes, pairs, [1.0]);

    expect(rows.length).toBe(1);
    expect(rows[0]!.label).toBe('ai / ml');
  });

  it('uses fallback label when no tags', () => {
    const notes = [makeNote('a'), makeNote('b')];
    const pairs = [makePair('a', 'b', 0.90)];
    const { rows } = runClustering(notes, pairs, [1.0]);

    expect(rows.length).toBe(1);
    expect(rows[0]!.label).toMatch(/Cluster \(\d+ notes\)/);
  });

  it('computes gravity as a positive number', () => {
    const notes = [
      makeNote('a', [], 0),  // today
      makeNote('b', [], 30), // 30 days ago
    ];
    const pairs = [makePair('a', 'b', 0.90)];
    const { rows } = runClustering(notes, pairs, [1.0]);

    expect(rows.length).toBe(1);
    expect(rows[0]!.gravity).toBeGreaterThan(0);
  });

  it('gives higher gravity to clusters with recent notes', () => {
    // Cluster 1: recent notes
    const recentNotes = [
      makeNote('r1', ['recent'], 0),
      makeNote('r2', ['recent'], 1),
    ];
    // Cluster 2: old notes
    const oldNotes = [
      makeNote('o1', ['old'], 100),
      makeNote('o2', ['old'], 200),
    ];
    const notes = [...recentNotes, ...oldNotes];
    const pairs = [
      makePair('r1', 'r2', 0.90),
      makePair('o1', 'o2', 0.90),
    ];
    const { rows } = runClustering(notes, pairs, [1.0]);

    expect(rows.length).toBe(2);
    // Sort by gravity descending
    const sorted = [...rows].sort((a, b) => b.gravity - a.gravity);
    // The cluster with recent notes should have higher gravity
    expect(sorted[0]!.note_ids).toContain('r1');
  });

  it('includes modularity in each cluster row', () => {
    const notes = [makeNote('a'), makeNote('b')];
    const pairs = [makePair('a', 'b', 0.90)];
    const { rows } = runClustering(notes, pairs, [1.0]);

    expect(rows.length).toBe(1);
    expect(rows[0]!.modularity).not.toBeNull();
    expect(typeof rows[0]!.modularity).toBe('number');
  });

  it('handles duplicate pairs defensively', () => {
    const notes = [makeNote('a'), makeNote('b')];
    const pairs = [
      makePair('a', 'b', 0.90),
      makePair('a', 'b', 0.85), // duplicate pair
    ];
    // Should not throw
    const { rows } = runClustering(notes, pairs, [1.0]);
    expect(rows.length).toBeGreaterThanOrEqual(0);
  });

  it('tag counting is case-insensitive', () => {
    const notes = [
      makeNote('a', ['Cooking', 'PASTA']),
      makeNote('b', ['cooking', 'pasta']),
    ];
    const pairs = [makePair('a', 'b', 0.90)];
    const { rows } = runClustering(notes, pairs, [1.0]);

    expect(rows.length).toBe(1);
    // 'cooking' should appear as top tag (both variants counted together)
    expect(rows[0]!.top_tags[0]).toBe('cooking');
  });
});

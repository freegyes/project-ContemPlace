import { describe, it, expect } from 'vitest';
import { buildClusterTitlePrompt, parseClusterTitleResponse } from '../gardener/src/cluster-titles';
import type { ClusterRow } from '../gardener/src/clustering';
import type { NoteForSimilarity } from '../gardener/src/types';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeNote(id: string, title: string, tags: string[] = []): NoteForSimilarity {
  return { id, title, tags, created_at: new Date().toISOString() };
}

function makeCluster(noteIds: string[], topTags: string[] = [], label?: string): ClusterRow {
  return {
    resolution: 1.0,
    label: label ?? (topTags.join(' / ') || `Cluster (${noteIds.length} notes)`),
    note_ids: noteIds,
    top_tags: topTags,
    gravity: 1.0,
    modularity: 0.5,
  };
}

// ── parseClusterTitleResponse ────────────────────────────────────────────────

describe('parseClusterTitleResponse', () => {
  it('parses valid JSON object with string keys', () => {
    const raw = '{"0": "Making instruments with digital fabrication", "1": "Personal knowledge management philosophy"}';
    const result = parseClusterTitleResponse(raw, 2);
    expect(result.size).toBe(2);
    expect(result.get(0)).toBe('Making instruments with digital fabrication');
    expect(result.get(1)).toBe('Personal knowledge management philosophy');
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n{"0": "Cluster title here"}\n```';
    const result = parseClusterTitleResponse(raw, 1);
    expect(result.get(0)).toBe('Cluster title here');
  });

  it('returns empty map for invalid JSON', () => {
    const result = parseClusterTitleResponse('not json at all', 2);
    expect(result.size).toBe(0);
  });

  it('returns empty map for array instead of object', () => {
    const result = parseClusterTitleResponse('[{"title": "foo"}]', 2);
    expect(result.size).toBe(0);
  });

  it('skips indices out of range', () => {
    const raw = '{"0": "Valid", "5": "Out of range", "-1": "Negative"}';
    const result = parseClusterTitleResponse(raw, 2);
    expect(result.size).toBe(1);
    expect(result.get(0)).toBe('Valid');
  });

  it('skips entries with empty string values', () => {
    const raw = '{"0": "Valid", "1": ""}';
    const result = parseClusterTitleResponse(raw, 2);
    expect(result.size).toBe(1);
    expect(result.get(0)).toBe('Valid');
  });

  it('skips entries with non-string values', () => {
    const raw = '{"0": "Valid", "1": 42, "2": null}';
    const result = parseClusterTitleResponse(raw, 3);
    expect(result.size).toBe(1);
    expect(result.get(0)).toBe('Valid');
  });

  it('handles partial results (some clusters missing)', () => {
    const raw = '{"0": "First cluster title"}';
    const result = parseClusterTitleResponse(raw, 3);
    expect(result.size).toBe(1);
    expect(result.has(1)).toBe(false);
    expect(result.has(2)).toBe(false);
  });

  it('trims whitespace from titles', () => {
    const raw = '{"0": "  Title with spaces  "}';
    const result = parseClusterTitleResponse(raw, 1);
    expect(result.get(0)).toBe('Title with spaces');
  });
});

// ── buildClusterTitlePrompt ──────────────────────────────────────────────────

describe('buildClusterTitlePrompt', () => {
  it('includes cluster titles grouped by cluster index', () => {
    const notes = [
      makeNote('a', 'Build a lap steel guitar'),
      makeNote('b', 'Laser-cut plywood instruments'),
      makeNote('c', 'Note-taking philosophy'),
    ];
    const noteMap = new Map(notes.map(n => [n.id, n]));
    const rows = [
      makeCluster(['a', 'b'], ['laser-cutting', 'instrument-design']),
      makeCluster(['c'], ['note-taking']),
    ];

    const prompt = buildClusterTitlePrompt(rows, noteMap);

    expect(prompt).toContain('Cluster 0');
    expect(prompt).toContain('Cluster 1');
    expect(prompt).toContain('Build a lap steel guitar');
    expect(prompt).toContain('Laser-cut plywood instruments');
    expect(prompt).toContain('Note-taking philosophy');
  });

  it('includes top_tags as context', () => {
    const notes = [makeNote('a', 'Test note')];
    const noteMap = new Map(notes.map(n => [n.id, n]));
    const rows = [makeCluster(['a'], ['cooking', 'italian'])];

    const prompt = buildClusterTitlePrompt(rows, noteMap);

    expect(prompt).toContain('tags: cooking, italian');
  });

  it('includes note count', () => {
    const notes = [makeNote('a', 'Note A'), makeNote('b', 'Note B')];
    const noteMap = new Map(notes.map(n => [n.id, n]));
    const rows = [makeCluster(['a', 'b'], ['test'])];

    const prompt = buildClusterTitlePrompt(rows, noteMap);

    expect(prompt).toContain('2 notes');
  });

  it('handles clusters with no tags', () => {
    const notes = [makeNote('a', 'Orphan note')];
    const noteMap = new Map(notes.map(n => [n.id, n]));
    const rows = [makeCluster(['a'], [])];

    const prompt = buildClusterTitlePrompt(rows, noteMap);

    expect(prompt).toContain('Cluster 0');
    expect(prompt).not.toContain('tags:');
  });

  it('skips notes not found in noteMap', () => {
    const notes = [makeNote('a', 'Found note')];
    const noteMap = new Map(notes.map(n => [n.id, n]));
    const rows = [makeCluster(['a', 'missing-id'], ['test'])];

    const prompt = buildClusterTitlePrompt(rows, noteMap);

    expect(prompt).toContain('Found note');
    expect(prompt).not.toContain('missing-id');
  });
});

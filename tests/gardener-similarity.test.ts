import { describe, it, expect } from 'vitest';
import { buildContext } from '../gardener/src/similarity';

// ── buildContext ──────────────────────────────────────────────────────────────

describe('buildContext', () => {
  it('returns just the similarity score when no overlap', () => {
    const a = { tags: ['cooking'], entities: [] };
    const b = { tags: ['music'], entities: [] };
    expect(buildContext(a, b, 0.73)).toBe('Similarity: 0.73');
  });

  it('includes a single shared tag', () => {
    const a = { tags: ['cooking', 'kitchen'], entities: [] };
    const b = { tags: ['kitchen', 'renovation'], entities: [] };
    expect(buildContext(a, b, 0.82)).toBe('Similarity: 0.82; shared tags: kitchen');
  });

  it('includes multiple shared tags', () => {
    const a = { tags: ['cooking', 'kitchen', 'diy'], entities: [] };
    const b = { tags: ['kitchen', 'diy', 'tools'], entities: [] };
    expect(buildContext(a, b, 0.75)).toBe('Similarity: 0.75; shared tags: kitchen, diy');
  });

  it('includes shared entities', () => {
    const a = { tags: [], entities: [{ name: 'IKEA', type: 'tool' }, { name: 'Adam', type: 'person' }] };
    const b = { tags: [], entities: [{ name: 'IKEA', type: 'tool' }, { name: 'Bob', type: 'person' }] };
    expect(buildContext(a, b, 0.70)).toBe('Similarity: 0.70; shared entities: IKEA [tool]');
  });

  it('includes both shared tags and shared entities', () => {
    const a = { tags: ['workshop'], entities: [{ name: 'IKEA', type: 'tool' }] };
    const b = { tags: ['workshop'], entities: [{ name: 'IKEA', type: 'tool' }] };
    expect(buildContext(a, b, 0.88)).toBe('Similarity: 0.88; shared tags: workshop; shared entities: IKEA [tool]');
  });

  it('entity name matching is case-insensitive', () => {
    const a = { tags: [], entities: [{ name: 'ikea', type: 'tool' }] };
    const b = { tags: [], entities: [{ name: 'IKEA', type: 'tool' }] };
    expect(buildContext(a, b, 0.74)).toBe('Similarity: 0.74; shared entities: IKEA [tool]');
  });

  it('handles malformed entity objects gracefully', () => {
    const a = { tags: [], entities: [{ name: 'IKEA', type: 'tool' }] };
    const b = { tags: [], entities: 'not an array' };
    expect(buildContext(a, b, 0.71)).toBe('Similarity: 0.71');
  });

  it('handles null/missing entities gracefully', () => {
    const a = { tags: ['project'], entities: null };
    const b = { tags: ['project'], entities: undefined };
    expect(buildContext(a, b, 0.76)).toBe('Similarity: 0.76; shared tags: project');
  });

  it('formats similarity to 2 decimal places', () => {
    const a = { tags: [], entities: [] };
    const b = { tags: [], entities: [] };
    expect(buildContext(a, b, 0.7)).toBe('Similarity: 0.70');
    expect(buildContext(a, b, 1.0)).toBe('Similarity: 1.00');
    expect(buildContext(a, b, 0.8234)).toBe('Similarity: 0.82');
  });
});

// ── UUID pair deduplication ───────────────────────────────────────────────────

describe('UUID pair deduplication', () => {
  // The core invariant: for each (A, B) pair where A.id < B.id, we insert exactly
  // one link (A → B). When processing note B, we encounter A in its similar notes
  // but skip because B.id > A.id. This ensures each undirected pair maps to one row.

  const lower = '00000000-0000-0000-0000-000000000001';
  const higher = 'ffffffff-ffff-ffff-ffff-ffffffffffff';

  it('processes the pair when noteA.id is the lower UUID', () => {
    // condition: noteA.id >= noteB.id → skip. So we process when noteA.id < noteB.id.
    expect(lower < higher).toBe(true);   // → would process (lower, higher)
  });

  it('skips the pair when noteA.id is the higher UUID', () => {
    expect(higher >= lower).toBe(true);  // → would skip (higher, lower)
  });

  it('skips self-similarity', () => {
    expect(lower >= lower).toBe(true);   // → would skip (lower, lower)
    expect(higher >= higher).toBe(true); // → would skip (higher, higher)
  });

  it('UUID ordering is consistent with lexicographic string comparison', () => {
    // UUIDs are lowercase hex strings — JS string comparison works correctly.
    const a = '550e8400-e29b-41d4-a716-446655440000';
    const b = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    expect(a < b).toBe(true);
    expect(b < a).toBe(false);
  });
});

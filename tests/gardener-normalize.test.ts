import { describe, it, expect } from 'vitest';
import {
  buildConceptEmbeddingInput,
  lexicalMatch,
  cosineSimilarity,
  semanticMatch,
  resolveNoteTags,
} from '../gardener/src/normalize';
import type { Concept, NoteForTagNorm } from '../gardener/src/types';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeConcept(overrides: Partial<Concept> & { pref_label: string }): Concept {
  return {
    id: overrides.id ?? `id-${overrides.pref_label}`,
    scheme: overrides.scheme ?? 'domains',
    pref_label: overrides.pref_label,
    alt_labels: overrides.alt_labels ?? [],
    definition: overrides.definition ?? null,
    embedding: overrides.embedding ?? null,
  };
}

const BOOKBINDING = makeConcept({
  pref_label: 'bookbinding',
  alt_labels: ['book binding', 'bookmaking', 'hand binding', 'book arts'],
  definition: 'Constructing and binding books by hand.',
});

const LASER_CUTTING = makeConcept({
  pref_label: 'laser-cutting',
  alt_labels: ['laser-cut', 'laser engraving', 'lasercutting'],
  definition: 'Cutting and engraving materials with a laser cutter.',
});

const SYNTHESIZER = makeConcept({
  pref_label: 'synthesizer',
  alt_labels: ['synth', 'eurorack', 'modular synth'],
  definition: 'Electronic sound synthesis.',
});

const ALL_CONCEPTS = [BOOKBINDING, LASER_CUTTING, SYNTHESIZER];

// ── buildConceptEmbeddingInput ────────────────────────────────────────────────

describe('buildConceptEmbeddingInput', () => {
  it('formats pref_label + definition', () => {
    expect(buildConceptEmbeddingInput(BOOKBINDING)).toBe(
      'bookbinding: Constructing and binding books by hand.',
    );
  });

  it('returns just pref_label when definition is null', () => {
    const concept = makeConcept({ pref_label: 'test-concept', definition: null });
    expect(buildConceptEmbeddingInput(concept)).toBe('test-concept');
  });
});

// ── lexicalMatch ──────────────────────────────────────────────────────────────

describe('lexicalMatch', () => {
  it('matches exact pref_label', () => {
    expect(lexicalMatch('bookbinding', ALL_CONCEPTS)).toBe(BOOKBINDING);
  });

  it('matches pref_label case-insensitively', () => {
    expect(lexicalMatch('Bookbinding', ALL_CONCEPTS)).toBe(BOOKBINDING);
    expect(lexicalMatch('LASER-CUTTING', ALL_CONCEPTS)).toBe(LASER_CUTTING);
  });

  it('matches alt_labels', () => {
    expect(lexicalMatch('book binding', ALL_CONCEPTS)).toBe(BOOKBINDING);
    expect(lexicalMatch('lasercutting', ALL_CONCEPTS)).toBe(LASER_CUTTING);
  });

  it('matches alt_labels case-insensitively', () => {
    expect(lexicalMatch('Eurorack', ALL_CONCEPTS)).toBe(SYNTHESIZER);
    expect(lexicalMatch('BOOK ARTS', ALL_CONCEPTS)).toBe(BOOKBINDING);
  });

  it('returns null for no match', () => {
    expect(lexicalMatch('quantum-physics', ALL_CONCEPTS)).toBeNull();
    expect(lexicalMatch('', ALL_CONCEPTS)).toBeNull();
  });

  it('returns null for empty concepts', () => {
    expect(lexicalMatch('bookbinding', [])).toBeNull();
  });
});

// ── cosineSimilarity ──────────────────────────────────────────────────────────

describe('cosineSimilarity', () => {
  it('returns 1.0 for identical vectors', () => {
    const v = [1, 2, 3];
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 5);
  });

  it('returns 0.0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0, 5);
  });

  it('returns -1.0 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0, 5);
  });

  it('returns 0.0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });

  it('handles empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });
});

// ── semanticMatch ─────────────────────────────────────────────────────────────

describe('semanticMatch', () => {
  const concepts = [
    { concept: BOOKBINDING, embedding: [1, 0, 0] },
    { concept: LASER_CUTTING, embedding: [0, 1, 0] },
    { concept: SYNTHESIZER, embedding: [0, 0, 1] },
  ];

  it('returns the best-matching concept above threshold', () => {
    // Vector close to bookbinding
    const tagEmb = [0.9, 0.1, 0.0];
    expect(semanticMatch(tagEmb, concepts, 0.5)).toBe(BOOKBINDING);
  });

  it('returns null when no concept exceeds threshold', () => {
    // Equally split vector — all similarities ~0.577
    const tagEmb = [1, 1, 1];
    expect(semanticMatch(tagEmb, concepts, 0.9)).toBeNull();
  });

  it('returns null for empty concepts', () => {
    expect(semanticMatch([1, 0], [], 0.5)).toBeNull();
  });

  it('picks the highest-scoring concept', () => {
    // Slightly closer to laser-cutting than bookbinding
    const tagEmb = [0.3, 0.9, 0.1];
    expect(semanticMatch(tagEmb, concepts, 0.3)).toBe(LASER_CUTTING);
  });
});

// ── resolveNoteTags ───────────────────────────────────────────────────────────

describe('resolveNoteTags', () => {
  const conceptsWithEmbeddings = [
    { concept: BOOKBINDING, embedding: [1, 0, 0] },
    { concept: LASER_CUTTING, embedding: [0, 1, 0] },
  ];

  it('resolves lexical matches', () => {
    const note: NoteForTagNorm = { id: 'n1', tags: ['bookbinding', 'laser-cut'] };
    const { matched, unmatched } = resolveNoteTags(
      note, ALL_CONCEPTS, conceptsWithEmbeddings, new Map(), 0.5,
    );
    expect(matched).toHaveLength(2);
    expect(matched.map(m => m.prefLabel)).toContain('bookbinding');
    expect(matched.map(m => m.prefLabel)).toContain('laser-cutting');
    expect(unmatched).toHaveLength(0);
  });

  it('falls back to semantic matching when lexical fails', () => {
    const note: NoteForTagNorm = { id: 'n1', tags: ['hand-bookbinding'] };
    const tagEmbs = new Map([['hand-bookbinding', [0.95, 0.05, 0.0]]]);
    const { matched, unmatched } = resolveNoteTags(
      note, ALL_CONCEPTS, conceptsWithEmbeddings, tagEmbs, 0.5,
    );
    expect(matched).toHaveLength(1);
    expect(matched[0]!.prefLabel).toBe('bookbinding');
    expect(unmatched).toHaveLength(0);
  });

  it('reports unmatched tags', () => {
    const note: NoteForTagNorm = { id: 'n1', tags: ['quantum-physics'] };
    const { matched, unmatched } = resolveNoteTags(
      note, ALL_CONCEPTS, conceptsWithEmbeddings, new Map(), 0.5,
    );
    expect(matched).toHaveLength(0);
    expect(unmatched).toEqual(['quantum-physics']);
  });

  it('deduplicates matched concepts (two tags matching same concept)', () => {
    const note: NoteForTagNorm = { id: 'n1', tags: ['bookbinding', 'book arts'] };
    const { matched, unmatched } = resolveNoteTags(
      note, ALL_CONCEPTS, conceptsWithEmbeddings, new Map(), 0.5,
    );
    expect(matched).toHaveLength(1);
    expect(matched[0]!.prefLabel).toBe('bookbinding');
    expect(unmatched).toHaveLength(0);
  });

  it('handles empty tags', () => {
    const note: NoteForTagNorm = { id: 'n1', tags: [] };
    const { matched, unmatched } = resolveNoteTags(
      note, ALL_CONCEPTS, conceptsWithEmbeddings, new Map(), 0.5,
    );
    expect(matched).toHaveLength(0);
    expect(unmatched).toHaveLength(0);
  });

  it('handles mixed: some lexical, some semantic, some unmatched', () => {
    const note: NoteForTagNorm = { id: 'n1', tags: ['synth', 'hand-bookbinding', 'alien-topic'] };
    const tagEmbs = new Map([
      ['hand-bookbinding', [0.95, 0.05, 0.0]],
      ['alien-topic', [0.33, 0.33, 0.33]],
    ]);
    const { matched, unmatched } = resolveNoteTags(
      note, ALL_CONCEPTS, conceptsWithEmbeddings, tagEmbs, 0.8,
    );
    // 'synth' → lexical match to synthesizer
    // 'hand-bookbinding' → semantic match to bookbinding (cos > 0.8)
    // 'alien-topic' → below threshold → unmatched
    expect(matched.map(m => m.prefLabel).sort()).toEqual(['bookbinding', 'synthesizer']);
    expect(unmatched).toEqual(['alien-topic']);
  });
});

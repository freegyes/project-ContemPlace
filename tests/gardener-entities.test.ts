import { describe, it, expect } from 'vitest';
import { parseExtractionResponse, resolveEntities, mapNotesToCanonicalEntities } from '../gardener/src/entities';
import type { RawExtraction, DictionaryEntry } from '../gardener/src/types';

// ── parseExtractionResponse ──────────────────────────────────────────────────

describe('parseExtractionResponse', () => {
  it('parses a valid JSON array of entities', () => {
    const raw = '[{"name": "Nicolas Bras", "type": "person"}, {"name": "Shapr3D", "type": "tool"}]';
    const result = parseExtractionResponse(raw);
    expect(result).toEqual([
      { name: 'Nicolas Bras', type: 'person' },
      { name: 'Shapr3D', type: 'tool' },
    ]);
  });

  it('returns empty array for empty JSON array', () => {
    expect(parseExtractionResponse('[]')).toEqual([]);
  });

  it('strips markdown code fences', () => {
    const raw = '```json\n[{"name": "ContemPlace", "type": "project"}]\n```';
    expect(parseExtractionResponse(raw)).toEqual([
      { name: 'ContemPlace', type: 'project' },
    ]);
  });

  it('filters out entries with invalid types', () => {
    const raw = '[{"name": "Foo", "type": "concept"}, {"name": "Bar", "type": "person"}]';
    expect(parseExtractionResponse(raw)).toEqual([
      { name: 'Bar', type: 'person' },
    ]);
  });

  it('filters out entries with missing name', () => {
    const raw = '[{"type": "person"}, {"name": "Bar", "type": "tool"}]';
    expect(parseExtractionResponse(raw)).toEqual([
      { name: 'Bar', type: 'tool' },
    ]);
  });

  it('filters out entries with empty name', () => {
    const raw = '[{"name": "", "type": "person"}, {"name": "Bar", "type": "tool"}]';
    expect(parseExtractionResponse(raw)).toEqual([
      { name: 'Bar', type: 'tool' },
    ]);
  });

  it('filters out non-object array elements', () => {
    const raw = '["string", null, {"name": "Baz", "type": "place"}]';
    expect(parseExtractionResponse(raw)).toEqual([
      { name: 'Baz', type: 'place' },
    ]);
  });

  it('returns empty array for invalid JSON', () => {
    expect(parseExtractionResponse('not json')).toEqual([]);
  });

  it('returns empty array when response is a non-array JSON value', () => {
    expect(parseExtractionResponse('{"name": "Foo"}')).toEqual([]);
  });

  it('handles all four valid entity types', () => {
    const raw = JSON.stringify([
      { name: 'A', type: 'person' },
      { name: 'B', type: 'place' },
      { name: 'C', type: 'tool' },
      { name: 'D', type: 'project' },
    ]);
    expect(parseExtractionResponse(raw)).toHaveLength(4);
  });
});

// ── resolveEntities ──────────────────────────────────────────────────────────

describe('resolveEntities', () => {
  const noteCreatedAts = new Map([
    ['note-1', '2026-03-10T00:00:00Z'],
    ['note-2', '2026-03-12T00:00:00Z'],
    ['note-3', '2026-03-14T00:00:00Z'],
  ]);

  it('deduplicates entities by normalized name and type', () => {
    const extractions: RawExtraction[] = [
      { noteId: 'note-1', entities: [{ name: 'Nicolas Bras', type: 'person' }] },
      { noteId: 'note-2', entities: [{ name: 'Nicolas Bras', type: 'person' }] },
    ];

    const result = resolveEntities(extractions, noteCreatedAts);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Nicolas Bras');
    expect(result[0]!.note_count).toBe(2);
    expect(result[0]!.note_ids).toContain('note-1');
    expect(result[0]!.note_ids).toContain('note-2');
  });

  it('picks the most frequent surface form as canonical name', () => {
    const extractions: RawExtraction[] = [
      { noteId: 'note-1', entities: [{ name: 'shapr3d', type: 'tool' }] },
      { noteId: 'note-2', entities: [{ name: 'Shapr3D', type: 'tool' }] },
      { noteId: 'note-3', entities: [{ name: 'Shapr3D', type: 'tool' }] },
    ];

    const result = resolveEntities(extractions, noteCreatedAts);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Shapr3D');
    expect(result[0]!.aliases).toContain('shapr3d');
  });

  it('merges substring entities of the same type', () => {
    const extractions: RawExtraction[] = [
      { noteId: 'note-1', entities: [{ name: 'Rosenberg', type: 'person' }] },
      { noteId: 'note-2', entities: [{ name: 'Marshall Rosenberg', type: 'person' }] },
    ];

    const result = resolveEntities(extractions, noteCreatedAts);
    expect(result).toHaveLength(1);
    expect(result[0]!.name).toBe('Marshall Rosenberg');
    expect(result[0]!.aliases).toContain('Rosenberg');
    expect(result[0]!.note_count).toBe(2);
  });

  it('does not merge substring entities of different types', () => {
    const extractions: RawExtraction[] = [
      { noteId: 'note-1', entities: [{ name: 'Flow', type: 'tool' }] },
      { noteId: 'note-2', entities: [{ name: 'Wispr Flow', type: 'tool' }] },
      { noteId: 'note-3', entities: [{ name: 'Flow', type: 'place' }] },
    ];

    const result = resolveEntities(extractions, noteCreatedAts);
    // "Flow" [tool] merges into "Wispr Flow" [tool], but "Flow" [place] stays separate
    expect(result).toHaveLength(2);
    const wispr = result.find(e => e.name === 'Wispr Flow');
    const place = result.find(e => e.type === 'place');
    expect(wispr).toBeDefined();
    expect(wispr!.aliases).toContain('Flow');
    expect(place).toBeDefined();
  });

  it('sets first_seen and last_seen from note created_at timestamps', () => {
    const extractions: RawExtraction[] = [
      { noteId: 'note-1', entities: [{ name: 'Foo', type: 'tool' }] },
      { noteId: 'note-3', entities: [{ name: 'Foo', type: 'tool' }] },
    ];

    const result = resolveEntities(extractions, noteCreatedAts);
    expect(result[0]!.first_seen).toBe('2026-03-10T00:00:00Z');
    expect(result[0]!.last_seen).toBe('2026-03-14T00:00:00Z');
  });

  it('keeps entities separate when same name has different types', () => {
    const extractions: RawExtraction[] = [
      { noteId: 'note-1', entities: [{ name: 'Budapest', type: 'place' }] },
      { noteId: 'note-2', entities: [{ name: 'Budapest', type: 'project' }] },
    ];

    const result = resolveEntities(extractions, noteCreatedAts);
    expect(result).toHaveLength(2);
  });

  it('returns empty array for empty extractions', () => {
    expect(resolveEntities([], noteCreatedAts)).toEqual([]);
  });

  it('returns empty array when all notes have empty entity lists', () => {
    const extractions: RawExtraction[] = [
      { noteId: 'note-1', entities: [] },
      { noteId: 'note-2', entities: [] },
    ];
    expect(resolveEntities(extractions, noteCreatedAts)).toEqual([]);
  });

  it('sorts by note_count descending', () => {
    const extractions: RawExtraction[] = [
      { noteId: 'note-1', entities: [{ name: 'Rare', type: 'tool' }] },
      { noteId: 'note-1', entities: [{ name: 'Common', type: 'tool' }] },
      { noteId: 'note-2', entities: [{ name: 'Common', type: 'tool' }] },
      { noteId: 'note-3', entities: [{ name: 'Common', type: 'tool' }] },
    ];

    const result = resolveEntities(extractions, noteCreatedAts);
    expect(result[0]!.name).toBe('Common');
    expect(result[1]!.name).toBe('Rare');
  });

  it('does not merge short names under 3 characters', () => {
    const extractions: RawExtraction[] = [
      { noteId: 'note-1', entities: [{ name: 'AI', type: 'tool' }] },
      { noteId: 'note-2', entities: [{ name: 'AI Gateway', type: 'tool' }] },
    ];

    const result = resolveEntities(extractions, noteCreatedAts);
    expect(result).toHaveLength(2);
  });

  it('deduplicates aliases', () => {
    const extractions: RawExtraction[] = [
      { noteId: 'note-1', entities: [{ name: 'shapr3d', type: 'tool' }] },
      { noteId: 'note-2', entities: [{ name: 'shapr3d', type: 'tool' }] },
      { noteId: 'note-3', entities: [{ name: 'Shapr3D', type: 'tool' }] },
    ];

    const result = resolveEntities(extractions, noteCreatedAts);
    // shapr3d appears twice but should only be one alias
    const aliases = result[0]!.aliases;
    expect(new Set(aliases).size).toBe(aliases.length);
  });
});

// ── mapNotesToCanonicalEntities ──────────────────────────────────────────────

describe('mapNotesToCanonicalEntities', () => {
  const dictionary: DictionaryEntry[] = [
    {
      name: 'Marshall Rosenberg',
      type: 'person',
      aliases: ['Rosenberg'],
      note_count: 2,
      note_ids: ['note-1', 'note-2'],
      first_seen: '2026-03-10T00:00:00Z',
      last_seen: '2026-03-12T00:00:00Z',
    },
    {
      name: 'Shapr3D',
      type: 'tool',
      aliases: ['shapr3d'],
      note_count: 1,
      note_ids: ['note-3'],
      first_seen: '2026-03-14T00:00:00Z',
      last_seen: '2026-03-14T00:00:00Z',
    },
  ];

  it('maps raw extracted names to canonical forms', () => {
    const extractions: RawExtraction[] = [
      { noteId: 'note-1', entities: [{ name: 'Rosenberg', type: 'person' }] },
    ];

    const result = mapNotesToCanonicalEntities(extractions, dictionary);
    const note1Entities = result.get('note-1');
    expect(note1Entities).toEqual([{ name: 'Marshall Rosenberg', type: 'person' }]);
  });

  it('maps exact canonical names correctly', () => {
    const extractions: RawExtraction[] = [
      { noteId: 'note-2', entities: [{ name: 'Marshall Rosenberg', type: 'person' }] },
    ];

    const result = mapNotesToCanonicalEntities(extractions, dictionary);
    expect(result.get('note-2')).toEqual([{ name: 'Marshall Rosenberg', type: 'person' }]);
  });

  it('deduplicates entities within a single note', () => {
    const extractions: RawExtraction[] = [
      {
        noteId: 'note-1',
        entities: [
          { name: 'Rosenberg', type: 'person' },
          { name: 'Marshall Rosenberg', type: 'person' },
        ],
      },
    ];

    const result = mapNotesToCanonicalEntities(extractions, dictionary);
    expect(result.get('note-1')).toHaveLength(1);
    expect(result.get('note-1')![0]!.name).toBe('Marshall Rosenberg');
  });

  it('handles notes with no matching entities', () => {
    const extractions: RawExtraction[] = [
      { noteId: 'note-1', entities: [{ name: 'Unknown Person', type: 'person' }] },
    ];

    const result = mapNotesToCanonicalEntities(extractions, dictionary);
    expect(result.get('note-1')).toEqual([]);
  });

  it('handles multiple entities per note', () => {
    const extractions: RawExtraction[] = [
      {
        noteId: 'note-1',
        entities: [
          { name: 'Rosenberg', type: 'person' },
          { name: 'Shapr3D', type: 'tool' },
        ],
      },
    ];

    const result = mapNotesToCanonicalEntities(extractions, dictionary);
    const entities = result.get('note-1')!;
    expect(entities).toHaveLength(2);
    expect(entities.map(e => e.name)).toContain('Marshall Rosenberg');
    expect(entities.map(e => e.name)).toContain('Shapr3D');
  });
});

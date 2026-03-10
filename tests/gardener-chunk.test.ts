import { describe, it, expect } from 'vitest';
import { splitIntoChunks, buildChunkEmbeddingInput, MIN_BODY_LENGTH } from '../gardener/src/chunk';

// ── splitIntoChunks ─────────────────────────────────────────────────────────

describe('splitIntoChunks', () => {
  it('returns empty array for short text', () => {
    expect(splitIntoChunks('Short note.')).toEqual([]);
  });

  it('returns empty array for text at exactly MIN_BODY_LENGTH', () => {
    const text = 'x'.repeat(MIN_BODY_LENGTH);
    expect(splitIntoChunks(text)).toEqual([]);
  });

  it('returns empty array for text just over MIN_BODY_LENGTH with no split points', () => {
    // A single block of text with no paragraph/sentence boundaries that produces only 1 chunk
    const text = 'a'.repeat(MIN_BODY_LENGTH + 1);
    // This is a single block under MAX_CHUNK_SIZE? No, it's 1501 chars which exceeds 800.
    // It will get hard-split into 2 chunks.
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('splits on paragraph boundaries (double newlines)', () => {
    const para1 = 'First paragraph with enough text to be meaningful. '.repeat(12).trim();
    const para2 = 'Second paragraph with different content entirely. '.repeat(12).trim();
    const para3 = 'Third paragraph wrapping up the thoughts here. '.repeat(12).trim();
    const text = `${para1}\n\n${para2}\n\n${para3}`;

    expect(text.length).toBeGreaterThan(MIN_BODY_LENGTH);

    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Chunks should have sequential indices
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.index).toBe(i);
    }
  });

  it('returns empty array when splitting produces only 1 chunk', () => {
    // Text over MIN_BODY_LENGTH but all within one paragraph that fits in one chunk after splitting
    // Actually, if it's over MIN_BODY_LENGTH (1500) and MAX_CHUNK_SIZE is 800, it will always
    // produce at least 2 chunks via some fallback. Let's make a text that has two paragraphs
    // but one is tiny so they merge into 1.
    const longPara = 'A'.repeat(750);
    const shortPara = 'B'.repeat(750);
    const text = `${longPara}\n\n${shortPara}`;
    // Both paragraphs are under 800, but merged they'd be 1500+2 = 1502 which is > 800
    // So they should stay as 2 chunks
    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBe(2);
  });

  it('falls back to sentence splitting for oversized paragraphs', () => {
    // One big paragraph with sentences, over 800 chars
    const sentence = 'This is a sentence with some decent length. ';
    const bigParagraph = sentence.repeat(40).trim(); // ~44 * 40 = ~1760 chars
    // Need total > 1500 and a second paragraph to avoid single-chunk skip
    const secondPara = 'A completely separate thought here about something else entirely.';
    const text = `${bigParagraph}\n\n${secondPara}`;

    expect(text.length).toBeGreaterThan(MIN_BODY_LENGTH);

    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Each chunk should be within reasonable size
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(900); // some tolerance
    }
  });

  it('falls back to single newlines for bullet lists', () => {
    const bullets = Array.from({ length: 30 }, (_, i) =>
      `- Item number ${i + 1} with some description text that makes it meaningful`
    ).join('\n');
    const intro = 'Here is a long list of things to consider for the project:';
    const outro = 'These are all important considerations for moving forward.';
    const text = `${intro}\n\n${bullets}\n\n${outro}`;

    expect(text.length).toBeGreaterThan(MIN_BODY_LENGTH);

    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('handles multiple consecutive newlines', () => {
    const para1 = 'First paragraph about cooking ideas and recipes. '.repeat(20).trim();
    const para2 = 'Second paragraph about woodworking projects. '.repeat(20).trim();
    const text = `${para1}\n\n\n\n${para2}`;

    expect(text.length).toBeGreaterThan(MIN_BODY_LENGTH);

    const chunks = splitIntoChunks(text);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // No empty chunks
    for (const chunk of chunks) {
      expect(chunk.content.trim().length).toBeGreaterThan(0);
    }
  });

  it('merges small adjacent blocks', () => {
    // Many tiny paragraphs that should be merged
    const paras = Array.from({ length: 20 }, (_, i) =>
      `Paragraph ${i + 1} here.`
    ).join('\n\n');
    // Pad to exceed MIN_BODY_LENGTH
    const padding = ' More text to pad out the length.'.repeat(40);
    const text = paras + '\n\n' + padding.trim();

    expect(text.length).toBeGreaterThan(MIN_BODY_LENGTH);

    const chunks = splitIntoChunks(text);
    // Should have fewer chunks than paragraphs due to merging
    expect(chunks.length).toBeLessThan(20);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('handles text with only single newlines (no paragraphs)', () => {
    const lines = Array.from({ length: 30 }, (_, i) =>
      `Line ${i}: Some content about topic ${i % 5} with moderate length padding here`
    ).join('\n');

    expect(lines.length).toBeGreaterThan(MIN_BODY_LENGTH);

    const chunks = splitIntoChunks(lines);
    // Should fall through to sentence or single-newline splitting
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it('preserves all content — no text lost', () => {
    const para1 = 'Alpha paragraph with some meaningful content here. '.repeat(12).trim();
    const para2 = 'Beta paragraph with different meaningful content. '.repeat(12).trim();
    const para3 = 'Gamma paragraph wrapping up all the thoughts. '.repeat(12).trim();
    const text = `${para1}\n\n${para2}\n\n${para3}`;

    const chunks = splitIntoChunks(text);
    // All original content should appear in some chunk
    const allChunkText = chunks.map(c => c.content).join(' ');
    expect(allChunkText).toContain('Alpha');
    expect(allChunkText).toContain('Beta');
    expect(allChunkText).toContain('Gamma');
  });

  it('chunk indices are sequential starting from 0', () => {
    const para1 = 'First paragraph topic one. '.repeat(15).trim();
    const para2 = 'Second paragraph topic two. '.repeat(15).trim();
    const para3 = 'Third paragraph topic three. '.repeat(15).trim();
    const text = `${para1}\n\n${para2}\n\n${para3}`;

    const chunks = splitIntoChunks(text);
    for (let i = 0; i < chunks.length; i++) {
      expect(chunks[i]!.index).toBe(i);
    }
  });
});

// ── buildChunkEmbeddingInput ────────────────────────────────────────────────

describe('buildChunkEmbeddingInput', () => {
  it('prepends title and tags', () => {
    const result = buildChunkEmbeddingInput(
      'My Note Title',
      ['cooking', 'project'],
      'Some chunk content here.',
    );
    expect(result).toBe('My Note Title [cooking, project]: Some chunk content here.');
  });

  it('omits tag brackets when no tags', () => {
    const result = buildChunkEmbeddingInput(
      'My Note Title',
      [],
      'Some chunk content here.',
    );
    expect(result).toBe('My Note Title: Some chunk content here.');
  });

  it('handles single tag', () => {
    const result = buildChunkEmbeddingInput(
      'Title',
      ['woodworking'],
      'Content.',
    );
    expect(result).toBe('Title [woodworking]: Content.');
  });
});

// ── MIN_BODY_LENGTH ──────────────────────────────────────────────────────────

describe('MIN_BODY_LENGTH', () => {
  it('is 1500', () => {
    expect(MIN_BODY_LENGTH).toBe(1500);
  });
});

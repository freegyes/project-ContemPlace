import { describe, it, expect } from 'vitest';
import { buildEmbeddingInput } from '../mcp/src/embed';
import type { CaptureResult } from '../mcp/src/types';

const BASE_CAPTURE: CaptureResult = {
  title: 'Test Note',
  body: 'Test body.',
  type: 'idea',
  tags: ['tag1', 'tag2'],
  source_ref: null,
  links: [],
  corrections: null,
  intent: 'remember',
  modality: 'text',
  entities: [],
};

describe('buildEmbeddingInput (mcp/src/embed.ts)', () => {
  it('includes [Type:] prefix', () => {
    expect(buildEmbeddingInput('hello', BASE_CAPTURE)).toContain('[Type: idea]');
  });

  it('includes [Intent:] when intent is set', () => {
    expect(buildEmbeddingInput('hello', BASE_CAPTURE)).toContain('[Intent: remember]');
  });

  it('includes [Tags:] with comma-joined tags', () => {
    expect(buildEmbeddingInput('hello', BASE_CAPTURE)).toContain('[Tags: tag1, tag2]');
  });

  it('omits [Tags:] section when tags array is empty', () => {
    const result = buildEmbeddingInput('hello', { ...BASE_CAPTURE, tags: [] });
    expect(result).not.toContain('[Tags:');
  });

  it('appends the original text at the end', () => {
    const text = 'my raw input';
    expect(buildEmbeddingInput(text, BASE_CAPTURE).endsWith(text)).toBe(true);
  });

  it('produces the exact format: [Type] [Intent] [Tags] text', () => {
    const result = buildEmbeddingInput('the text', BASE_CAPTURE);
    expect(result).toBe('[Type: idea] [Intent: remember] [Tags: tag1, tag2] the text');
  });

  it('works with all type values', () => {
    for (const type of ['idea', 'reflection', 'source', 'lookup'] as const) {
      const result = buildEmbeddingInput('x', { ...BASE_CAPTURE, type });
      expect(result).toContain(`[Type: ${type}]`);
    }
  });
});

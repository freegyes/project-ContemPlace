import { describe, it, expect } from 'vitest';
import { parseCaptureResponse } from '../mcp/src/capture';
import { normalizeForLLM } from '../mcp/src/pipeline';

const VALID_BASE = {
  title: 'Test title',
  body: 'Test body.',
  tags: ['test'],
  source_ref: null,
  corrections: null,
  links: [],
};

function make(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...VALID_BASE, ...overrides });
}

describe('parseCaptureResponse', () => {
  it('parses valid complete JSON', () => {
    const result = parseCaptureResponse(make());
    expect(result.title).toBe('Test title');
  });

  it('strips markdown code fences', () => {
    const result = parseCaptureResponse('```json\n' + make() + '\n```');
    expect(result.title).toBe('Test title');
  });

  it('converts empty corrections array to null', () => {
    const result = parseCaptureResponse(make({ corrections: [] }));
    expect(result.corrections).toBeNull();
  });

  it('converts non-array corrections to null', () => {
    const result = parseCaptureResponse(make({ corrections: 'not an array' }));
    expect(result.corrections).toBeNull();
  });

  it('preserves valid corrections', () => {
    const result = parseCaptureResponse(make({ corrections: ['cattle → kettle'] }));
    expect(result.corrections).toEqual(['cattle → kettle']);
  });

  it('filters links with invalid link_type', () => {
    const result = parseCaptureResponse(make({
      links: [
        { to_id: '123', link_type: 'contradicts' },
        { to_id: '456', link_type: 'is-similar-to' },
      ],
    }));
    expect(result.links).toHaveLength(1);
    expect(result.links[0]!.link_type).toBe('contradicts');
  });

  it('accepts related link type', () => {
    const result = parseCaptureResponse(make({
      links: [
        { to_id: '123', link_type: 'related' },
        { to_id: '456', link_type: 'contradicts' },
      ],
    }));
    expect(result.links).toHaveLength(2);
    expect(result.links[0]!.link_type).toBe('related');
  });

  it('rejects old link types', () => {
    const result = parseCaptureResponse(make({
      links: [
        { to_id: '123', link_type: 'extends' },
        { to_id: '456', link_type: 'supports' },
        { to_id: '789', link_type: 'duplicate-of' },
      ],
    }));
    expect(result.links).toHaveLength(0);
  });

  it('throws on non-JSON string', () => {
    expect(() => parseCaptureResponse('not json')).toThrow('invalid JSON');
  });

  it('throws on missing required fields', () => {
    expect(() => parseCaptureResponse(JSON.stringify({ body: 'x' }))).toThrow('missing title');
  });
});

describe('normalizeForLLM', () => {
  it('replaces Hungarian low-high typographic quotes', () => {
    expect(normalizeForLLM('csinálj egy „most szól\u201D állványt')).toBe('csinálj egy "most szól" állványt');
  });

  it('replaces left/right double quotation marks', () => {
    expect(normalizeForLLM('\u201Chello\u201D')).toBe('"hello"');
  });

  it('replaces double high-reversed-9 quotation mark', () => {
    expect(normalizeForLLM('\u201Ftest\u201D')).toBe('"test"');
  });

  it('replaces full-width quotation mark', () => {
    expect(normalizeForLLM('\uFF02test\uFF02')).toBe('"test"');
  });

  it('leaves ASCII double quotes unchanged', () => {
    expect(normalizeForLLM('"already ascii"')).toBe('"already ascii"');
  });

  it('leaves text without quotes unchanged', () => {
    const input = 'no quotes here at all';
    expect(normalizeForLLM(input)).toBe(input);
  });

  it('handles mixed typographic and ASCII quotes', () => {
    expect(normalizeForLLM('he said \u201Chello\u201D and "goodbye"')).toBe('he said "hello" and "goodbye"');
  });

  it('preserves single quotes and apostrophes', () => {
    const input = "it\u2019s a test with \u2018single\u2019 quotes";
    expect(normalizeForLLM(input)).toBe(input);
  });
});

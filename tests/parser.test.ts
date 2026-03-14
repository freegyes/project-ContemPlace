import { describe, it, expect } from 'vitest';
import { parseCaptureResponse } from '../mcp/src/capture';

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
        { to_id: '123', link_type: 'extends' },
        { to_id: '456', link_type: 'is-similar-to' },
      ],
    }));
    expect(result.links).toHaveLength(1);
    expect(result.links[0]!.link_type).toBe('extends');
  });

  it('accepts duplicate-of link type', () => {
    const result = parseCaptureResponse(make({
      links: [
        { to_id: '123', link_type: 'duplicate-of' },
        { to_id: '456', link_type: 'extends' },
      ],
    }));
    expect(result.links).toHaveLength(2);
    expect(result.links[0]!.link_type).toBe('duplicate-of');
  });

  it('throws on non-JSON string', () => {
    expect(() => parseCaptureResponse('not json')).toThrow('invalid JSON');
  });

  it('throws on missing required fields', () => {
    expect(() => parseCaptureResponse(JSON.stringify({ body: 'x' }))).toThrow('missing title');
  });
});

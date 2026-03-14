import { describe, it, expect } from 'vitest';
import { parseCaptureResponse } from '../mcp/src/capture';

const VALID_BASE = {
  title: 'Test title',
  body: 'Test body.',
  tags: ['test'],
  source_ref: null,
  corrections: null,
  entities: [],
  links: [],
};

function make(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ...VALID_BASE, ...overrides });
}

describe('parseCaptureResponse', () => {
  it('parses valid complete JSON', () => {
    const result = parseCaptureResponse(make());
    expect(result.title).toBe('Test title');
    expect(result.entities).toEqual([]);
  });

  it('strips markdown code fences', () => {
    const result = parseCaptureResponse('```json\n' + make() + '\n```');
    expect(result.title).toBe('Test title');
  });

  it('filters entities with invalid types', () => {
    const result = parseCaptureResponse(make({
      entities: [
        { name: 'Claude', type: 'tool' },
        { name: 'Acme', type: 'organization' },
      ],
    }));
    expect(result.entities).toHaveLength(1);
    expect(result.entities[0]!.name).toBe('Claude');
  });

  it('filters entities with names exceeding 200 chars', () => {
    const result = parseCaptureResponse(make({
      entities: [{ name: 'x'.repeat(201), type: 'tool' }],
    }));
    expect(result.entities).toHaveLength(0);
  });

  it('filters entities missing name field', () => {
    const result = parseCaptureResponse(make({
      entities: [{ type: 'tool' }],
    }));
    expect(result.entities).toHaveLength(0);
  });

  it('handles empty entities array', () => {
    const result = parseCaptureResponse(make({ entities: [] }));
    expect(result.entities).toEqual([]);
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

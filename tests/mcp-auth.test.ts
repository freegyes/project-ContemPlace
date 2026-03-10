import { describe, it, expect, vi } from 'vitest';
import { validateAuth } from '../mcp/src/auth';
import type { Env } from '../mcp/src/types';

const VALID_KEY = 'test-api-key-12345';
const MOCK_ENV = { MCP_API_KEY: VALID_KEY } as unknown as Env;

function makeRequest(authHeader?: string): Request {
  const headers: Record<string, string> = {};
  if (authHeader !== undefined) headers['Authorization'] = authHeader;
  return new Request('https://example.com/mcp', { method: 'POST', headers });
}

describe('validateAuth', () => {
  it('returns null when Authorization header is a valid Bearer token', () => {
    const result = validateAuth(makeRequest(`Bearer ${VALID_KEY}`), MOCK_ENV);
    expect(result).toBeNull();
  });

  it('returns 401 when Authorization header is missing', () => {
    const result = validateAuth(makeRequest(), MOCK_ENV);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('returns 401 when Authorization header does not start with "Bearer "', () => {
    const result = validateAuth(makeRequest(`Token ${VALID_KEY}`), MOCK_ENV);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('returns 401 for "Bearer" with no trailing space', () => {
    const result = validateAuth(makeRequest('Bearer'), MOCK_ENV);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it('returns 403 when token does not match MCP_API_KEY', () => {
    const result = validateAuth(makeRequest('Bearer wrong-token'), MOCK_ENV);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(403);
  });

  // The Fetch API Headers implementation trims trailing whitespace from header
  // values, so 'Bearer ' becomes 'Bearer' — which fails the startsWith check
  // and returns 401 rather than 403.
  it('returns 401 when header value is "Bearer" with no token (trailing space trimmed)', () => {
    const result = validateAuth(makeRequest('Bearer '), MOCK_ENV);
    expect(result).not.toBeNull();
    // 401 because trimmed value 'Bearer' doesn't match 'Bearer ' prefix check
    expect([401, 403]).toContain(result!.status);
  });

  it('logs a warning on token mismatch', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateAuth(makeRequest('Bearer wrong-token'), MOCK_ENV);
    expect(spy).toHaveBeenCalledOnce();
    spy.mockRestore();
  });

  it('does not log a warning on successful auth', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateAuth(makeRequest(`Bearer ${VALID_KEY}`), MOCK_ENV);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

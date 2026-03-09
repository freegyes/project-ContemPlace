import type { Env } from './types';

export function validateAuth(request: Request, env: Env): Response | null {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 });
  }
  const token = authHeader.slice(7);
  if (token !== env.MCP_API_KEY) {
    console.warn(JSON.stringify({ event: 'auth_failed', reason: 'invalid_token' }));
    return new Response('Forbidden', { status: 403 });
  }
  return null;
}

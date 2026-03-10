import type { Env } from './types';

export function validateTriggerAuth(request: Request, env: Env): Response | null {
  if (!env.GARDENER_API_KEY) {
    return new Response('Trigger endpoint not configured', { status: 403 });
  }
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response('Unauthorized', { status: 401 });
  }
  const token = authHeader.slice(7);
  if (token !== env.GARDENER_API_KEY) {
    console.warn(JSON.stringify({ event: 'auth_failed', reason: 'invalid_token' }));
    return new Response('Forbidden', { status: 403 });
  }
  return null;
}

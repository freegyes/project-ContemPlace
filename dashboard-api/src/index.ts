import { loadConfig } from './config';
import { validateAuth } from './auth';
import { createSupabaseClient, fetchStats, fetchClusters, fetchClusterDetail, fetchRecent } from './db';
import { fetchBackupRecency } from './github';
import type { Env } from './types';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const config = loadConfig(env);
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 200, headers: corsHeaders(config.corsOrigin) });
    }

    // Auth gate (all routes)
    const authError = validateAuth(request, config.dashboardApiKey);
    if (authError) return withCors(authError, config.corsOrigin);

    // Method check
    if (request.method !== 'GET') {
      return withCors(new Response('Method Not Allowed', { status: 405 }), config.corsOrigin);
    }

    const db = createSupabaseClient(config);

    try {
      if (path === '/stats') {
        const stats = await fetchStats(db);
        const backupLastCommit = await fetchBackupRecency(config.backupRepo, config.githubBackupPat);
        return jsonResponse({ ...stats, backup_last_commit: backupLastCommit }, config.corsOrigin);
      }

      if (path === '/clusters') {
        const resolution = parseFloat(url.searchParams.get('resolution') ?? '1.0');
        if (isNaN(resolution)) return withCors(new Response('Invalid resolution', { status: 400 }), config.corsOrigin);
        const result = await fetchClusters(db, resolution);
        return jsonResponse({ resolution, ...result }, config.corsOrigin);
      }

      if (path === '/clusters/detail') {
        const idsParam = url.searchParams.get('note_ids') ?? '';
        const noteIds = idsParam.split(',').filter(Boolean);
        if (noteIds.length === 0) return withCors(new Response('note_ids required', { status: 400 }), config.corsOrigin);
        if (noteIds.length > 50) return withCors(new Response('Maximum 50 note_ids', { status: 400 }), config.corsOrigin);
        if (!noteIds.every(id => UUID_RE.test(id))) return withCors(new Response('Invalid UUID format', { status: 400 }), config.corsOrigin);
        const result = await fetchClusterDetail(db, noteIds);
        return jsonResponse(result, config.corsOrigin);
      }

      if (path === '/recent') {
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') ?? '15', 10) || 15, 1), 50);
        const notes = await fetchRecent(db, limit);
        return jsonResponse(notes, config.corsOrigin);
      }

      return withCors(new Response('Not Found', { status: 404 }), config.corsOrigin);
    } catch (err) {
      console.error(JSON.stringify({ event: 'dashboard_api_error', error: String(err), path }));
      return withCors(new Response('Internal Server Error', { status: 500 }), config.corsOrigin);
    }
  },
};

function corsHeaders(origin: string): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization',
    'Access-Control-Max-Age': '86400',
  };
}

function withCors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set('Access-Control-Allow-Origin', origin);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function jsonResponse(data: unknown, origin: string): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': origin },
  });
}

import type { AuthRequest, ClientInfo } from '@cloudflare/workers-oauth-provider';
import type { Env } from './types';

/** Single-user system — fixed user ID for all grants */
export const OWNER_USER_ID = 'owner';

/**
 * Render the consent page HTML.
 * Displays client name + redirect URI so the owner can verify before approving.
 */
export function renderConsentPage(
  authRequest: AuthRequest,
  clientInfo: ClientInfo | null,
): string {
  const clientName = escapeHtml(clientInfo?.clientName ?? 'Unknown client');
  const redirectUri = escapeHtml(authRequest.redirectUri);
  const scope = escapeHtml(authRequest.scope.join(' ') || 'mcp');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize — ContemPlace</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; max-width: 420px; margin: 60px auto; padding: 0 20px; color: #1a1a1a; background: #fafafa; }
    h1 { font-size: 1.3rem; margin-bottom: 0.5rem; }
    .client-name { font-weight: 600; }
    .redirect { font-family: monospace; font-size: 0.85rem; background: #e8e8e8; padding: 8px 12px; border-radius: 4px; word-break: break-all; margin: 12px 0; }
    .scope { color: #666; font-size: 0.9rem; margin-bottom: 20px; }
    button { background: #2563eb; color: white; border: none; padding: 12px 32px; border-radius: 6px; font-size: 1rem; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    .note { font-size: 0.8rem; color: #888; margin-top: 24px; }
  </style>
</head>
<body>
  <h1>Authorize access to ContemPlace?</h1>
  <p><span class="client-name">${clientName}</span> wants to connect.</p>
  <p class="scope">Scope: ${scope}</p>
  <p>Redirect URI:</p>
  <div class="redirect">${redirectUri}</div>
  <form method="POST">
    <input type="hidden" name="client_id" value="${escapeHtml(authRequest.clientId)}">
    <input type="hidden" name="redirect_uri" value="${escapeHtml(authRequest.redirectUri)}">
    <input type="hidden" name="state" value="${escapeHtml(authRequest.state)}">
    <input type="hidden" name="scope" value="${escapeHtml(authRequest.scope.join(' '))}">
    <input type="hidden" name="response_type" value="${escapeHtml(authRequest.responseType)}">
    ${authRequest.codeChallenge ? `<input type="hidden" name="code_challenge" value="${escapeHtml(authRequest.codeChallenge)}">` : ''}
    ${authRequest.codeChallengeMethod ? `<input type="hidden" name="code_challenge_method" value="${escapeHtml(authRequest.codeChallengeMethod)}">` : ''}
    ${authRequest.resource ? `<input type="hidden" name="resource" value="${escapeHtml(typeof authRequest.resource === 'string' ? authRequest.resource : authRequest.resource.join(' '))}">` : ''}
    <button type="submit">Approve</button>
  </form>
  <p class="note">Single-user system. If you are not the owner, close this page.</p>
</body>
</html>`;
}

/**
 * AuthHandler — ExportedHandler for the consent page.
 * Handles GET /authorize (render) and POST /authorize (complete).
 * All other routes return 404.
 */
export const AuthHandler: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname !== '/authorize') {
      return new Response('Not Found', { status: 404 });
    }

    const oauthHelpers = env.OAUTH_PROVIDER;
    if (!oauthHelpers) {
      console.error(JSON.stringify({ event: 'oauth_helpers_missing' }));
      return new Response('Internal Server Error', { status: 500 });
    }

    if (request.method === 'GET') {
      try {
        const authRequest = await oauthHelpers.parseAuthRequest(request);
        const clientInfo = await oauthHelpers.lookupClient(authRequest.clientId);
        const html = renderConsentPage(authRequest, clientInfo);
        return new Response(html, {
          status: 200,
          headers: { 'Content-Type': 'text/html; charset=utf-8' },
        });
      } catch (err) {
        console.error(JSON.stringify({ event: 'consent_page_error', error: String(err) }));
        return new Response('Bad Request', { status: 400 });
      }
    }

    if (request.method === 'POST') {
      try {
        const formData = await request.formData();

        const authRequest: AuthRequest = {
          clientId: formData.get('client_id') as string ?? '',
          redirectUri: formData.get('redirect_uri') as string ?? '',
          state: formData.get('state') as string ?? '',
          scope: (formData.get('scope') as string ?? 'mcp').split(' ').filter(Boolean),
          responseType: formData.get('response_type') as string ?? 'code',
          codeChallenge: (formData.get('code_challenge') as string) || undefined,
          codeChallengeMethod: (formData.get('code_challenge_method') as string) || undefined,
          resource: (formData.get('resource') as string) || undefined,
        };

        const { redirectTo } = await oauthHelpers.completeAuthorization({
          request: authRequest,
          userId: OWNER_USER_ID,
          metadata: { approvedAt: new Date().toISOString() },
          scope: authRequest.scope,
          props: { userId: OWNER_USER_ID },
        });

        return Response.redirect(redirectTo, 302);
      } catch (err) {
        console.error(JSON.stringify({ event: 'consent_submit_error', error: String(err) }));
        return new Response('Authorization failed', { status: 400 });
      }
    }

    return new Response('Method Not Allowed', { status: 405 });
  },
};

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

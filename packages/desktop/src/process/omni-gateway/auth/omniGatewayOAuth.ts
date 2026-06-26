/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * HTTP surface of the Omni External MCP Gateway OAuth 2.1 authorization server.
 *
 * Wires the pure {@link OmniOAuthStore} to the gateway host's request plane.
 * It mounts the standard endpoints an MCP connector (ChatGPT, Claude) probes:
 *
 *   GET  /.well-known/oauth-authorization-server   (RFC 8414 metadata)
 *   GET  /.well-known/oauth-protected-resource     (RFC 9728 resource metadata)
 *   POST /oauth/register                            (RFC 7591 Dynamic Client Reg)
 *   GET  /oauth/authorize                           (consent screen, PKCE S256)
 *   POST /oauth/authorize                           (consent decision → redirect)
 *   POST /oauth/token                               (code + refresh grants)
 *   POST /oauth/revoke                              (RFC 7009 token revocation)
 *
 * The consent screen is a minimal self-contained HTML page served over the
 * tunnel. Approving posts back here, we mint a single-use auth code, and 302
 * the browser to the client's `redirect_uri` with `?code=…&state=…`.
 *
 * Security notes:
 *  - PKCE S256 is mandatory; `plain` and missing challenges are rejected.
 *  - Auth codes are single-use and expire in ~60 s.
 *  - We never log token/secret/verifier/code values.
 *  - The `issuer` + endpoint URLs are derived from the public tunnel origin so
 *    discovery points clients at the reachable HTTPS host, not 127.0.0.1.
 *
 * Process boundary: Main-process (Node.js / Electron). No DOM APIs.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  OMNI_OAUTH_CODE_CHALLENGE_METHODS,
  OMNI_OAUTH_GRANT_TYPES,
  OMNI_OAUTH_RESPONSE_TYPES,
  type OmniOAuthStore,
} from './omniGatewayOAuthStore';

/** URL path prefix every OAuth endpoint (except discovery) lives under. */
export const OMNI_OAUTH_PREFIX = '/oauth';

/** RFC 8414 / RFC 9728 well-known discovery paths. */
export const OMNI_OAUTH_AS_METADATA_PATH = '/.well-known/oauth-authorization-server';
export const OMNI_OAUTH_PR_METADATA_PATH = '/.well-known/oauth-protected-resource';

/** Inputs for {@link createOmniOAuthHandler}. */
export type OmniOAuthHandlerDeps = {
  store: OmniOAuthStore;
  /**
   * Resolve the public origin (scheme://host) the server is reachable at — the
   * Cloudflare tunnel URL. Returns undefined before the tunnel is up, in which
   * case discovery falls back to the request's own Host header.
   */
  getPublicOrigin: () => string | undefined;
};

/** A handler that returns true when it consumed the request, false otherwise. */
export type OmniOAuthHandler = {
  /** Try to handle an OAuth/discovery request. Returns true if it did. */
  tryHandle: (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;
};

// ---------------------------------------------------------------------------
// Small HTTP helpers
// ---------------------------------------------------------------------------

const sendJson = (res: ServerResponse, status: number, body: unknown): void => {
  if (res.headersSent) return;
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(JSON.stringify(body));
};

const sendHtml = (res: ServerResponse, status: number, html: string): void => {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(html);
};

const redirect = (res: ServerResponse, location: string): void => {
  if (res.headersSent) return;
  res.writeHead(302, { location });
  res.end();
};

/** Read a request body and parse JSON or x-www-form-urlencoded into a record. */
const readBody = (req: IncomingMessage): Promise<Record<string, string>> =>
  new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf-8');
      if (raw.length === 0) return resolve({});
      const ctype = (req.headers['content-type'] ?? '').toString();
      try {
        if (ctype.includes('application/json')) {
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(parsed)) out[k] = typeof v === 'string' ? v : JSON.stringify(v);
          return resolve(out);
        }
      } catch {
        return resolve({});
      }
      // Default: form-urlencoded.
      const params = new URLSearchParams(raw);
      const out: Record<string, string> = {};
      for (const [k, v] of params) out[k] = v;
      resolve(out);
    });
    req.on('error', () => resolve({}));
  });

/** HTML-escape untrusted text before embedding it in the consent page. */
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// ---------------------------------------------------------------------------
// Consent page
// ---------------------------------------------------------------------------

/** Render the minimal consent screen. All params are echoed back as hidden inputs. */
const consentPage = (params: { clientName: string; scope: string; fields: Record<string, string> }): string => {
  const hidden = Object.entries(params.fields)
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}" />`)
    .join('\n      ');
  const scopeLine = params.scope ? `<p class="scope">Requested scope: <code>${esc(params.scope)}</code></p>` : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Authorize access — AionUi</title>
  <style>
    :root { color-scheme: light dark; }
    body { font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; margin: 0; min-height: 100vh;
      display: grid; place-items: center; background: #0b0d12; color: #e6e8ee; }
    .card { width: min(420px, 92vw); background: #151823; border: 1px solid #232838; border-radius: 16px;
      padding: 28px; box-shadow: 0 18px 48px rgba(0,0,0,.45); }
    h1 { font-size: 18px; margin: 0 0 4px; }
    p { font-size: 14px; line-height: 1.5; color: #aab1c5; margin: 8px 0; }
    .client { color: #e6e8ee; font-weight: 600; }
    .scope code, p code { background: #0b0d12; border: 1px solid #232838; border-radius: 6px; padding: 1px 6px; font-size: 12px; }
    .row { display: flex; gap: 12px; margin-top: 22px; }
    button { flex: 1; border: 0; border-radius: 10px; padding: 12px 16px; font-size: 14px; font-weight: 600; cursor: pointer; }
    .approve { background: #4f7cff; color: #fff; }
    .deny { background: transparent; color: #aab1c5; border: 1px solid #232838; }
    .note { font-size: 12px; color: #6b7280; margin-top: 18px; }
  </style>
</head>
<body>
  <main class="card">
    <h1>Authorize access</h1>
    <p><span class="client">${esc(params.clientName)}</span> wants to connect to your AionUi workspace through the External MCP Gateway.</p>
    ${scopeLine}
    <p>Approving lets this client call the IDE tools you have enabled, over your secure tunnel, until you revoke it in Settings.</p>
    <form method="post" action="${OMNI_OAUTH_PREFIX}/authorize">
      ${hidden}
      <div class="row">
        <button class="deny" type="submit" name="decision" value="deny">Deny</button>
        <button class="approve" type="submit" name="decision" value="approve">Approve</button>
      </div>
    </form>
  </main>
</body>
</html>`;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Build the OAuth HTTP handler. Mount it ahead of the Bearer auth gate. */
export const createOmniOAuthHandler = (deps: OmniOAuthHandlerDeps): OmniOAuthHandler => {
  /** Resolve the public origin, preferring the tunnel URL, falling back to Host. */
  const originOf = (req: IncomingMessage): string => {
    const tunnel = deps.getPublicOrigin();
    if (tunnel) return tunnel.replace(/\/+$/, '');
    const host = (req.headers['host'] ?? '127.0.0.1').toString();
    const proto = (req.headers['x-forwarded-proto'] ?? 'http').toString().split(',')[0];
    return `${proto}://${host}`;
  };

  const metadata = (origin: string): Record<string, unknown> => ({
    issuer: origin,
    authorization_endpoint: `${origin}${OMNI_OAUTH_PREFIX}/authorize`,
    token_endpoint: `${origin}${OMNI_OAUTH_PREFIX}/token`,
    registration_endpoint: `${origin}${OMNI_OAUTH_PREFIX}/register`,
    revocation_endpoint: `${origin}${OMNI_OAUTH_PREFIX}/revoke`,
    response_types_supported: [...OMNI_OAUTH_RESPONSE_TYPES],
    grant_types_supported: [...OMNI_OAUTH_GRANT_TYPES],
    code_challenge_methods_supported: [...OMNI_OAUTH_CODE_CHALLENGE_METHODS],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
  });

  const handleAuthorizeGet = async (req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> => {
    const q = url.searchParams;
    const clientId = q.get('client_id') ?? '';
    const redirectUri = q.get('redirect_uri') ?? undefined;
    const responseType = q.get('response_type') ?? '';
    const codeChallenge = q.get('code_challenge') ?? undefined;
    const codeChallengeMethod = q.get('code_challenge_method') ?? undefined;
    const validation = await deps.store.validateAuthorizeRequest({
      clientId,
      redirectUri,
      responseType,
      codeChallenge,
      codeChallengeMethod,
    });
    if ('error' in validation) {
      sendHtml(
        res,
        400,
        `<p>Authorization error: ${esc(validation.error.error)} — ${esc(validation.error.error_description ?? '')}</p>`
      );
      return;
    }
    sendHtml(
      res,
      200,
      consentPage({
        clientName: validation.client.clientName ?? validation.client.clientId,
        scope: q.get('scope') ?? '',
        fields: {
          client_id: clientId,
          redirect_uri: validation.redirectUri,
          response_type: responseType,
          code_challenge: codeChallenge ?? '',
          code_challenge_method: codeChallengeMethod ?? 'S256',
          scope: q.get('scope') ?? '',
          state: q.get('state') ?? '',
        },
      })
    );
  };

  const handleAuthorizePost = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req);
    const validation = await deps.store.validateAuthorizeRequest({
      clientId: body.client_id ?? '',
      redirectUri: body.redirect_uri,
      responseType: body.response_type ?? 'code',
      codeChallenge: body.code_challenge,
      codeChallengeMethod: body.code_challenge_method,
    });
    if ('error' in validation) {
      sendHtml(res, 400, `<p>Authorization error: ${esc(validation.error.error)}</p>`);
      return;
    }
    const redirectUri = validation.redirectUri;
    const state = body.state ?? '';
    const stateQs = state ? `&state=${encodeURIComponent(state)}` : '';
    if (body.decision !== 'approve') {
      redirect(res, `${redirectUri}?error=access_denied${stateQs}`);
      return;
    }
    const code = deps.store.issueAuthCode({
      clientId: body.client_id ?? '',
      redirectUri,
      codeChallenge: body.code_challenge ?? '',
      codeChallengeMethod: body.code_challenge_method ?? 'S256',
      scope: body.scope ?? '',
    });
    redirect(res, `${redirectUri}?code=${encodeURIComponent(code)}${stateQs}`);
  };

  const handleToken = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req);
    const grantType = body.grant_type ?? '';
    const sendTokenResult = (
      result:
        | { ok: true; result: { accessToken: string; refreshToken: string; expiresInSec: number; scope: string } }
        | { ok: false; error: { error: string; error_description?: string } }
    ): void => {
      if ('error' in result) {
        sendJson(res, 400, result.error);
        return;
      }
      sendJson(res, 200, {
        access_token: result.result.accessToken,
        token_type: 'Bearer',
        expires_in: result.result.expiresInSec,
        refresh_token: result.result.refreshToken,
        scope: result.result.scope,
      });
    };
    if (grantType === 'authorization_code') {
      sendTokenResult(
        await deps.store.exchangeAuthCode({
          code: body.code ?? '',
          clientId: body.client_id ?? '',
          redirectUri: body.redirect_uri ?? '',
          codeVerifier: body.code_verifier ?? '',
        })
      );
      return;
    }
    if (grantType === 'refresh_token') {
      sendTokenResult(
        await deps.store.refresh({
          refreshToken: body.refresh_token ?? '',
          clientId: body.client_id ?? '',
        })
      );
      return;
    }
    sendJson(res, 400, {
      error: 'unsupported_grant_type',
      error_description: 'Only authorization_code and refresh_token are supported.',
    });
  };

  const handleRegister = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req);
    // redirect_uris may arrive as a JSON array (we stringified non-strings in readBody).
    let redirectUris: string[] = [];
    if (typeof body.redirect_uris === 'string') {
      try {
        const parsed = JSON.parse(body.redirect_uris) as unknown;
        if (Array.isArray(parsed)) redirectUris = parsed.filter((u): u is string => typeof u === 'string');
        else if (typeof parsed === 'string') redirectUris = [parsed];
      } catch {
        redirectUris = body.redirect_uris.length > 0 ? [body.redirect_uris] : [];
      }
    }
    if (redirectUris.length === 0) {
      sendJson(res, 400, {
        error: 'invalid_redirect_uri',
        error_description: 'At least one redirect_uri is required.',
      });
      return;
    }
    const client = await deps.store.registerClient({
      clientName: typeof body.client_name === 'string' ? body.client_name : undefined,
      redirectUris,
      tokenEndpointAuthMethod:
        typeof body.token_endpoint_auth_method === 'string' ? body.token_endpoint_auth_method : 'none',
    });
    sendJson(res, 201, {
      client_id: client.clientId,
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: client.grantTypes,
      token_endpoint_auth_method: client.tokenEndpointAuthMethod,
      client_id_issued_at: Math.floor(client.createdAt / 1000),
    });
  };

  const handleRevoke = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const body = await readBody(req);
    await deps.store.revokeToken(body.token ?? '');
    // RFC 7009: always 200, even for unknown tokens.
    sendJson(res, 200, {});
  };

  const tryHandle = async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    const method = (req.method ?? 'GET').toUpperCase();

    // Discovery (GET only).
    if (pathname === OMNI_OAUTH_AS_METADATA_PATH || pathname === OMNI_OAUTH_PR_METADATA_PATH) {
      const origin = originOf(req);
      if (pathname === OMNI_OAUTH_PR_METADATA_PATH) {
        sendJson(res, 200, { resource: origin, authorization_servers: [origin] });
      } else {
        sendJson(res, 200, metadata(origin));
      }
      return true;
    }

    if (!pathname.startsWith(`${OMNI_OAUTH_PREFIX}/`)) return false;
    const route = pathname.slice(OMNI_OAUTH_PREFIX.length + 1);

    // CORS preflight for token/register/revoke called from browser-based clients.
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET,POST,OPTIONS',
        'access-control-allow-headers': 'content-type,authorization',
      });
      res.end();
      return true;
    }

    switch (route) {
      case 'register':
        if (method === 'POST') await handleRegister(req, res);
        else sendJson(res, 405, { error: 'method_not_allowed' });
        return true;
      case 'authorize':
        if (method === 'GET') await handleAuthorizeGet(req, res, url);
        else if (method === 'POST') await handleAuthorizePost(req, res);
        else sendJson(res, 405, { error: 'method_not_allowed' });
        return true;
      case 'token':
        if (method === 'POST') await handleToken(req, res);
        else sendJson(res, 405, { error: 'method_not_allowed' });
        return true;
      case 'revoke':
        if (method === 'POST') await handleRevoke(req, res);
        else sendJson(res, 405, { error: 'method_not_allowed' });
        return true;
      default:
        return false;
    }
  };

  return { tryHandle };
};

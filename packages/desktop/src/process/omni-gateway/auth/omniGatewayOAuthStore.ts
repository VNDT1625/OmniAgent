/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OAuth 2.1 core logic for the Omni External MCP Gateway — the pure, testable
 * heart of the authorization server. It owns:
 *
 *  - **Client registry** (RFC 7591 Dynamic Client Registration). Clients are
 *    persisted via the injected security store so a ChatGPT connector survives
 *    an app restart without re-registering.
 *  - **Authorization codes** (in-RAM, short-lived ~60 s). Each code is bound to
 *    a PKCE `code_challenge` (S256 ONLY — `plain` is rejected per OAuth 2.1).
 *  - **Access / refresh tokens** (persisted, opaque, high-entropy). Validation
 *    is constant-time. Refresh rotates both tokens.
 *
 * Security properties enforced here:
 *  - Tokens and codes are 32 random bytes (hex) — never derived from anything.
 *  - `validateAccessToken` uses a constant-time comparison and rejects expired.
 *  - PKCE verifier check uses SHA-256 + base64url, constant-time compared.
 *  - Redirect URIs are matched EXACTLY against the registered set.
 *  - Nothing logs token/secret/verifier values.
 *
 * Everything is dependency-injected (`now`, `newToken`, `newId`) so unit tests
 * are deterministic. The HTTP wiring lives in `omniGatewayOAuth.ts`.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IOmniSecurityStore } from './omniGatewaySecurityStore';
import type { OmniOAuthClient, OmniOAuthClientSummary, OmniOAuthToken } from './authTypes';

// ---------------------------------------------------------------------------
// Tunables
// ---------------------------------------------------------------------------

/** Authorization codes are single-use and very short-lived. */
export const OMNI_OAUTH_CODE_TTL_MS = 60_000;

/** Access-token lifetime (1h) — clients refresh transparently. */
export const OMNI_OAUTH_ACCESS_TTL_MS = 60 * 60 * 1000;

/** Refresh-token lifetime (30d) — long enough to keep a connector alive. */
export const OMNI_OAUTH_REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Grant + auth-method support we advertise + honour. */
export const OMNI_OAUTH_GRANT_TYPES = ['authorization_code', 'refresh_token'] as const;
export const OMNI_OAUTH_RESPONSE_TYPES = ['code'] as const;
export const OMNI_OAUTH_CODE_CHALLENGE_METHODS = ['S256'] as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A pending authorization code awaiting exchange at /token. */
type PendingAuthCode = {
  code: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  expiresAt: number;
};

/** Result of a /token exchange. */
export type OAuthTokenResult = {
  accessToken: string;
  refreshToken: string;
  expiresInSec: number;
  scope: string;
};

/** A structured OAuth error (maps to the RFC 6749 error response). */
export type OAuthError = { error: string; error_description?: string };

/** Dependency-injected primitives. */
export type OmniOAuthStoreDeps = {
  /** Persistence for clients + tokens. */
  security: IOmniSecurityStore;
  /** Wall-clock provider (ms). */
  now: () => number;
  /** High-entropy opaque token generator (hex). */
  newToken: () => string;
  /** Opaque id generator for client ids (hex). */
  newId: () => string;
};

/** Inputs for {@link OmniOAuthStore.registerClient}. */
export type RegisterClientInput = {
  clientName?: string;
  redirectUris: string[];
  grantTypes?: string[];
  tokenEndpointAuthMethod?: string;
};

/** Inputs for {@link OmniOAuthStore.issueAuthCode}. */
export type IssueAuthCodeInput = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  scope?: string;
};

/** Public API of the OAuth core store. */
export type OmniOAuthStore = {
  // Client registry
  registerClient: (input: RegisterClientInput) => Promise<OmniOAuthClient>;
  getClient: (clientId: string) => Promise<OmniOAuthClient | undefined>;
  listClients: () => Promise<OmniOAuthClientSummary[]>;
  /** Revoke a client and ALL of its tokens. Returns true if the client existed. */
  revokeClient: (clientId: string) => Promise<boolean>;

  // Authorization-code grant (PKCE)
  /** Validate a /authorize request shape; returns an error or the resolved client+redirect. */
  validateAuthorizeRequest: (input: {
    clientId: string;
    redirectUri?: string;
    responseType: string;
    codeChallenge?: string;
    codeChallengeMethod?: string;
  }) => Promise<{ ok: true; client: OmniOAuthClient; redirectUri: string } | { ok: false; error: OAuthError }>;
  /** Mint a single-use auth code (after user consent). */
  issueAuthCode: (input: IssueAuthCodeInput) => string;

  // Token endpoint
  /** Exchange an auth code + PKCE verifier for tokens. */
  exchangeAuthCode: (input: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
  }) => Promise<{ ok: true; result: OAuthTokenResult } | { ok: false; error: OAuthError }>;
  /** Rotate tokens via a refresh token. */
  refresh: (input: {
    refreshToken: string;
    clientId: string;
  }) => Promise<{ ok: true; result: OAuthTokenResult } | { ok: false; error: OAuthError }>;
  /** Revoke a presented access OR refresh token (RFC 7009). Always succeeds. */
  revokeToken: (token: string) => Promise<void>;

  // Resource-server side
  /** Constant-time validate a presented access token; returns the live token or undefined. */
  validateAccessToken: (presented: string) => Promise<OmniOAuthToken | undefined>;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** base64url of a Buffer (no padding). */
const base64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Constant-time string compare that never throws on length mismatch. */
const safeEqual = (a: string, b: string): boolean => {
  const ab = Buffer.from(a, 'utf-8');
  const bb = Buffer.from(b, 'utf-8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
};

/** Verify a PKCE S256 challenge against the presented verifier. */
const verifyPkceS256 = (verifier: string, challenge: string): boolean => {
  const computed = base64url(createHash('sha256').update(verifier).digest());
  return safeEqual(computed, challenge);
};

/** Count the live (non-expired) access tokens issued to a client. */
const liveTokensFor = (tokens: OmniOAuthToken[], clientId: string, now: number): number =>
  tokens.filter((t) => t.clientId === clientId && t.accessExpiresAt > now).length;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Build the OAuth core store. */
export const createOmniOAuthStore = (deps: OmniOAuthStoreDeps): OmniOAuthStore => {
  // Auth codes are intentionally NOT persisted — they live < 60 s.
  const pendingCodes = new Map<string, PendingAuthCode>();

  const sweepCodes = (): void => {
    const now = deps.now();
    for (const [k, c] of pendingCodes) {
      if (c.expiresAt <= now) pendingCodes.delete(k);
    }
  };

  /** Mint a fresh access/refresh pair for a client and persist it. */
  const mint = async (clientId: string, scope: string): Promise<OAuthTokenResult> => {
    const state = await deps.security.load();
    const now = deps.now();
    const token: OmniOAuthToken = {
      accessToken: deps.newToken(),
      refreshToken: deps.newToken(),
      clientId,
      scope,
      issuedAt: now,
      accessExpiresAt: now + OMNI_OAUTH_ACCESS_TTL_MS,
      refreshExpiresAt: now + OMNI_OAUTH_REFRESH_TTL_MS,
    };
    await deps.security.save({ ...state, oauthTokens: [...state.oauthTokens, token] });
    return {
      accessToken: token.accessToken,
      refreshToken: token.refreshToken,
      expiresInSec: Math.floor(OMNI_OAUTH_ACCESS_TTL_MS / 1000),
      scope,
    };
  };

  return {
    async registerClient(input) {
      const state = await deps.security.load();
      const client: OmniOAuthClient = {
        clientId: deps.newId(),
        clientName: input.clientName,
        redirectUris: input.redirectUris,
        createdAt: deps.now(),
        grantTypes: input.grantTypes && input.grantTypes.length > 0 ? input.grantTypes : [...OMNI_OAUTH_GRANT_TYPES],
        tokenEndpointAuthMethod: input.tokenEndpointAuthMethod ?? 'none',
      };
      await deps.security.save({ ...state, oauthClients: [...state.oauthClients, client] });
      return client;
    },

    async getClient(clientId) {
      const state = await deps.security.load();
      return state.oauthClients.find((c) => c.clientId === clientId);
    },

    async listClients() {
      const state = await deps.security.load();
      const now = deps.now();
      return state.oauthClients.map((c) => ({
        clientId: c.clientId,
        clientName: c.clientName,
        redirectUris: c.redirectUris,
        createdAt: c.createdAt,
        activeTokenCount: liveTokensFor(state.oauthTokens, c.clientId, now),
      }));
    },

    async revokeClient(clientId) {
      const state = await deps.security.load();
      const exists = state.oauthClients.some((c) => c.clientId === clientId);
      if (!exists) return false;
      await deps.security.save({
        ...state,
        oauthClients: state.oauthClients.filter((c) => c.clientId !== clientId),
        oauthTokens: state.oauthTokens.filter((t) => t.clientId !== clientId),
      });
      // Drop any pending codes for this client too.
      for (const [k, c] of pendingCodes) {
        if (c.clientId === clientId) pendingCodes.delete(k);
      }
      return true;
    },

    async validateAuthorizeRequest({ clientId, redirectUri, responseType, codeChallenge, codeChallengeMethod }) {
      const client = await this.getClient(clientId);
      if (!client) return { ok: false, error: { error: 'invalid_client', error_description: 'Unknown client_id.' } };
      if (responseType !== 'code') {
        return {
          ok: false,
          error: { error: 'unsupported_response_type', error_description: 'Only "code" is supported.' },
        };
      }
      // Resolve redirect URI: if supplied it must match exactly; else use the
      // sole registered one (ambiguous when several are registered).
      let resolvedRedirect: string | undefined;
      if (redirectUri) {
        if (!client.redirectUris.includes(redirectUri)) {
          return {
            ok: false,
            error: { error: 'invalid_request', error_description: 'redirect_uri is not registered.' },
          };
        }
        resolvedRedirect = redirectUri;
      } else if (client.redirectUris.length === 1) {
        resolvedRedirect = client.redirectUris[0];
      }
      if (!resolvedRedirect) {
        return { ok: false, error: { error: 'invalid_request', error_description: 'redirect_uri is required.' } };
      }
      if (!codeChallenge) {
        return {
          ok: false,
          error: { error: 'invalid_request', error_description: 'PKCE code_challenge is required.' },
        };
      }
      if ((codeChallengeMethod ?? 'plain') !== 'S256') {
        return { ok: false, error: { error: 'invalid_request', error_description: 'Only S256 PKCE is supported.' } };
      }
      return { ok: true, client, redirectUri: resolvedRedirect };
    },

    issueAuthCode(input) {
      sweepCodes();
      const code = deps.newToken();
      pendingCodes.set(code, {
        code,
        clientId: input.clientId,
        redirectUri: input.redirectUri,
        codeChallenge: input.codeChallenge,
        scope: input.scope ?? '',
        expiresAt: deps.now() + OMNI_OAUTH_CODE_TTL_MS,
      });
      return code;
    },

    async exchangeAuthCode({ code, clientId, redirectUri, codeVerifier }) {
      sweepCodes();
      const pending = pendingCodes.get(code);
      // Single-use: delete on first lookup regardless of outcome.
      if (pending) pendingCodes.delete(code);
      if (!pending || pending.expiresAt <= deps.now()) {
        return {
          ok: false,
          error: { error: 'invalid_grant', error_description: 'Authorization code is invalid or expired.' },
        };
      }
      if (!safeEqual(pending.clientId, clientId)) {
        return { ok: false, error: { error: 'invalid_grant', error_description: 'client_id mismatch.' } };
      }
      if (!safeEqual(pending.redirectUri, redirectUri)) {
        return { ok: false, error: { error: 'invalid_grant', error_description: 'redirect_uri mismatch.' } };
      }
      if (!codeVerifier || !verifyPkceS256(codeVerifier, pending.codeChallenge)) {
        return { ok: false, error: { error: 'invalid_grant', error_description: 'PKCE verification failed.' } };
      }
      const token = await mint(clientId, pending.scope);
      return { ok: true, result: token };
    },

    async refresh({ refreshToken, clientId }) {
      const state = await deps.security.load();
      const now = deps.now();
      const existing = state.oauthTokens.find((t) => safeEqual(t.refreshToken, refreshToken));
      if (!existing || existing.refreshExpiresAt <= now) {
        return {
          ok: false,
          error: { error: 'invalid_grant', error_description: 'Refresh token is invalid or expired.' },
        };
      }
      if (!safeEqual(existing.clientId, clientId)) {
        return { ok: false, error: { error: 'invalid_grant', error_description: 'client_id mismatch.' } };
      }
      // Rotate: drop the old pair, mint a fresh one.
      await deps.security.save({
        ...state,
        oauthTokens: state.oauthTokens.filter((t) => t.accessToken !== existing.accessToken),
      });
      const token = await mint(clientId, existing.scope);
      return { ok: true, result: token };
    },

    async revokeToken(token) {
      const state = await deps.security.load();
      const next = state.oauthTokens.filter((t) => t.accessToken !== token && t.refreshToken !== token);
      if (next.length !== state.oauthTokens.length) {
        await deps.security.save({ ...state, oauthTokens: next });
      }
    },

    async validateAccessToken(presented) {
      if (!presented) return undefined;
      const state = await deps.security.load();
      const now = deps.now();
      const match = state.oauthTokens.find((t) => safeEqual(t.accessToken, presented));
      if (!match) return undefined;
      if (match.accessExpiresAt <= now) return undefined;
      return match;
    },
  };
};

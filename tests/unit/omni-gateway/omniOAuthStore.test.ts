/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the OAuth 2.1 core store: Dynamic Client Registration,
 * PKCE-S256 authorization-code grant, refresh rotation, revocation, and
 * constant-time access-token validation. All primitives (clock, token/id gen)
 * are injected so the flow is deterministic; persistence runs through a real
 * security store backed by an in-memory fs.
 */

import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { createOmniSecurityStore, type OmniSecurityFs } from '@/process/omni-gateway/auth/omniGatewaySecurityStore';
import {
  createOmniOAuthStore,
  OMNI_OAUTH_ACCESS_TTL_MS,
  OMNI_OAUTH_CODE_TTL_MS,
  type OmniOAuthStore,
} from '@/process/omni-gateway/auth/omniGatewayOAuthStore';

const memFs = (): OmniSecurityFs => {
  const files = new Map<string, string>();
  return {
    readFile: async (p) => {
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    writeFile: async (p, data) => void files.set(p, data),
    rename: async (o, n) => {
      const v = files.get(o);
      if (v !== undefined) {
        files.set(n, v);
        files.delete(o);
      }
    },
    mkdir: async () => undefined,
  };
};

const base64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** A valid PKCE verifier/challenge pair. */
const VERIFIER = 'verifier-0123456789-0123456789-0123456789-abc';
const CHALLENGE = base64url(createHash('sha256').update(VERIFIER).digest());

const newClock = (start = 1000) => {
  let t = start;
  return { now: () => t, advance: (ms: number) => void (t += ms) };
};

const newGen = (prefix: string) => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

const setup = (startTime = 1000) => {
  const clock = newClock(startTime);
  const security = createOmniSecurityStore({
    dir: '/data',
    fs: memFs(),
    encryptionKey: Buffer.alloc(32, 9),
    now: clock.now,
  });
  const store: OmniOAuthStore = createOmniOAuthStore({
    security,
    now: clock.now,
    newToken: newGen('tok'),
    newId: newGen('cid'),
  });
  return { store, clock, security };
};

const registerClient = (store: OmniOAuthStore, redirectUri = 'https://app.example/cb') =>
  store.registerClient({ clientName: 'Test', redirectUris: [redirectUri] });

describe('omniGatewayOAuthStore — client registry (DCR)', () => {
  it('registers a public PKCE client with server-issued id', async () => {
    const { store } = setup();
    const client = await registerClient(store);
    expect(client.clientId).toBe('cid-1');
    expect(client.tokenEndpointAuthMethod).toBe('none');
    expect(client.redirectUris).toEqual(['https://app.example/cb']);
  });

  it('lists clients with a live token count and supports revoke', async () => {
    const { store } = setup();
    const client = await registerClient(store);
    let list = await store.listClients();
    expect(list).toHaveLength(1);
    expect(list[0]?.activeTokenCount).toBe(0);

    const revoked = await store.revokeClient(client.clientId);
    expect(revoked).toBe(true);
    list = await store.listClients();
    expect(list).toHaveLength(0);
    expect(await store.revokeClient('nope')).toBe(false);
  });
});

describe('omniGatewayOAuthStore — authorize + PKCE', () => {
  it('rejects a non-S256 PKCE method and missing challenge', async () => {
    const { store } = setup();
    const client = await registerClient(store);
    const plain = await store.validateAuthorizeRequest({
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      responseType: 'code',
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'plain',
    });
    expect(plain.ok).toBe(false);

    const noChallenge = await store.validateAuthorizeRequest({
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      responseType: 'code',
    });
    expect(noChallenge.ok).toBe(false);
  });

  it('rejects an unregistered redirect_uri', async () => {
    const { store } = setup();
    const client = await registerClient(store);
    const result = await store.validateAuthorizeRequest({
      clientId: client.clientId,
      redirectUri: 'https://evil.example/cb',
      responseType: 'code',
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
    });
    expect(result.ok).toBe(false);
  });
});

describe('omniGatewayOAuthStore — token grant', () => {
  it('exchanges a valid code + verifier for tokens', async () => {
    const { store } = setup();
    const client = await registerClient(store);
    const code = store.issueAuthCode({
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
    });
    const result = await store.exchangeAuthCode({
      code,
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      codeVerifier: VERIFIER,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result.accessToken).toBeTruthy();
      expect(result.result.refreshToken).toBeTruthy();
      expect(result.result.expiresInSec).toBe(Math.floor(OMNI_OAUTH_ACCESS_TTL_MS / 1000));
    }
  });

  it('rejects a wrong PKCE verifier', async () => {
    const { store } = setup();
    const client = await registerClient(store);
    const code = store.issueAuthCode({
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
    });
    const result = await store.exchangeAuthCode({
      code,
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      codeVerifier: 'wrong-verifier',
    });
    expect(result.ok).toBe(false);
  });

  it('codes are single-use', async () => {
    const { store } = setup();
    const client = await registerClient(store);
    const code = store.issueAuthCode({
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
    });
    const first = await store.exchangeAuthCode({
      code,
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      codeVerifier: VERIFIER,
    });
    expect(first.ok).toBe(true);
    const second = await store.exchangeAuthCode({
      code,
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      codeVerifier: VERIFIER,
    });
    expect(second.ok).toBe(false);
  });

  it('codes expire after the TTL', async () => {
    const { store, clock } = setup();
    const client = await registerClient(store);
    const code = store.issueAuthCode({
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
    });
    clock.advance(OMNI_OAUTH_CODE_TTL_MS + 1);
    const result = await store.exchangeAuthCode({
      code,
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      codeVerifier: VERIFIER,
    });
    expect(result.ok).toBe(false);
  });
});

describe('omniGatewayOAuthStore — refresh + validate + revoke', () => {
  const mintTokens = async (store: OmniOAuthStore) => {
    const client = await registerClient(store);
    const code = store.issueAuthCode({
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      codeChallenge: CHALLENGE,
      codeChallengeMethod: 'S256',
    });
    const result = await store.exchangeAuthCode({
      code,
      clientId: client.clientId,
      redirectUri: client.redirectUris[0],
      codeVerifier: VERIFIER,
    });
    if (!result.ok) throw new Error('mint failed');
    return { client, tokens: result.result };
  };

  it('validates a live access token and rejects after expiry', async () => {
    const { store, clock } = setup();
    const { tokens } = await mintTokens(store);
    expect(await store.validateAccessToken(tokens.accessToken)).toBeDefined();
    expect(await store.validateAccessToken('not-a-token')).toBeUndefined();
    clock.advance(OMNI_OAUTH_ACCESS_TTL_MS + 1);
    expect(await store.validateAccessToken(tokens.accessToken)).toBeUndefined();
  });

  it('refresh rotates BOTH tokens and invalidates the old access token', async () => {
    const { store } = setup();
    const { client, tokens } = await mintTokens(store);
    const refreshed = await store.refresh({ refreshToken: tokens.refreshToken, clientId: client.clientId });
    expect(refreshed.ok).toBe(true);
    if (refreshed.ok) {
      expect(refreshed.result.accessToken).not.toBe(tokens.accessToken);
      expect(refreshed.result.refreshToken).not.toBe(tokens.refreshToken);
      // Old access token no longer validates after rotation.
      expect(await store.validateAccessToken(tokens.accessToken)).toBeUndefined();
      // New one does.
      expect(await store.validateAccessToken(refreshed.result.accessToken)).toBeDefined();
    }
  });

  it('refresh rejects a client_id mismatch', async () => {
    const { store } = setup();
    const { tokens } = await mintTokens(store);
    const result = await store.refresh({ refreshToken: tokens.refreshToken, clientId: 'someone-else' });
    expect(result.ok).toBe(false);
  });

  it('revokeToken invalidates a presented access token', async () => {
    const { store } = setup();
    const { tokens } = await mintTokens(store);
    await store.revokeToken(tokens.accessToken);
    expect(await store.validateAccessToken(tokens.accessToken)).toBeUndefined();
  });

  it('revokeClient drops all of the client tokens', async () => {
    const { store } = setup();
    const { client, tokens } = await mintTokens(store);
    await store.revokeClient(client.clientId);
    expect(await store.validateAccessToken(tokens.accessToken)).toBeUndefined();
  });
});

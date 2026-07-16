/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the encrypted Omni Gateway security store.
 *
 * Uses an in-memory fs and a deterministic AES key so we can assert the
 * round-trip, the on-disk envelope shape (encrypted, no plaintext leakage),
 * defensive normalisation, and the patch/cache behaviour without touching disk
 * or the Electron `app`.
 */

import { describe, expect, it } from 'vitest';
import {
  createOmniSecurityStore,
  OMNI_SECURITY_DEFAULT_SESSION_TTL_MS,
  type OmniSecurityFs,
} from '@/process/omni-gateway/auth/omniGatewaySecurityStore';

/** A trivial in-memory fs honouring the tmp → rename atomic write. */
const memFs = () => {
  const files = new Map<string, string>();
  const fs: OmniSecurityFs = {
    readFile: async (p) => {
      const v = files.get(p);
      if (v === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return v;
    },
    writeFile: async (p, data) => {
      files.set(p, data);
    },
    rename: async (oldPath, newPath) => {
      const v = files.get(oldPath);
      if (v !== undefined) {
        files.set(newPath, v);
        files.delete(oldPath);
      }
    },
    mkdir: async () => undefined,
  };
  return { fs, files };
};

const KEY = Buffer.alloc(32, 7);

const newStore = () => {
  const { fs, files } = memFs();
  const store = createOmniSecurityStore({ dir: '/data', fs, encryptionKey: KEY, now: () => 1_000 });
  const reader = () => createOmniSecurityStore({ dir: '/data', fs, encryptionKey: KEY, now: () => 1_000 });
  return { store, files, reader };
};

describe('omniGatewaySecurityStore', () => {
  it('returns defaults when no file exists', async () => {
    const { store } = newStore();
    const state = await store.load();
    expect(state.authMode).toBe('bearer');
    expect(state.sessionTtlMs).toBe(OMNI_SECURITY_DEFAULT_SESSION_TTL_MS);
    expect(state.toolPermissions).toEqual({});
    expect(state.oauthClients).toEqual([]);
    expect(state.oauthTokens).toEqual([]);
  });

  it('round-trips a full state through encrypted persistence', async () => {
    const { store, reader } = newStore();
    await store.save({
      authMode: 'oauth',
      sessionTtlMs: 123_456,
      toolPermissions: { ide_command: false, ide_search: true },
      oauthClients: [
        {
          clientId: 'c1',
          clientName: 'ChatGPT',
          redirectUris: ['https://chat.example/cb'],
          createdAt: 1,
          grantTypes: ['authorization_code', 'refresh_token'],
          tokenEndpointAuthMethod: 'none',
        },
      ],
      oauthTokens: [
        {
          accessToken: 'at',
          refreshToken: 'rt',
          clientId: 'c1',
          scope: '',
          issuedAt: 1,
          accessExpiresAt: 2,
          refreshExpiresAt: 3,
        },
      ],
    });

    // Fresh read of the same store instance proves on-disk persistence
    // (cache is bypassed because save() returns the normalised value).
    const reloaded = await reader().load();
    expect(reloaded.authMode).toBe('oauth');
    expect(reloaded.sessionTtlMs).toBe(123_456);
    expect(reloaded.toolPermissions).toEqual({ ide_command: false, ide_search: true });
    expect(reloaded.oauthClients[0]?.clientId).toBe('c1');
    expect(reloaded.oauthTokens[0]?.accessToken).toBe('at');
  });

  it('persists an OPAQUE encrypted envelope — no plaintext leaks to disk', async () => {
    const { store, files } = newStore();
    await store.save({
      authMode: 'oauth',
      sessionTtlMs: 999,
      toolPermissions: {},
      oauthClients: [],
      oauthTokens: [
        {
          accessToken: 'super-secret-token',
          refreshToken: 'super-secret-refresh',
          clientId: 'c1',
          scope: '',
          issuedAt: 1,
          accessExpiresAt: 2,
          refreshExpiresAt: 3,
        },
      ],
    });
    const onDisk = Array.from(files.values()).join('\n');
    expect(onDisk).not.toContain('super-secret-token');
    expect(onDisk).not.toContain('super-secret-refresh');
    expect(onDisk).not.toContain('oauth');
    // Envelope shape: { v: 1, data: "iv:tag:ct" }
    const doc = JSON.parse(Array.from(files.values())[0]) as { v: number; data: string };
    expect(doc.v).toBe(1);
    expect(doc.data.split(':')).toHaveLength(3);
  });

  it('a WRONG key cannot decrypt — falls back to defaults instead of throwing', async () => {
    const { fs, files } = memFs();
    const writer = createOmniSecurityStore({ dir: '/data', fs, encryptionKey: Buffer.alloc(32, 1) });
    await writer.save({
      authMode: 'mixed',
      sessionTtlMs: 5,
      toolPermissions: {},
      oauthClients: [],
      oauthTokens: [],
    });
    const reader = createOmniSecurityStore({ dir: '/data', fs, encryptionKey: Buffer.alloc(32, 2) });
    const state = await reader.load();
    expect(state.authMode).toBe('bearer'); // default — decryption failed safely
    void files;
  });

  it('patch merges shallowly and persists', async () => {
    const { store } = newStore();
    await store.save({
      authMode: 'bearer',
      sessionTtlMs: 10,
      toolPermissions: { a: true },
      oauthClients: [],
      oauthTokens: [],
    });
    const next = await store.patch({ authMode: 'none' });
    expect(next.authMode).toBe('none');
    expect(next.sessionTtlMs).toBe(10);
    expect(next.toolPermissions).toEqual({ a: true });
  });

  it('normalises a corrupt/invalid authMode + ttl back to safe defaults', async () => {
    const { store } = newStore();
    await store.save({
      // @ts-expect-error — deliberately invalid to exercise normalisation
      authMode: 'banana',
      sessionTtlMs: -5,
      toolPermissions: { a: true },
      oauthClients: [],
      oauthTokens: [],
    });
    const state = await store.load();
    expect(state.authMode).toBe('bearer');
    expect(state.sessionTtlMs).toBe(OMNI_SECURITY_DEFAULT_SESSION_TTL_MS);
  });
});

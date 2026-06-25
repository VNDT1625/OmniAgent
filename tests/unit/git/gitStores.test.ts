/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the Git Manager stores: the encrypted credential store (token
 * encrypted at rest, never exposed in metadata, decryptable only via resolve())
 * and the repo store (CRUD + persistence + change notifications). Both use an
 * in-memory fs + injected crypto so no real disk / OS keychain is touched.
 */

import { describe, expect, it, vi } from 'vitest';
import { createGitCredentialStore, type CredentialCrypto, type CredentialFs } from '@/process/git/gitCredentialStore';
import { createGitRepoStore, deriveName, type RepoFs } from '@/process/git/gitRepoStore';

/** A trivial in-memory fs implementing the store's small fs subset. */
const memFs = (): CredentialFs & RepoFs => {
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
    writeFile: async (p, data) => {
      files.set(p, data);
    },
    rename: async (a, b) => {
      const v = files.get(a);
      if (v !== undefined) {
        files.set(b, v);
        files.delete(a);
      }
    },
    mkdir: async () => undefined,
  };
};

/** Reversible XOR-ish fake crypto so we can assert the on-disk blob is NOT plaintext. */
const fakeCrypto = (): CredentialCrypto => ({
  isAvailable: () => true,
  encrypt: (plain) => Buffer.from(`enc:${plain}`, 'utf-8').toString('base64'),
  decrypt: (b64) => {
    const s = Buffer.from(b64, 'base64').toString('utf-8');
    return s.startsWith('enc:') ? s.slice(4) : s;
  },
});

describe('gitCredentialStore — tokens encrypted at rest, never leaked in metadata', () => {
  it('add() returns metadata WITHOUT the token; only a 4-char hint', async () => {
    const fs = memFs();
    const store = createGitCredentialStore({ dir: '/cfg', fs, crypto: fakeCrypto(), now: () => 1, newId: () => 'c1' });

    const meta = await store.add({ label: 'GitHub', host: 'github.com', username: 'me', token: 'ghp_secrettoken1234' });

    // Metadata carries no token field at all.
    expect((meta as unknown as Record<string, unknown>).token).toBeUndefined();
    expect((meta as unknown as Record<string, unknown>).encryptedToken).toBeUndefined();
    // Just a recognisable 4-char tail.
    expect(meta.tokenHint).toBe('1234');
    expect(meta.host).toBe('github.com');
    expect(meta.username).toBe('me');
  });

  it('list() exposes only metadata (no decrypted token)', async () => {
    const fs = memFs();
    const store = createGitCredentialStore({ dir: '/cfg', fs, crypto: fakeCrypto(), now: () => 1, newId: () => 'c1' });
    await store.add({ label: 'X', host: 'github.com', username: 'u', token: 'ghp_abcdefghij1234567890' });

    const list = await store.list();
    expect(list).toHaveLength(1);
    const serialised = JSON.stringify(list);
    expect(serialised).not.toContain('ghp_abcdefghij1234567890');
  });

  it('resolve() returns the decrypted token (Main-only), matching what was stored', async () => {
    const fs = memFs();
    const store = createGitCredentialStore({ dir: '/cfg', fs, crypto: fakeCrypto(), now: () => 1, newId: () => 'c1' });
    await store.add({ label: 'X', host: 'github.com', username: 'u', token: 'ghp_topsecret9999' });

    const resolved = await store.resolve('c1');
    expect(resolved).toEqual({ username: 'u', token: 'ghp_topsecret9999' });
  });

  it('persists the token ENCRYPTED on disk (raw plaintext never written)', async () => {
    const written: Record<string, string> = {};
    const fs: CredentialFs = {
      readFile: async () => {
        const e = new Error('ENOENT') as NodeJS.ErrnoException;
        e.code = 'ENOENT';
        throw e;
      },
      writeFile: async (p, data) => {
        written[p] = data;
      },
      rename: async () => undefined,
      mkdir: async () => undefined,
    };
    const store = createGitCredentialStore({ dir: '/cfg', fs, crypto: fakeCrypto(), now: () => 1, newId: () => 'c1' });
    await store.add({ label: 'X', host: 'github.com', username: 'u', token: 'ghp_plaintextcheck1234' });

    const blob = Object.values(written).join('');
    expect(blob).not.toContain('ghp_plaintextcheck1234'); // never stored as plaintext
    // The stored token is the base64 of the fake-encrypted form ("enc:<token>").
    const expectedBlob = Buffer.from('enc:ghp_plaintextcheck1234', 'utf-8').toString('base64');
    expect(blob).toContain(expectedBlob);
  });

  it('remove() drops the credential', async () => {
    const fs = memFs();
    let id = 0;
    const store = createGitCredentialStore({
      dir: '/cfg',
      fs,
      crypto: fakeCrypto(),
      now: () => 1,
      newId: () => `c${++id}`,
    });
    await store.add({ label: 'A', host: 'github.com', username: 'a', token: 'ghp_aaaa1111' });
    await store.add({ label: 'B', host: 'github.com', username: 'b', token: 'ghp_bbbb2222' });
    expect(await store.list()).toHaveLength(2);
    await store.remove('c1');
    const left = await store.list();
    expect(left).toHaveLength(1);
    expect(left[0].label).toBe('B');
  });
});

describe('gitRepoStore — CRUD + persistence + change notifications', () => {
  it('add() derives a name from the URL and persists the repo', async () => {
    const fs = memFs();
    const store = createGitRepoStore({ dir: '/cfg', fs, now: () => 1, newId: () => 'r1' });
    const repo = await store.add({ remoteUrl: 'https://github.com/acme/widgets.git', localPath: '/tmp/widgets' });
    expect(repo.id).toBe('r1');
    expect(repo.name).toBe('widgets');
    expect(repo.branch).toBe('main');
    expect(await store.list()).toHaveLength(1);
  });

  it('onChange fires with the new list after add/patch/remove', async () => {
    const fs = memFs();
    let id = 0;
    const store = createGitRepoStore({ dir: '/cfg', fs, now: () => 1, newId: () => `r${++id}` });
    const seen: number[] = [];
    const off = store.onChange((repos) => seen.push(repos.length));

    const repo = await store.add({ remoteUrl: 'https://github.com/a/b.git', localPath: '/x' });
    await store.patch(repo.id, { lastPushAt: 123 });
    await store.remove(repo.id);
    off();

    expect(seen).toEqual([1, 1, 0]);
    const after = await store.get(repo.id);
    expect(after).toBeUndefined();
  });

  it('patch() updates mutable fields and keeps the id', async () => {
    const fs = memFs();
    const store = createGitRepoStore({ dir: '/cfg', fs, now: () => 1, newId: () => 'r1' });
    const repo = await store.add({ remoteUrl: 'https://github.com/a/b.git', localPath: '/x', branch: 'dev' });
    const patched = await store.patch(repo.id, { lastPullAt: 999 });
    expect(patched?.id).toBe('r1');
    expect(patched?.lastPullAt).toBe(999);
    expect(patched?.branch).toBe('dev');
  });
});

describe('deriveName', () => {
  it('extracts the repo name from common URL shapes', () => {
    expect(deriveName('https://github.com/owner/repo.git')).toBe('repo');
    expect(deriveName('https://github.com/owner/repo')).toBe('repo');
    expect(deriveName('git@github.com:owner/repo.git')).toBe('repo');
    expect(deriveName('https://github.com/owner/repo/')).toBe('repo');
  });
});

describe('redact (token never surfaces in output)', () => {
  it('scrubs the known token and common PAT shapes', async () => {
    const { redact } = await import('@/process/git/gitRunner');
    expect(redact('using ghp_abcdefghijklmnopqrstuvwxyz')).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz');
    expect(redact('token=SECRETVALUE pushed', 'SECRETVALUE')).not.toContain('SECRETVALUE');
    expect(redact('Authorization: Basic dXNlcjp0b2tlbg==')).toContain('Basic ***');
  });
});

// Touch vi to keep the import used when no spies are needed (lint-friendly).
void vi;

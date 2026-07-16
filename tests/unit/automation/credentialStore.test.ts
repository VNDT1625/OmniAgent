/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the Automation credential vault: round-trip encryption, partial
 * update without double-encrypt, and decrypt-failure tolerance.
 */

import { describe, expect, it } from 'vitest';
import { createCredentialStore, type CredentialFs } from '@/process/automation/credentialStore';

/** In-memory fs adapter for deterministic, disk-free tests. */
const memFs = () => {
  const files = new Map<string, string>();
  const fs: CredentialFs = {
    readFile: (p) =>
      files.has(p)
        ? Promise.resolve(files.get(p) as string)
        : Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })),
    writeFile: (p, data) => {
      files.set(p, data);
      return Promise.resolve();
    },
    rename: (from, to) => {
      files.set(to, files.get(from) ?? '');
      files.delete(from);
      return Promise.resolve();
    },
    mkdir: () => Promise.resolve(undefined),
  };
  return { files, fs };
};

const KEY = Buffer.alloc(32, 7); // deterministic 32-byte test key

const makeStore = () => {
  const { fs } = memFs();
  return createCredentialStore({
    dir: '/tmp/creds',
    fs,
    encryptionKey: KEY,
    newId: (() => {
      let i = 0;
      return () => `c${++i}`;
    })(),
  });
};

describe('credentialStore', () => {
  it('saves a credential and decrypts the fields back', async () => {
    const store = makeStore();
    const saved = await store.save({ name: 'FB Token', kind: 'token', fields: { accessToken: 'secret-123' } });
    expect(saved.id).toBe('c1');
    // The persisted field must be encrypted (not plain text).
    expect(saved.fields.accessToken).not.toBe('secret-123');
    expect(saved.fields.accessToken.split(':')).toHaveLength(3);

    const decrypted = await store.getDecrypted('c1');
    expect(decrypted).toEqual({ accessToken: 'secret-123' });
  });

  it('lists credentials with fields still encrypted', async () => {
    const store = makeStore();
    await store.save({ name: 'SMTP', kind: 'smtp', fields: { password: 'pw' } });
    const list = await store.list();
    expect(list).toHaveLength(1);
    expect(list[0].fields.password).not.toBe('pw');
  });

  it('does not double-encrypt on partial update', async () => {
    const store = makeStore();
    const first = await store.save({ name: 'S3', kind: 's3', fields: { accessKeyId: 'AKIA', secretAccessKey: 'shh' } });
    // Update only the name; fields omitted should remain decryptable.
    await store.save({ id: first.id, name: 'S3 renamed', kind: 's3' });
    const decrypted = await store.getDecrypted(first.id);
    expect(decrypted).toEqual({ accessKeyId: 'AKIA', secretAccessKey: 'shh' });
  });

  it('removes a credential', async () => {
    const store = makeStore();
    const c = await store.save({ name: 'X', kind: 'generic', fields: { v: '1' } });
    const after = await store.remove(c.id);
    expect(after).toHaveLength(0);
    expect(await store.get(c.id)).toBeUndefined();
  });

  it('yields empty string for a field that cannot be decrypted (wrong key)', async () => {
    const { fs } = memFs();
    const store1 = createCredentialStore({
      dir: '/tmp/creds',
      fs,
      encryptionKey: Buffer.alloc(32, 1),
      newId: () => 'fixed',
    });
    await store1.save({ name: 'X', kind: 'token', fields: { t: 'value' } });
    // A second store with a DIFFERENT key reading the same fs cannot decrypt.
    const store2 = createCredentialStore({ dir: '/tmp/creds', fs, encryptionKey: Buffer.alloc(32, 2) });
    const decrypted = await store2.getDecrypted('fixed');
    expect(decrypted).toEqual({ t: '' });
  });
});

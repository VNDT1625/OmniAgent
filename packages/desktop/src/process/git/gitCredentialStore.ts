/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `gitCredentialStore` — encrypted-at-rest storage for Git Personal Access
 * Tokens. The token plaintext is encrypted with Electron `safeStorage` (OS
 * keychain-backed when available) and written to `git-credentials.json` in
 * `userData`; only the encrypted blob touches disk. The metadata the renderer
 * sees ({@link GitCredential}) never carries the decrypted token — just a
 * 4-char hint so the user can recognise it.
 *
 * When `safeStorage` is unavailable (rare; some Linux setups without a keyring),
 * the store falls back to a base64 obfuscation and marks the record so the user
 * knows it is not OS-encrypted. The decrypted token is only ever handed to the
 * Main-process git runner (never to the renderer).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { app, safeStorage } from 'electron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { GitCredential } from './gitTypes';

const CREDENTIALS_FILE = 'git-credentials.json';

/** On-disk record: metadata + the encrypted token blob (base64). */
type StoredCredential = GitCredential & {
  /** Encrypted token (base64). Decrypted only in Main, never sent to renderer. */
  encryptedToken: string;
  /** Whether `encryptedToken` was produced by safeStorage (vs base64 fallback). */
  osEncrypted: boolean;
};

/** Injectable fs subset (for tests). */
export type CredentialFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
};

/** Injectable crypto seam so tests don't need a real OS keychain. */
export type CredentialCrypto = {
  isAvailable(): boolean;
  encrypt(plain: string): string; // returns base64
  decrypt(base64: string): string;
};

const defaultFs: CredentialFs = {
  readFile: (p, e) => fs.promises.readFile(p, e),
  writeFile: (p, d, o) => fs.promises.writeFile(p, d, o),
  rename: (a, b) => fs.promises.rename(a, b),
  mkdir: (d, o) => fs.promises.mkdir(d, o),
};

/** Default crypto: Electron safeStorage with a base64 fallback. */
const defaultCrypto: CredentialCrypto = {
  isAvailable: () => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  },
  encrypt: (plain) => {
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.encryptString(plain).toString('base64');
      }
    } catch {
      /* fall through */
    }
    return Buffer.from(plain, 'utf-8').toString('base64');
  },
  decrypt: (base64) => {
    const buf = Buffer.from(base64, 'base64');
    try {
      if (safeStorage.isEncryptionAvailable()) {
        return safeStorage.decryptString(buf);
      }
    } catch {
      /* fall through */
    }
    return buf.toString('utf-8');
  },
};

/** Options for {@link createGitCredentialStore}. */
export type CredentialStoreOptions = {
  dir?: string;
  fs?: CredentialFs;
  crypto?: CredentialCrypto;
  now?: () => number;
  newId?: () => string;
};

/** Public contract of the credential store. */
export type IGitCredentialStore = {
  /** List credential metadata (never the decrypted tokens). */
  list(): Promise<GitCredential[]>;
  /** Add a credential; the token is encrypted at rest. Returns its metadata. */
  add(input: { label: string; host: string; username: string; token: string }): Promise<GitCredential>;
  /** Remove a credential by id. */
  remove(id: string): Promise<void>;
  /** Decrypt and return a credential's token + username (Main-only). */
  resolve(id: string): Promise<{ username: string; token: string } | null>;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isFileNotFound = (e: unknown): boolean => (e as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/**
 * Create an encrypted git-credential store rooted at `dir` (defaults to
 * userData). Tokens are encrypted with safeStorage when available.
 */
export const createGitCredentialStore = (options?: CredentialStoreOptions): IGitCredentialStore => {
  const now = options?.now ?? Date.now;
  const newId = options?.newId ?? randomUUID;
  const fsImpl = options?.fs ?? defaultFs;
  const crypto = options?.crypto ?? defaultCrypto;
  const dir = options?.dir ?? app.getPath('userData');
  const filePath = path.join(dir, CREDENTIALS_FILE);

  let cache: StoredCredential[] = [];
  let loaded = false;

  const load = async (): Promise<void> => {
    try {
      const raw = await fsImpl.readFile(filePath, 'utf-8');
      const parsed = JSON.parse(raw) as unknown;
      cache = Array.isArray(parsed) ? parsed.filter(isStored) : [];
    } catch (error) {
      if (!isFileNotFound(error)) console.warn('[GitCredentialStore] read failed; using empty list:', error);
      cache = [];
    }
    loaded = true;
  };

  const isStored = (v: unknown): v is StoredCredential =>
    isObject(v) && typeof v.id === 'string' && typeof v.encryptedToken === 'string' && typeof v.host === 'string';

  const ensureLoaded = async (): Promise<void> => {
    if (!loaded) await load();
  };

  const persist = async (next: StoredCredential[]): Promise<void> => {
    cache = next;
    const tmpPath = `${filePath}.tmp`;
    await fsImpl.mkdir(path.dirname(filePath), { recursive: true });
    await fsImpl.writeFile(tmpPath, JSON.stringify(next, null, 2) + '\n', { encoding: 'utf-8', mode: 0o600 });
    await fsImpl.rename(tmpPath, filePath);
  };

  /** Strip the secret fields → renderer-safe metadata. */
  const toMeta = (c: StoredCredential): GitCredential => ({
    id: c.id,
    label: c.label,
    host: c.host,
    username: c.username,
    tokenHint: c.tokenHint,
    createdAt: c.createdAt,
  });

  return {
    async list() {
      await ensureLoaded();
      return cache.map(toMeta);
    },

    async add(input) {
      await ensureLoaded();
      const token = input.token.trim();
      const stored: StoredCredential = {
        id: newId(),
        label: input.label.trim() || input.host,
        host: input.host.trim(),
        username: input.username.trim() || 'token',
        tokenHint: token.length >= 4 ? token.slice(-4) : '••••',
        createdAt: now(),
        encryptedToken: crypto.encrypt(token),
        osEncrypted: crypto.isAvailable(),
      };
      await persist([...cache, stored]);
      return toMeta(stored);
    },

    async remove(id) {
      await ensureLoaded();
      await persist(cache.filter((c) => c.id !== id));
    },

    async resolve(id) {
      await ensureLoaded();
      const found = cache.find((c) => c.id === id);
      if (!found) return null;
      try {
        return { username: found.username, token: crypto.decrypt(found.encryptedToken) };
      } catch {
        return null;
      }
    },
  };
};

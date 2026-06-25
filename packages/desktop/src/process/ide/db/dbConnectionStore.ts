/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `dbConnectionStore` — persists database connection definitions for the IDE
 * Database surface. ONE file, two trust levels inside it:
 *
 *   - **Non-secret fields** (name, kind, host, port, database, user, flags) are
 *     stored as plain JSON in `<userData>/ide-databases/connections.json`.
 *   - **The password** is encrypted at rest with Electron `safeStorage`
 *     (OS-keychain-backed when available) and kept as an opaque base64 blob in
 *     the same record (`encryptedPassword`). The plaintext password NEVER
 *     touches disk and is only ever decrypted in the Main process when opening a
 *     connection. This mirrors the project's git-credential store rather than
 *     relying on the fragile native `keytar` addon.
 *
 * When `safeStorage` is unavailable (rare; a Linux box with no keyring), the
 * crypto seam falls back to base64 obfuscation and flags the record so it is
 * clear the value is not OS-encrypted. All Electron/OS-touching pieces are
 * injected so the store is unit-testable with in-memory fakes.
 *
 * Process boundary: Main-process (Node.js) module.
 */

import type { DbConnectionConfig } from './dbTypes';

/** Minimal filesystem surface the store needs (injected; real = node:fs/promises). */
export type DbStoreFs = {
  readFile: (path: string) => Promise<string>;
  writeFile: (path: string, data: string) => Promise<void>;
  mkdir: (dir: string) => Promise<void>;
};

/**
 * Crypto seam for encrypting the password at rest. Real implementation wraps
 * Electron `safeStorage`; tests inject a fake. `encrypt`/`decrypt` round-trip a
 * base64 string.
 */
export type DbCrypto = {
  isAvailable: () => boolean;
  encrypt: (plain: string) => string;
  decrypt: (base64: string) => string;
};

/** Injected collaborators for {@link createDbConnectionStore}. */
export type DbConnectionStoreDeps = {
  /** Absolute path of the connections JSON file. */
  filePath: string;
  /** Directory the JSON file lives in (created on first write). */
  dir: string;
  /** Filesystem primitives. */
  fs: DbStoreFs;
  /** Password crypto. When omitted, passwords are not persisted (user re-enters). */
  crypto?: DbCrypto;
};

/** The public store contract. */
export type DbConnectionStore = {
  /** List all saved connections (without passwords). */
  list: () => Promise<DbConnectionConfig[]>;
  /** Add or update a connection. Password (if present) is encrypted at rest. */
  upsert: (config: DbConnectionConfig) => Promise<void>;
  /** Remove a connection (+ its encrypted password). */
  remove: (id: string) => Promise<void>;
  /** Resolve a connection by id WITH its decrypted password. */
  resolve: (id: string) => Promise<DbConnectionConfig | null>;
};

/** On-disk shape: the public config (no plaintext password) + encrypted blob. */
type StoredConnection = Omit<DbConnectionConfig, 'password'> & {
  /** Encrypted password (base64). Decrypted only in Main; never sent to renderer. */
  encryptedPassword?: string;
  /** Whether `encryptedPassword` was produced by OS encryption (vs base64 fallback). */
  osEncrypted?: boolean;
};

/** Strip secret fields → the renderer-safe public config. */
const toPublic = (stored: StoredConnection): DbConnectionConfig => {
  const {
    encryptedPassword: _enc,
    osEncrypted: _os,
    password: _pw,
    ...rest
  } = stored as StoredConnection & {
    password?: string;
  };
  return rest;
};

/**
 * Create a {@link DbConnectionStore} from injected deps. The JSON file holds a
 * `{ connections: StoredConnection[] }` envelope (passwords encrypted, never
 * plaintext).
 */
export const createDbConnectionStore = (deps: DbConnectionStoreDeps): DbConnectionStore => {
  const readAll = async (): Promise<StoredConnection[]> => {
    try {
      const text = await deps.fs.readFile(deps.filePath);
      const parsed = JSON.parse(text) as { connections?: StoredConnection[] };
      return Array.isArray(parsed.connections) ? parsed.connections : [];
    } catch {
      return [];
    }
  };

  const writeAll = async (connections: StoredConnection[]): Promise<void> => {
    await deps.fs.mkdir(deps.dir).catch((): undefined => undefined);
    const payload = JSON.stringify({ connections }, null, 2);
    await deps.fs.writeFile(deps.filePath, payload);
  };

  const list: DbConnectionStore['list'] = async () => (await readAll()).map(toPublic);

  const upsert: DbConnectionStore['upsert'] = async (config) => {
    const all = await readAll();
    const idx = all.findIndex((c) => c.id === config.id);
    const base = toPublic({ ...config });
    // Preserve a previously-stored password when the caller omits a new one
    // (the edit form leaves the field blank to "keep current").
    const prior = idx >= 0 ? all[idx] : undefined;
    const stored: StoredConnection = { ...base };
    if (config.password && deps.crypto) {
      stored.encryptedPassword = deps.crypto.encrypt(config.password);
      stored.osEncrypted = deps.crypto.isAvailable();
    } else if (prior?.encryptedPassword) {
      stored.encryptedPassword = prior.encryptedPassword;
      stored.osEncrypted = prior.osEncrypted;
    }
    if (idx >= 0) all[idx] = stored;
    else all.push(stored);
    await writeAll(all);
  };

  const remove: DbConnectionStore['remove'] = async (id) => {
    const all = await readAll();
    await writeAll(all.filter((c) => c.id !== id));
  };

  const resolve: DbConnectionStore['resolve'] = async (id) => {
    const all = await readAll();
    const found = all.find((c) => c.id === id);
    if (!found) return null;
    const config = toPublic(found);
    if (found.encryptedPassword && deps.crypto) {
      try {
        config.password = deps.crypto.decrypt(found.encryptedPassword);
      } catch {
        /* leave password unset — user re-enters */
      }
    }
    return config;
  };

  return { list, upsert, remove, resolve };
};

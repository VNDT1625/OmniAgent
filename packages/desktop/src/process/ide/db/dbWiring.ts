/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wires the IDE Database service singleton for the Main process. Assembles the
 * real {@link DbConnectionStore} (JSON under `userData`, password encrypted at
 * rest via safeStorage) and
 * the per-engine driver factory map, then builds ONE {@link DbService} both
 * planes share (UI bridge + agent MCP server).
 *
 * The password crypto uses Electron `safeStorage` (OS-keychain-backed) with a
 * base64 fallback when no keyring is available — the same secure pattern as the
 * git-credential store, and free of the fragile native `keytar` addon.
 *
 * Process boundary: Main-process (Node.js / Electron) module — no DOM APIs.
 */

import { app, safeStorage } from 'electron';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { createDbConnectionStore, type DbCrypto } from './dbConnectionStore';
import { createDbService, type DbService } from './dbService';
import { createSqliteDriver } from './drivers/sqliteDriver';
import { createPostgresDriver } from './drivers/postgresDriver';
import { createMysqlDriver } from './drivers/mysqlDriver';
import { createD1Driver } from './drivers/d1Driver';
import { createFirestoreDriver } from './drivers/firestoreDriver';

/** Resolve the directory that holds the connections JSON. */
const resolveDbDir = (): string => path.join(app.getPath('userData'), 'ide-databases');

/** Password crypto backed by Electron safeStorage, with a base64 fallback. */
const safeStorageCrypto: DbCrypto = {
  isAvailable: () => {
    try {
      return safeStorage.isEncryptionAvailable();
    } catch {
      return false;
    }
  },
  encrypt: (plain) => {
    try {
      if (safeStorage.isEncryptionAvailable()) return safeStorage.encryptString(plain).toString('base64');
    } catch {
      /* fall through to base64 */
    }
    return Buffer.from(plain, 'utf-8').toString('base64');
  },
  decrypt: (base64) => {
    const buf = Buffer.from(base64, 'base64');
    try {
      if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(buf);
    } catch {
      /* fall through to base64 */
    }
    return buf.toString('utf-8');
  },
};

/** Lazily-built shared service. */
let service: DbService | undefined;

/**
 * Build (once) and return the Main-process Database service. Safe to call
 * before the window exists.
 */
export const getDbService = (): DbService => {
  if (service) return service;
  const dir = resolveDbDir();
  const store = createDbConnectionStore({
    filePath: path.join(dir, 'connections.json'),
    dir,
    fs: {
      readFile: (p) => fsp.readFile(p, 'utf-8'),
      writeFile: (p, data) => fsp.writeFile(p, data, 'utf-8'),
      mkdir: async (d) => {
        await fsp.mkdir(d, { recursive: true });
      },
    },
    crypto: safeStorageCrypto,
  });
  service = createDbService({
    store,
    drivers: {
      sqlite: createSqliteDriver,
      postgres: createPostgresDriver,
      mysql: createMysqlDriver,
      d1: (config) => createD1Driver(config),
      firestore: (config) => createFirestoreDriver(config),
    },
  });
  return service;
};

/** Reset the singleton + close every live connection (deterministic teardown). */
export const disposeDbService = async (): Promise<void> => {
  if (service) await service.closeAll().catch((): undefined => undefined);
  service = undefined;
};

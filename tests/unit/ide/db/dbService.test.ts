/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the DB service + connection store, using a fake driver +
 * in-memory store fakes (no real sqlite/pg/mysql).
 */

import { describe, expect, it, vi } from 'vitest';
import { createDbService, type DbDriverFactory } from '@/process/ide/db/dbService';
import { createDbConnectionStore, type DbCrypto, type DbStoreFs } from '@/process/ide/db/dbConnectionStore';
import type { DbConnectionStore } from '@/process/ide/db/dbConnectionStore';
import type { DbDriver } from '@/process/ide/db/dbDriver';
import type { DbConnectionConfig } from '@/process/ide/db/dbTypes';

/** In-memory fs fake backing the JSON store. */
const makeFakeFs = (): DbStoreFs & { dump: () => string | undefined } => {
  let content: string | undefined;
  return {
    readFile: async () => {
      if (content === undefined) throw new Error('ENOENT');
      return content;
    },
    writeFile: async (_p, data) => {
      content = data;
    },
    mkdir: async () => undefined,
    dump: () => content,
  };
};

/** In-memory crypto fake (reversible base64) standing in for safeStorage. */
const makeFakeCrypto = (available = true): DbCrypto => ({
  isAvailable: () => available,
  encrypt: (plain) => `enc:${Buffer.from(plain, 'utf-8').toString('base64')}`,
  decrypt: (blob) => Buffer.from(blob.replace(/^enc:/, ''), 'base64').toString('utf-8'),
});

const sqliteConfig = (over: Partial<DbConnectionConfig> = {}): DbConnectionConfig => ({
  id: 'c1',
  name: 'Test',
  kind: 'sqlite',
  file: '/repo/dev.db',
  readOnly: true,
  ...over,
});

describe('dbConnectionStore', () => {
  it('persists config without the plaintext password but keeps an encrypted blob', async () => {
    const fs = makeFakeFs();
    const crypto = makeFakeCrypto();
    const store = createDbConnectionStore({ filePath: '/x.json', dir: '/', fs, crypto });

    await store.upsert(sqliteConfig({ kind: 'postgres', file: undefined, host: 'h', password: 's3cret' }));
    // JSON on disk must NOT contain the plaintext password.
    expect(fs.dump()).not.toContain('s3cret');
    // It must contain the encrypted blob instead.
    expect(fs.dump()).toContain('enc:');

    // resolve() decrypts the password back.
    const resolved = await store.resolve('c1');
    expect(resolved?.password).toBe('s3cret');
    // list() never exposes the password or the encrypted blob.
    const listed = await store.list();
    expect(listed[0]).not.toHaveProperty('password');
    expect(listed[0]).not.toHaveProperty('encryptedPassword');
  });

  it('keeps the prior password when an edit omits a new one', async () => {
    const fs = makeFakeFs();
    const crypto = makeFakeCrypto();
    const store = createDbConnectionStore({ filePath: '/x.json', dir: '/', fs, crypto });
    await store.upsert(sqliteConfig({ kind: 'postgres', file: undefined, host: 'h', password: 'keepme' }));
    // Edit with no password (blank field) — must retain the encrypted blob.
    await store.upsert(sqliteConfig({ kind: 'postgres', file: undefined, host: 'h2' }));
    const resolved = await store.resolve('c1');
    expect(resolved?.password).toBe('keepme');
    expect(resolved?.host).toBe('h2');
  });

  it('removes the connection (+ its encrypted password)', async () => {
    const fs = makeFakeFs();
    const crypto = makeFakeCrypto();
    const store = createDbConnectionStore({ filePath: '/x.json', dir: '/', fs, crypto });
    await store.upsert(sqliteConfig({ password: 'p' }));
    await store.remove('c1');
    expect(await store.list()).toEqual([]);
  });
});

/** Build a fake driver that records calls + returns canned data. */
const makeFakeDriver = (): DbDriver & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    connect: vi.fn(async () => {
      calls.push('connect');
    }),
    getSchema: vi.fn(async () => ({ kind: 'sqlite' as const, tables: [{ name: 'users', type: 'table' as const }] })),
    getColumns: vi.fn(async () => [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }]),
    getIndexes: vi.fn(async () => [{ name: 'pk', columns: ['id'], unique: true, primary: true }]),
    getForeignKeys: vi.fn(async () => [
      { name: 'fk', columns: ['org_id'], referencedTable: 'orgs', referencedColumns: ['id'] },
    ]),
    query: vi.fn(async () => ({ columns: ['id'], rows: [[1]], durationMs: 1, truncated: false })),
    close: vi.fn(async () => {
      calls.push('close');
    }),
  };
};

/** A store fake that resolves a fixed config. */
const makeStoreStub = (config: DbConnectionConfig): DbConnectionStore => ({
  list: async () => [config],
  upsert: async () => undefined,
  remove: async () => undefined,
  resolve: async (id) => (id === config.id ? config : null),
});

describe('dbService', () => {
  it('opens the driver lazily and caches it across calls', async () => {
    const driver = makeFakeDriver();
    const factory: DbDriverFactory = () => driver;
    const service = createDbService({
      store: makeStoreStub(sqliteConfig()),
      drivers: { sqlite: factory, postgres: factory, mysql: factory },
    });

    await service.listTables('c1');
    await service.query('c1', 'SELECT 1');
    // connect() called exactly once (cached driver).
    expect(driver.connect).toHaveBeenCalledTimes(1);
    expect(driver.query).toHaveBeenCalledTimes(1);
  });

  it('reports connected state in the connection list', async () => {
    const driver = makeFakeDriver();
    const factory: DbDriverFactory = () => driver;
    const service = createDbService({
      store: makeStoreStub(sqliteConfig()),
      drivers: { sqlite: factory, postgres: factory, mysql: factory },
    });

    let conns = await service.listConnections();
    expect(conns[0].connected).toBe(false);
    await service.connect('c1');
    conns = await service.listConnections();
    expect(conns[0].connected).toBe(true);
  });

  it('testConnection opens + closes a throwaway driver and reports ok', async () => {
    const driver = makeFakeDriver();
    const factory: DbDriverFactory = () => driver;
    const service = createDbService({
      store: makeStoreStub(sqliteConfig()),
      drivers: { sqlite: factory, postgres: factory, mysql: factory },
    });
    const res = await service.testConnection(sqliteConfig());
    expect(res.ok).toBe(true);
    expect(driver.close).toHaveBeenCalled();
  });

  it('discards the driver when connect throws so the next attempt is clean', async () => {
    let attempt = 0;
    const factory: DbDriverFactory = () => ({
      connect: vi.fn(async () => {
        attempt += 1;
        if (attempt === 1) throw new Error('boom');
      }),
      getSchema: vi.fn(async () => ({ kind: 'sqlite' as const, tables: [] })),
      getColumns: vi.fn(async () => []),
      getIndexes: vi.fn(async () => []),
      getForeignKeys: vi.fn(async () => []),
      query: vi.fn(async () => ({ columns: [], rows: [], durationMs: 0, truncated: false })),
      close: vi.fn(async () => undefined),
    });
    const service = createDbService({
      store: makeStoreStub(sqliteConfig()),
      drivers: { sqlite: factory, postgres: factory, mysql: factory },
    });
    await expect(service.connect('c1')).rejects.toThrow('boom');
    // Second attempt builds a fresh driver and succeeds.
    await expect(service.connect('c1')).resolves.toBeUndefined();
  });

  it('getTableDetail aggregates columns + indexes + foreign keys', async () => {
    const driver = makeFakeDriver();
    const factory: DbDriverFactory = () => driver;
    const service = createDbService({
      store: makeStoreStub(sqliteConfig()),
      drivers: { sqlite: factory, postgres: factory, mysql: factory },
    });
    const detail = await service.getTableDetail('c1', 'users');
    expect(detail.columns).toHaveLength(1);
    expect(detail.indexes[0]?.primary).toBe(true);
    expect(detail.foreignKeys[0]?.referencedTable).toBe('orgs');
  });

  it('getSchemaGraph returns tables with their columns + foreign keys', async () => {
    const driver = makeFakeDriver();
    const factory: DbDriverFactory = () => driver;
    const service = createDbService({
      store: makeStoreStub(sqliteConfig()),
      drivers: { sqlite: factory, postgres: factory, mysql: factory },
    });
    const graph = await service.getSchemaGraph('c1');
    expect(graph.kind).toBe('sqlite');
    expect(graph.truncated).toBe(false);
    expect(graph.tables).toHaveLength(1);
    expect(graph.tables[0]).toMatchObject({ name: 'users', type: 'table' });
    expect(graph.tables[0].columns).toHaveLength(1);
    expect(graph.tables[0].foreignKeys[0]?.referencedTable).toBe('orgs');
  });

  it('queryScript runs each statement in order', async () => {
    const driver = makeFakeDriver();
    const factory: DbDriverFactory = () => driver;
    const service = createDbService({
      store: makeStoreStub(sqliteConfig()),
      drivers: { sqlite: factory, postgres: factory, mysql: factory },
    });
    const res = await service.queryScript('c1', 'SELECT 1; SELECT 2; SELECT 3;');
    expect(res.statements).toHaveLength(3);
    expect(res.aborted).toBe(false);
    expect(driver.query).toHaveBeenCalledTimes(3);
  });

  it('queryScript stops at the first failing statement and flags aborted', async () => {
    let n = 0;
    const factory: DbDriverFactory = () => ({
      connect: vi.fn(async () => undefined),
      getSchema: vi.fn(async () => ({ kind: 'sqlite' as const, tables: [] })),
      getColumns: vi.fn(async () => []),
      getIndexes: vi.fn(async () => []),
      getForeignKeys: vi.fn(async () => []),
      query: vi.fn(async () => {
        n += 1;
        if (n === 2) throw new Error('syntax error');
        return { columns: ['x'], rows: [[n]], durationMs: 0, truncated: false };
      }),
      close: vi.fn(async () => undefined),
    });
    const service = createDbService({
      store: makeStoreStub(sqliteConfig()),
      drivers: { sqlite: factory, postgres: factory, mysql: factory },
    });
    const res = await service.queryScript('c1', 'SELECT 1; BOOM; SELECT 3;');
    expect(res.aborted).toBe(true);
    expect(res.statements).toHaveLength(2);
    expect(res.statements[1]?.error).toMatch(/syntax error/);
  });
});

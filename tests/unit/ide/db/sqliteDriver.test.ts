/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Integration tests for the SQLite driver against a REAL better-sqlite3 file
 * (created in a temp dir). Skipped gracefully if the native module can't load.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSqliteDriver } from '@/process/ide/db/drivers/sqliteDriver';
import type { DbConnectionConfig } from '@/process/ide/db/dbTypes';

/**
 * Probe better-sqlite3 by actually opening an in-memory DB. The native binding
 * is rebuilt for Electron's ABI (postinstall), so under the plain-Node vitest
 * runner `require` succeeds but `new Database` throws NODE_MODULE_VERSION. We
 * skip the real-driver suite in that case (it runs in the Electron-ABI CI lane).
 */
let sqliteAvailable = true;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const Database = require('better-sqlite3') as new (p: string) => { close: () => void };
  const probe = new Database(':memory:');
  probe.close();
} catch {
  sqliteAvailable = false;
}

const d = sqliteAvailable ? describe : describe.skip;

d('sqliteDriver (real better-sqlite3)', () => {
  let dir: string;
  let dbPath: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'aionui-db-'));
    dbPath = join(dir, 'seed.db');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3') as new (p: string) => {
      exec: (sql: string) => void;
      close: () => void;
    };
    const seed = new Database(dbPath);
    seed.exec(`CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT);
               CREATE UNIQUE INDEX idx_users_email ON users (email);
               INSERT INTO users (name, email) VALUES ('Ada', 'ada@x.io'), ('Linus', NULL);
               CREATE VIEW active AS SELECT * FROM users;
               CREATE TABLE posts (id INTEGER PRIMARY KEY, user_id INTEGER REFERENCES users(id), title TEXT);`);
    seed.close();
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const config = (over: Partial<DbConnectionConfig> = {}): DbConnectionConfig => ({
    id: 's',
    name: 'seed',
    kind: 'sqlite',
    file: dbPath,
    readOnly: true,
    ...over,
  });

  it('lists tables + views', async () => {
    const driver = createSqliteDriver(config());
    await driver.connect();
    const schema = await driver.getSchema();
    const names = schema.tables.map((t) => `${t.type}:${t.name}`).toSorted();
    expect(names).toEqual(['table:posts', 'table:users', 'view:active']);
    await driver.close();
  });

  it('describes columns including primary key + nullability', async () => {
    const driver = createSqliteDriver(config());
    await driver.connect();
    const cols = await driver.getColumns('users');
    const id = cols.find((c) => c.name === 'id');
    const email = cols.find((c) => c.name === 'email');
    expect(id?.primaryKey).toBe(true);
    expect(email?.nullable).toBe(true);
    await driver.close();
  });

  it('runs a SELECT and returns rows with NULLs normalised', async () => {
    const driver = createSqliteDriver(config());
    await driver.connect();
    const res = await driver.query('SELECT name, email FROM users ORDER BY id');
    expect(res.columns).toEqual(['name', 'email']);
    expect(res.rows).toEqual([
      ['Ada', 'ada@x.io'],
      ['Linus', null],
    ]);
    await driver.close();
  });

  it('enforces the read-only guard', async () => {
    const driver = createSqliteDriver(config({ readOnly: true }));
    await driver.connect();
    await expect(driver.query("INSERT INTO users (name) VALUES ('x')")).rejects.toThrow(/read-only/i);
    await driver.close();
  });

  it('allows writes when read-only is off', async () => {
    const driver = createSqliteDriver(config({ id: 'w', readOnly: false }));
    await driver.connect();
    const res = await driver.query("INSERT INTO users (name) VALUES ('Grace')");
    expect(res.rowsAffected).toBe(1);
    await driver.close();
  });

  it('caps returned rows + flags truncation', async () => {
    const driver = createSqliteDriver(config());
    await driver.connect();
    const res = await driver.query('SELECT * FROM users', { maxRows: 1 });
    expect(res.rows.length).toBe(1);
    expect(res.truncated).toBe(true);
    await driver.close();
  });

  it('introspects indexes including the unique email index', async () => {
    const driver = createSqliteDriver(config());
    await driver.connect();
    const indexes = await driver.getIndexes('users');
    const email = indexes.find((i) => i.columns.includes('email'));
    expect(email?.unique).toBe(true);
    await driver.close();
  });

  it('introspects foreign keys on the posts table', async () => {
    const driver = createSqliteDriver(config());
    await driver.connect();
    const fks = await driver.getForeignKeys('posts');
    expect(fks).toHaveLength(1);
    expect(fks[0]).toMatchObject({ columns: ['user_id'], referencedTable: 'users', referencedColumns: ['id'] });
    await driver.close();
  });
});

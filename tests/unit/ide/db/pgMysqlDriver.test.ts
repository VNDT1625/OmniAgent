/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the Postgres + MySQL drivers using INJECTED fake modules — no
 * real database engine needed. Exercises the read-only guard, row cap /
 * truncation, result shaping, and index / foreign-key introspection grouping.
 */

import { describe, expect, it, vi } from 'vitest';
import { createPostgresDriver, type PgModule } from '@/process/ide/db/drivers/postgresDriver';
import { createMysqlDriver, type MysqlModule } from '@/process/ide/db/drivers/mysqlDriver';
import type { DbConnectionConfig } from '@/process/ide/db/dbTypes';

const pgConfig = (over: Partial<DbConnectionConfig> = {}): DbConnectionConfig => ({
  id: 'p',
  name: 'pg',
  kind: 'postgres',
  host: 'h',
  port: 5432,
  database: 'd',
  user: 'u',
  readOnly: true,
  ...over,
});
const myConfig = (over: Partial<DbConnectionConfig> = {}): DbConnectionConfig => ({
  id: 'm',
  name: 'my',
  kind: 'mysql',
  host: 'h',
  port: 3306,
  database: 'd',
  user: 'u',
  readOnly: true,
  ...over,
});

/** Build a fake `pg` module whose Pool answers from a SQL→response map. */
const fakePg = (
  responder: (text: string) => { fields: Array<{ name: string }>; rows: unknown[]; rowCount: number | null }
): PgModule & { ended: boolean } => {
  const state = { ended: false };
  const mod = {
    ended: false,
    Pool: class {
      async query(cfg: { text: string }) {
        return { command: 'SELECT', ...responder(cfg.text) };
      }
      async end() {
        state.ended = true;
        mod.ended = true;
      }
    },
  } as unknown as PgModule & { ended: boolean };
  return mod;
};

describe('postgresDriver (fake pg)', () => {
  it('runs a SELECT 1 connectivity probe on connect', async () => {
    const probe = vi.fn((_t: string) => ({ fields: [], rows: [], rowCount: 1 }));
    const driver = createPostgresDriver(pgConfig(), () => fakePg(probe));
    await driver.connect();
    expect(probe).toHaveBeenCalledWith('SELECT 1');
    await driver.close();
  });

  it('rejects writes on a read-only connection', async () => {
    const driver = createPostgresDriver(pgConfig(), () => fakePg(() => ({ fields: [], rows: [], rowCount: 0 })));
    await driver.connect();
    await expect(driver.query('UPDATE users SET x = 1')).rejects.toThrow(/read-only/i);
    await driver.close();
  });

  it('caps rows + flags truncation and normalizes cells', async () => {
    const driver = createPostgresDriver(pgConfig(), () =>
      fakePg(() => ({ fields: [{ name: 'n' }], rows: [[1], [2], [3]], rowCount: 3 }))
    );
    await driver.connect();
    const res = await driver.query('SELECT n FROM t', { maxRows: 2 });
    expect(res.columns).toEqual(['n']);
    expect(res.rows).toEqual([[1], [2]]);
    expect(res.truncated).toBe(true);
    await driver.close();
  });

  it('groups multi-row index + foreign-key introspection', async () => {
    const driver = createPostgresDriver(pgConfig(), () =>
      fakePg((text) => {
        if (text.includes('pg_index')) {
          return {
            fields: [],
            rowCount: 2,
            rows: [
              { name: 'users_pkey', is_unique: true, is_primary: true, column_name: 'id' },
              { name: 'users_email_idx', is_unique: true, is_primary: false, column_name: 'email' },
            ],
          };
        }
        if (text.includes('FOREIGN KEY')) {
          return {
            fields: [],
            rowCount: 2,
            rows: [
              { name: 'fk_org', column_name: 'org_id', ref_schema: 'public', ref_table: 'orgs', ref_column: 'id' },
              { name: 'fk_org', column_name: 'tenant', ref_schema: 'public', ref_table: 'orgs', ref_column: 'tenant' },
            ],
          };
        }
        return { fields: [], rows: [], rowCount: 0 };
      })
    );
    await driver.connect();
    const indexes = await driver.getIndexes('users');
    expect(indexes).toHaveLength(2);
    expect(indexes[0]).toMatchObject({ name: 'users_pkey', primary: true, unique: true, columns: ['id'] });
    const fks = await driver.getForeignKeys('users');
    expect(fks).toHaveLength(1);
    expect(fks[0]).toMatchObject({
      columns: ['org_id', 'tenant'],
      referencedTable: 'orgs',
      referencedColumns: ['id', 'tenant'],
    });
    await driver.close();
  });
});

/** Build a fake `mysql2/promise` module whose pool answers from a SQL responder. */
const fakeMysql = (responder: (sql: string) => [unknown, Array<{ name: string }> | undefined]): MysqlModule => ({
  createPool: () => ({
    query: async (opts: { sql: string }) => responder(opts.sql),
    end: async () => undefined,
  }),
});

describe('mysqlDriver (fake mysql2)', () => {
  it('runs a SELECT 1 probe on connect and rejects writes when read-only', async () => {
    const probe = vi.fn((_sql: string) => [[], undefined] as [unknown, undefined]);
    const driver = createMysqlDriver(myConfig(), () => fakeMysql(probe));
    await driver.connect();
    expect(probe).toHaveBeenCalledWith('SELECT 1');
    await expect(driver.query('DELETE FROM t')).rejects.toThrow(/read-only/i);
    await driver.close();
  });

  it('shapes a row-returning query with truncation', async () => {
    const driver = createMysqlDriver(myConfig(), () => fakeMysql(() => [[[1], [2], [3]], [{ name: 'n' }]]));
    await driver.connect();
    const res = await driver.query('SELECT n FROM t', { maxRows: 1 });
    expect(res.columns).toEqual(['n']);
    expect(res.rows).toEqual([[1]]);
    expect(res.truncated).toBe(true);
    await driver.close();
  });

  it('reports affected rows for a write when read-only is off', async () => {
    const driver = createMysqlDriver(myConfig({ readOnly: false }), () =>
      fakeMysql(() => [{ affectedRows: 5 }, undefined])
    );
    await driver.connect();
    const res = await driver.query('INSERT INTO t VALUES (1)');
    expect(res.rowsAffected).toBe(5);
    await driver.close();
  });

  it('groups index introspection (PRIMARY flagged)', async () => {
    const driver = createMysqlDriver(myConfig(), () =>
      fakeMysql((sql) => {
        if (sql.includes('statistics')) {
          return [
            [
              { name: 'PRIMARY', nonUnique: 0, col: 'id', seq: 1 },
              { name: 'idx_email', nonUnique: 1, col: 'email', seq: 1 },
            ],
            undefined,
          ];
        }
        return [[], undefined];
      })
    );
    await driver.connect();
    const indexes = await driver.getIndexes('users');
    expect(indexes).toHaveLength(2);
    expect(indexes[0]).toMatchObject({ name: 'PRIMARY', primary: true, unique: true });
    expect(indexes[1]).toMatchObject({ name: 'idx_email', unique: false });
    await driver.close();
  });
});

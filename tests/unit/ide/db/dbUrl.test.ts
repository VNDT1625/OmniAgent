/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the connection-URL / DSN parser (Docker / cloud paste-in).
 */

import { describe, expect, it } from 'vitest';
import { parseDbUrl } from '@/process/ide/db/dbUrl';

describe('parseDbUrl', () => {
  it('parses a full postgres URL with credentials, port, db, and sslmode', () => {
    const c = parseDbUrl('postgresql://admin:p%40ss@db.example.com:6543/shop?sslmode=require');
    expect(c).toMatchObject({
      kind: 'postgres',
      host: 'db.example.com',
      port: 6543,
      database: 'shop',
      user: 'admin',
      password: 'p@ss', // URL-decoded
      ssl: true,
    });
  });

  it('defaults the postgres port to 5432 when omitted', () => {
    const c = parseDbUrl('postgres://localhost/app');
    expect(c).toMatchObject({ kind: 'postgres', host: 'localhost', port: 5432, database: 'app' });
  });

  it('parses a mysql/mariadb URL and disables ssl on sslmode=disable', () => {
    expect(parseDbUrl('mysql://root:root@127.0.0.1:3307/test')).toMatchObject({
      kind: 'mysql',
      host: '127.0.0.1',
      port: 3307,
      database: 'test',
      user: 'root',
      password: 'root',
    });
    expect(parseDbUrl('mariadb://u@h:3306/d?sslmode=disable')).toMatchObject({ kind: 'mysql', ssl: false });
  });

  it('parses sqlite URLs and bare sqlite file paths', () => {
    expect(parseDbUrl('sqlite:////var/data/app.db')).toMatchObject({ kind: 'sqlite', file: '/var/data/app.db' });
    expect(parseDbUrl('file:./dev.sqlite')).toMatchObject({ kind: 'sqlite', file: './dev.sqlite' });
    expect(parseDbUrl('/home/me/project/db.sqlite3')).toMatchObject({
      kind: 'sqlite',
      file: '/home/me/project/db.sqlite3',
    });
    expect(parseDbUrl('C:/repo/data.db')).toMatchObject({ kind: 'sqlite', file: 'C:/repo/data.db' });
  });

  it('returns null for unrecognised input', () => {
    expect(parseDbUrl('')).toBeNull();
    expect(parseDbUrl('just some text')).toBeNull();
    expect(parseDbUrl('redis://localhost:6379')).toBeNull();
  });
});

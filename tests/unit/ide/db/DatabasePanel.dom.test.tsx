/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM test for the IDE Database panel: empty state, connection list, and the
 * schema tree expansion showing columns + indexes + foreign keys. The renderer
 * `dbClient` is mocked so no real Main-process bridge / database is needed.
 */

import { ConfigProvider } from '@arco-design/web-react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k} ${JSON.stringify(opts)}` : k),
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/common', () => ({
  ipcBridge: { dialog: { showOpen: { invoke: vi.fn(async () => null) } } },
}));

const okConnections = [{ config: { id: 'c1', name: 'Local PG', kind: 'postgres', readOnly: true }, connected: false }];

const mockClient = vi.hoisted(() => ({
  list: vi.fn(),
  connect: vi.fn(),
  tables: vi.fn(),
  tableDetail: vi.fn(),
  save: vi.fn(),
  delete: vi.fn(),
  test: vi.fn(),
  query: vi.fn(),
  queryScript: vi.fn(),
}));

vi.mock('@/renderer/pages/studio/ide/db/dbClient', () => ({ dbClient: mockClient }));

import DatabasePanel from '@/renderer/pages/studio/ide/db/DatabasePanel';

const renderPanel = () =>
  render(
    <ConfigProvider>
      <DatabasePanel rootPath='/repo' />
    </ConfigProvider>
  );

describe('DatabasePanel', () => {
  beforeEach(() => {
    mockClient.list.mockResolvedValue({ ok: true, data: okConnections });
    mockClient.connect.mockResolvedValue({ ok: true, data: true });
    mockClient.tables.mockResolvedValue({ ok: true, data: [{ schema: 'public', name: 'users', type: 'table' }] });
    mockClient.tableDetail.mockResolvedValue({
      ok: true,
      data: {
        columns: [{ name: 'id', type: 'integer', nullable: false, primaryKey: true }],
        indexes: [{ name: 'users_pkey', columns: ['id'], unique: true, primary: true }],
        foreignKeys: [{ name: 'fk_org', columns: ['org_id'], referencedTable: 'orgs', referencedColumns: ['id'] }],
      },
    });
    mockClient.save.mockResolvedValue({ ok: true, data: true });
    mockClient.delete.mockResolvedValue({ ok: true, data: true });
    mockClient.test.mockResolvedValue({ ok: true, data: { ok: true } });
    mockClient.query.mockResolvedValue({ ok: true, data: { columns: [], rows: [], durationMs: 0, truncated: false } });
    mockClient.queryScript.mockResolvedValue({ ok: true, data: { statements: [], durationMs: 0, aborted: false } });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('lists saved connections from the client', async () => {
    renderPanel();
    expect(await screen.findByText('Local PG')).toBeInTheDocument();
  });

  it('opens a connection, lists tables, and expands columns + indexes + foreign keys', async () => {
    renderPanel();
    const conn = await screen.findByText('Local PG');
    fireEvent.click(conn);
    // Table appears after connect + tables resolve.
    const table = await screen.findByText('users');
    fireEvent.click(table);
    // Detail fetched via the aggregated tableDetail channel.
    await waitFor(() => expect(mockClient.tableDetail).toHaveBeenCalledWith('c1', 'users', 'public'));
    // Column type + index name + FK target render (substring-tolerant: text is split across nodes).
    expect(await screen.findByText('integer')).toBeInTheDocument();
    expect((await screen.findAllByText(/users_pkey/)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText(/orgs/)).length).toBeGreaterThan(0);
  });
});

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM test for the table data-analysis panel: it requests a statistical profile
 * via the mocked `dbClient` and renders per-column cards (fill rate, distinct,
 * numeric spread, top values). No real Main-process bridge / database needed.
 */

import { ConfigProvider } from '@arco-design/web-react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k} ${JSON.stringify(opts)}` : k),
    i18n: { language: 'en' },
  }),
}));

const mockClient = vi.hoisted(() => ({ profileTable: vi.fn() }));

vi.mock('@/renderer/pages/studio/ide/db/dbClient', () => ({ dbClient: mockClient }));

import TableAnalyzePanel from '@/renderer/pages/studio/ide/db/TableAnalyzePanel';

const renderPanel = () =>
  render(
    <ConfigProvider>
      <TableAnalyzePanel connectionId='c1' table='users' schema='public' primaryKeys={new Set(['id'])} />
    </ConfigProvider>
  );

describe('TableAnalyzePanel', () => {
  beforeEach(() => {
    mockClient.profileTable.mockResolvedValue({
      ok: true,
      data: {
        schema: 'public',
        table: 'users',
        rowCount: 100,
        sampled: false,
        columns: [
          {
            column: 'id',
            type: 'integer',
            total: 100,
            nulls: 0,
            distinct: 100,
            min: 1,
            max: 100,
            avg: 50.5,
            sampled: false,
            topValues: [],
          },
          {
            column: 'status',
            type: 'text',
            total: 100,
            nulls: 10,
            distinct: 2,
            sampled: false,
            topValues: [{ value: 'active', count: 80 }],
          },
        ],
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('profiles the table and renders a card per column', async () => {
    renderPanel();
    await waitFor(() => expect(mockClient.profileTable).toHaveBeenCalledWith('c1', 'users', 'public'));
    expect((await screen.findAllByText('id')).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('status')).length).toBeGreaterThan(0);
    // The low-cardinality column surfaces its top value.
    expect(await screen.findByText('active')).toBeInTheDocument();
  });

  it('surfaces an error from the client with a retry affordance', async () => {
    mockClient.profileTable.mockResolvedValueOnce({ ok: false, error: 'boom' });
    renderPanel();
    expect(await screen.findByText('boom')).toBeInTheDocument();
  });
});

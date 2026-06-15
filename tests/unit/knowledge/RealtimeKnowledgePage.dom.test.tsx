/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM tests for the Realtime Knowledge inspector page (Phase 4.2).
 *
 * Drives the real `useRealtimeKnowledge` hook against a mocked bridge client
 * (no IPC): verifies facts render with their value/freshness, the empty state,
 * the error/degraded state, and that a per-fact refresh round-trips through the
 * client stub.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from '@arco-design/web-react';
import type { KnowledgeFact } from '@/process/knowledge/realtime/rtkTypes';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts ? `${k} ${JSON.stringify(opts)}` : k),
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => true,
}));

const clientMocks = vi.hoisted(() => ({
  fetchFacts: vi.fn(),
  lookupFacts: vi.fn(),
  refreshFact: vi.fn(),
}));

vi.mock('@/renderer/pages/knowledge/realtimeKnowledgeBridgeClient', () => clientMocks);

import RealtimeKnowledgePage from '@/renderer/pages/knowledge/RealtimeKnowledgePage';

const fact = (over: Partial<KnowledgeFact> = {}): KnowledgeFact => ({
  id: 'f1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  topic: 'nodejs.lts.version',
  question: 'latest node lts?',
  aliases: [],
  value: '22.x',
  volatilityClass: 'version',
  ttlMs: 1000,
  validAsOf: '2026-01-01T00:00:00.000Z',
  expiresAt: '2030-01-02T00:00:00.000Z',
  sources: [{ url: 'https://nodejs.org', fetchedAt: '2026-01-01T00:00:00.000Z' }],
  confidence: 0.8,
  freshness: 'fresh',
  history: [],
  tags: [],
  embeddingText: '',
  status: 'active',
  ...over,
});

const renderPage = () =>
  render(
    <ConfigProvider>
      <RealtimeKnowledgePage />
    </ConfigProvider>
  );

beforeEach(() => {
  clientMocks.fetchFacts.mockReset();
  clientMocks.lookupFacts.mockReset();
  clientMocks.refreshFact.mockReset();
});

afterEach(() => cleanup());

describe('RealtimeKnowledgePage', () => {
  it('renders facts with their value once loaded', async () => {
    clientMocks.fetchFacts.mockResolvedValue({ ok: true, data: [fact()] });
    renderPage();
    expect(await screen.findByText('latest node lts?')).toBeTruthy();
    expect(screen.getByText('22.x')).toBeTruthy();
    expect(screen.getByText('nodejs.lts.version')).toBeTruthy();
  });

  it('shows the empty state when there are no facts', async () => {
    clientMocks.fetchFacts.mockResolvedValue({ ok: true, data: [] });
    renderPage();
    await waitFor(() => expect(screen.getByText('realtimeKnowledge.empty')).toBeTruthy());
  });

  it('shows the error/degraded state when the bridge is unavailable', async () => {
    clientMocks.fetchFacts.mockResolvedValue({ ok: false, error: 'unavailable' });
    renderPage();
    await waitFor(() => expect(screen.getByText('realtimeKnowledge.loadError')).toBeTruthy());
  });

  it('refreshes a fact via the client when its refresh button is clicked', async () => {
    clientMocks.fetchFacts.mockResolvedValue({ ok: true, data: [fact()] });
    clientMocks.refreshFact.mockResolvedValue({ ok: true, data: fact({ value: '24.x' }) });
    renderPage();
    await screen.findByText('latest node lts?');
    await userEvent.click(screen.getByText('realtimeKnowledge.card.refresh'));
    await waitFor(() => expect(clientMocks.refreshFact).toHaveBeenCalledWith('nodejs.lts.version'));
  });
});

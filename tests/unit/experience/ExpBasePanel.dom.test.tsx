/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM tests for ExpBasePanel — the IDE ExpBase mode. The renderer client is
 * mocked so rendering is exercised without IPC.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ConfigProvider } from '@arco-design/web-react';
import type { ExperienceEntry, ExperienceMetrics, ExperienceSuggestion } from '@/process/experience/experienceTypes';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => {
      if (!opts) return k;
      const parts = Object.entries(opts)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(',');
      return `${k}(${parts})`;
    },
    i18n: { language: 'en' },
  }),
}));

const list = vi.fn();
const metrics = vi.fn();
const search = vi.fn();
const feedback = vi.fn();
const forget = vi.fn();
vi.mock('@/renderer/pages/studio/ide/expbase/experienceClient', () => ({
  experienceClient: {
    list: (...a: unknown[]) => list(...a),
    metrics: (...a: unknown[]) => metrics(...a),
    search: (...a: unknown[]) => search(...a),
    feedback: (...a: unknown[]) => feedback(...a),
    forget: (...a: unknown[]) => forget(...a),
  },
}));

import ExpBasePanel from '@/renderer/pages/studio/ide/expbase/ExpBasePanel';

const entry = (overrides: Partial<ExperienceEntry> = {}): ExperienceEntry => ({
  id: 'e1',
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-08T00:00:00.000Z',
  projectId: 'p',
  kind: 'successful_fix',
  symptoms: { summary: 'boom bug here', errorMessages: [] },
  context: { repoArea: [], files: [], commands: [], frameworks: ['vitest'], packages: [] },
  lesson: 'do the thing',
  verification: { commands: [], confidenceEvidence: [] },
  tags: [],
  confidence: 0.8,
  relatedEntryIds: [],
  relations: [],
  embeddingText: '',
  status: 'active',
  ...overrides,
});

const emptyMetrics: ExperienceMetrics = {
  retrievals: 4,
  retrievalsWithHits: 3,
  suggestionsShown: 5,
  accepted: 2,
  falseMatches: 1,
  captures: 7,
  updatedAt: '',
};

const suggestion: ExperienceSuggestion = {
  entryId: 'e1',
  score: 0.82,
  kind: 'successful_fix',
  symptom: 'boom bug here',
  lesson: 'do the thing',
  whyRelevant: ['Same framework'],
  caution: ['Confirm context'],
  suggestedChecks: ['Run: bun run test'],
};

const renderPanel = (rootPath: string | null = '/repo') =>
  render(
    <ConfigProvider>
      <ExpBasePanel rootPath={rootPath} />
    </ConfigProvider>
  );

beforeEach(() => {
  list.mockReset();
  metrics.mockReset();
  search.mockReset();
  feedback.mockReset();
  forget.mockReset();
  list.mockResolvedValue({ ok: true, data: [entry()] });
  metrics.mockResolvedValue({ ok: true, data: emptyMetrics });
  search.mockResolvedValue({ ok: true, data: [suggestion] });
  feedback.mockResolvedValue({ ok: true, data: { updated: true } });
  forget.mockResolvedValue({ ok: true, data: { archived: true } });
});

afterEach(() => cleanup());

describe('ExpBasePanel', () => {
  it('shows the no-folder empty state and makes no client calls', () => {
    renderPanel(null);
    expect(screen.getByText('ide.expbase.noFolder')).toBeTruthy();
    expect(list).not.toHaveBeenCalled();
  });

  it('renders title, metrics, and the entry list after load', async () => {
    renderPanel('/repo');
    await waitFor(() => expect(screen.getByText('ide.expbase.title')).toBeTruthy());
    expect(screen.getByText('ide.expbase.metric.captured')).toBeTruthy();
    expect(screen.getByText('boom bug here')).toBeTruthy();
    expect(list).toHaveBeenCalledWith('/repo');
  });

  it('shows the empty state when there are no active entries', async () => {
    list.mockResolvedValue({ ok: true, data: [] });
    renderPanel('/repo');
    await waitFor(() => expect(screen.getByText('ide.expbase.empty')).toBeTruthy());
  });

  it('runs a search and shows suggestions with feedback affordances', async () => {
    renderPanel('/repo');
    await waitFor(() => expect(screen.getByText('ide.expbase.title')).toBeTruthy());

    const input = document.querySelector('input');
    expect(input).toBeTruthy();
    fireEvent.change(input as HTMLInputElement, { target: { value: 'boom' } });
    fireEvent.keyDown(input as HTMLInputElement, { key: 'Enter', keyCode: 13 });

    await waitFor(() => expect(search).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText('Same framework')).toBeTruthy());
    expect(screen.getByText('Run: bun run test')).toBeTruthy();
  });
});

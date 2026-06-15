/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM tests for the production-grade, persistent Wiki panel of the merged IDE
 * workspace.
 *
 * Focus: the panel's empty state invites generation; clicking "Generate" runs
 * the durable build (with the picked model + UI language) against a mocked
 * {@link useRepoWiki} stub; a built wiki renders its section titles in the
 * contents nav, its Markdown bodies, the "documentation check" report, and the
 * "saved" badge; the building phase strip and the build-error state render
 * without IPC or a model.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from '@arco-design/web-react';
import WikiPanel from '@/renderer/pages/studio/ide/components/WikiPanel';
import type { UseRepoWiki, WikiSectionState } from '@/renderer/pages/studio/ide/useRepoWiki';

// --- i18n: identity translator so assertions use raw key strings -------------
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => (opts && 'count' in opts ? `${k}:${opts.count}` : k),
    i18n: { language: 'en' },
  }),
}));

// --- Markdown view: render the raw text so the section body is assertable -----
vi.mock('@renderer/components/Markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid='md'>{children}</div>,
}));

// --- Model provider hook: one provider with one model ------------------------
vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({
  useModelProviderList: () => ({
    providers: [{ id: 'p1', models: ['gpt-test'] }],
    getAvailableModels: () => ['gpt-test'],
    formatModelLabel: (_p: unknown, m?: string) => m ?? '',
  }),
}));

/** Build a controllable {@link UseRepoWiki} stub. */
const makeWiki = (overrides: Partial<UseRepoWiki>): UseRepoWiki => ({
  status: 'idle',
  error: null,
  keyFiles: [],
  sections: [],
  docReports: [],
  quality: null,
  builtAt: null,
  persisted: false,
  phase: null,
  phaseDetail: null,
  activeIndex: -1,
  load: vi.fn(() => Promise.resolve()),
  build: vi.fn(() => Promise.resolve()),
  reset: vi.fn(),
  ...overrides,
});

const section = (id: string, status: WikiSectionState['status'], content = ''): WikiSectionState => ({
  plan: { id, titleKey: id },
  status,
  content,
  error: null,
});

const renderPanel = (wiki: UseRepoWiki, rootPath: string | null = '/repo') =>
  render(
    <ConfigProvider>
      <WikiPanel rootPath={rootPath} wiki={wiki} />
    </ConfigProvider>
  );

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('WikiPanel', () => {
  it('auto-loads the persisted wiki for the open folder on mount', () => {
    const wiki = makeWiki({ status: 'idle' });
    renderPanel(wiki);
    expect(wiki.load).toHaveBeenCalledWith('/repo');
  });

  it('shows the empty state and triggers build() with the picked model + language', async () => {
    const wiki = makeWiki({ status: 'idle' });
    renderPanel(wiki);

    expect(screen.getByText('ide.wiki.emptyTitle')).toBeTruthy();

    // Two "Generate" buttons (toolbar + body CTA); click the body one.
    const buttons = screen.getAllByText('ide.wiki.generate');
    await userEvent.click(buttons[buttons.length - 1]);

    expect(wiki.build).toHaveBeenCalledWith('/repo', 'gpt-test', 'en');
  });

  it('disables generation when no folder is open', () => {
    const wiki = makeWiki({ status: 'idle' });
    renderPanel(wiki, null);
    const generateButtons = screen.getAllByText('ide.wiki.generate').map((el) => el.closest('button'));
    expect(generateButtons.some((b) => b?.disabled)).toBe(true);
  });

  it('renders section titles in the contents nav and bodies as Markdown', () => {
    const wiki = makeWiki({
      status: 'ready',
      keyFiles: ['src/index.ts'],
      sections: [section('overview', 'done', '# Overview body'), section('architecture', 'done', '# Arch body')],
    });
    renderPanel(wiki);

    expect(screen.getAllByText('overview').length).toBeGreaterThan(0);
    expect(screen.getAllByText('architecture').length).toBeGreaterThan(0);
    expect(screen.getByText('# Overview body')).toBeTruthy();
    expect(screen.getByText('# Arch body')).toBeTruthy();
  });

  it('shows the live build phase strip while building', () => {
    renderPanel(makeWiki({ status: 'building', phase: 'verifying', phaseDetail: '5 docs · 2 issues' }));
    expect(screen.getByTestId('wiki-build-strip')).toBeTruthy();
    expect(screen.getByText('ide.wiki.phase_verifying')).toBeTruthy();
    expect(screen.getByText('5 docs · 2 issues')).toBeTruthy();
  });

  it('renders the documentation-check report + saved badge on a built wiki', () => {
    const wiki = makeWiki({
      status: 'ready',
      persisted: true,
      quality: 0.91,
      builtAt: Date.UTC(2026, 0, 1),
      docReports: [{ docPath: 'README.md', issueCount: 2, fixedCount: 2, rewritten: true }],
      sections: [section('overview', 'done', '# Body')],
    });
    renderPanel(wiki);
    expect(screen.getByText('ide.wiki.reportTitle')).toBeTruthy();
    expect(screen.getByText('ide.wiki.verifiedDocs:1')).toBeTruthy();
    expect(screen.getByText('ide.wiki.docsFixed:2')).toBeTruthy();
    expect(screen.getByText('ide.wiki.savedBadge')).toBeTruthy();
  });

  it('shows a build error with a regenerate affordance', () => {
    renderPanel(makeWiki({ status: 'error', error: 'boom', sections: [section('overview', 'done', '# x')] }));
    expect(screen.getByText('ide.wiki.buildFailed')).toBeTruthy();
    expect(screen.getByText('boom')).toBeTruthy();
    expect(screen.getAllByText('ide.wiki.regenerate').length).toBeGreaterThan(0);
  });
});

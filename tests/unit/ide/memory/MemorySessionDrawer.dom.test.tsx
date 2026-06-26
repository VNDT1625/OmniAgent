/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DOM tests for `MemorySessionDrawer` — the session-memory viewer. The data hook
 * `useIdeMemory` is mocked so the test renders the drawer purely against a fixed
 * snapshot (no IPC / no `ideClient` / no platform bridge). i18n is mocked to
 * echo keys so assertions target stable strings.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import type { SuperMemorySnapshot } from '@/process/ide/memory/sessionMemoryStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const clearSpy = vi.fn(async () => undefined);
const refreshSpy = vi.fn(async () => undefined);
let hookValue: {
  snapshot: SuperMemorySnapshot | null;
  loading: boolean;
  refresh: typeof refreshSpy;
  clear: typeof clearSpy;
};

vi.mock('@/renderer/pages/studio/ide/memory/useIdeMemory', () => ({
  useIdeMemory: () => hookValue,
}));

import MemorySessionDrawer from '@/renderer/pages/studio/ide/memory/MemorySessionDrawer';

const snapshot = (overrides: Partial<SuperMemorySnapshot> = {}): SuperMemorySnapshot => ({
  sessionId: 's1',
  items: [
    {
      id: 'm1',
      text: 'Auth lives in src/auth.ts',
      kind: 'fact',
      pinned: true,
      createdAt: 1,
      tokens: 8,
      accessCount: 2,
      lastAccessedAt: 1,
    },
    {
      id: 'm2',
      text: 'Use stripe for payments',
      kind: 'decision',
      pinned: false,
      createdAt: 2,
      tokens: 6,
      accessCount: 0,
      lastAccessedAt: 2,
    },
    {
      id: 's2',
      text: 'Summary of older notes',
      kind: 'summary',
      pinned: false,
      createdAt: 0,
      tokens: 5,
      accessCount: 0,
      lastAccessedAt: 0,
    },
  ],
  secretKeys: ['OPENAI_API_KEY'],
  tokensUsed: 19,
  tokenBudget: 6000,
  compactions: 1,
  deduped: 3,
  recalls: 4,
  lastCompactedAt: 5,
  ...overrides,
});

beforeEach(() => {
  clearSpy.mockClear();
  refreshSpy.mockClear();
  hookValue = { snapshot: snapshot(), loading: false, refresh: refreshSpy, clear: clearSpy };
});

describe('MemorySessionDrawer', () => {
  it('renders the notes, summaries and secret keys from the snapshot', () => {
    render(<MemorySessionDrawer memId='ide-mem-1' visible onClose={vi.fn()} />);
    expect(screen.getByText('Auth lives in src/auth.ts')).toBeInTheDocument();
    expect(screen.getByText('Use stripe for payments')).toBeInTheDocument();
    expect(screen.getByText('Summary of older notes')).toBeInTheDocument();
    expect(screen.getByText('OPENAI_API_KEY')).toBeInTheDocument();
  });

  it('shows the no-session empty state when memId is null', () => {
    hookValue = { snapshot: null, loading: false, refresh: refreshSpy, clear: clearSpy };
    render(<MemorySessionDrawer memId={null} visible onClose={vi.fn()} />);
    expect(screen.getByText('ide.memory.noSession')).toBeInTheDocument();
  });

  it('shows the empty state when the session has no notes', () => {
    hookValue = {
      snapshot: snapshot({ items: [], secretKeys: [], tokensUsed: 0 }),
      loading: false,
      refresh: refreshSpy,
      clear: clearSpy,
    };
    render(<MemorySessionDrawer memId='ide-mem-1' visible onClose={vi.fn()} />);
    expect(screen.getByText('ide.memory.empty')).toBeInTheDocument();
  });

  it('refreshes when the refresh button is clicked', () => {
    render(<MemorySessionDrawer memId='ide-mem-1' visible onClose={vi.fn()} />);
    fireEvent.click(screen.getByText('ide.memory.refresh'));
    expect(refreshSpy).toHaveBeenCalled();
  });
});

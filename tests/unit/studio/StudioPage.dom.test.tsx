/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ state: null }),
}));

vi.mock('@/renderer/pages/studio/editorToolsProvider', () => ({
  useEditorToolsProvider: vi.fn(),
}));

vi.mock('@/renderer/pages/studio/components/StudioDashboard', () => ({
  default: ({ onOpenIde }: { onOpenIde: () => void }) => (
    <button data-testid='open-ide' onClick={onOpenIde}>
      Open IDE
    </button>
  ),
}));

vi.mock('@/renderer/pages/studio/components/StudioEditorView', () => ({ default: () => null }));
vi.mock('@/renderer/pages/studio/components/StudioPeerView', () => ({ default: () => null }));
vi.mock('@/renderer/pages/studio/automation/AutomationView', () => ({ default: () => null }));
vi.mock('@/renderer/pages/studio/makevideo/MakeVideoView', () => ({ default: () => null }));
vi.mock('@renderer/pages/music', () => ({ default: () => null }));
vi.mock('@/renderer/pages/studio/ide/IdeWorkspace', () => ({
  default: () => <div data-testid='ide-workspace' />,
}));

import StudioPage from '@/renderer/pages/studio/StudioPage';

const store = new Map<string, string>();

beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string): string | null => store.get(key) ?? null,
    setItem: (key: string, value: string): void => void store.set(key, value),
    removeItem: (key: string): void => void store.delete(key),
    clear: (): void => store.clear(),
  });
});

afterEach(() => cleanup());

describe('StudioPage view persistence', () => {
  it('returns to the IDE after Studio is unmounted and mounted again', async () => {
    const firstMount = render(<StudioPage />);

    fireEvent.click(screen.getByTestId('open-ide'));
    expect(await screen.findByTestId('ide-workspace')).toBeInTheDocument();
    await waitFor(() => expect(store.get('studio.lastView')).toBe(JSON.stringify({ mode: 'ide' })));

    firstMount.unmount();
    render(<StudioPage />);

    expect(await screen.findByTestId('ide-workspace')).toBeInTheDocument();
  });
});

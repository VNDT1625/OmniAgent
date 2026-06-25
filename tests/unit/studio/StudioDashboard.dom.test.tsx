/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * DOM tests for the Studio dashboard. Verifies the WPS-like landing: the open
 * action calls the file dialog and surfaces the chosen path, recent files show
 * up and open on click, and empty states render. The fs/dialog bridge is mocked
 * so no IPC is needed.
 */

import { ConfigProvider } from '@arco-design/web-react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

const showOpen = vi.fn(async () => ['/picked/file.md'] as string[] | undefined);
vi.mock('@/common', () => ({
  ipcBridge: {
    dialog: { showOpen: { invoke: (...args: unknown[]) => showOpen(...args) } },
    fs: { writeFile: { invoke: vi.fn(async () => true) }, readFile: { invoke: vi.fn(async () => '') } },
    mode: { listProviders: { invoke: vi.fn(async () => []) } },
  },
}));

// The create-file modal pulls in the provider list; stub it so the dashboard
// test stays isolated from the Google-auth / SWR chain.
vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({
  useModelProviderList: () => ({ providers: [], getAvailableModels: () => [], formatModelLabel: () => '' }),
}));

import StudioDashboard from '@/renderer/pages/studio/components/StudioDashboard';

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k) : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
  });
  showOpen.mockClear();
});
afterEach(() => cleanup());

const renderDashboard = (onOpenFile = vi.fn(), onMakeVideo = vi.fn()) => {
  render(
    <ConfigProvider>
      <StudioDashboard
        onOpenFile={onOpenFile}
        onOpenIde={vi.fn()}
        onJoinSession={vi.fn()}
        onAutomation={vi.fn()}
        onMakeVideo={onMakeVideo}
      />
    </ConfigProvider>
  );
  return { onOpenFile, onMakeVideo };
};

describe('StudioDashboard', () => {
  it('renders the empty recent state initially', () => {
    renderDashboard();
    expect(screen.getByText('studio.empty.noRecent')).toBeInTheDocument();
  });

  it('opens the file dialog and forwards the chosen path', async () => {
    const { onOpenFile } = renderDashboard();
    fireEvent.click(screen.getByText('studio.open'));
    await waitFor(() => expect(showOpen).toHaveBeenCalledWith({ properties: ['openFile'] }));
    await waitFor(() => expect(onOpenFile).toHaveBeenCalledWith('/picked/file.md'));
  });

  it('triggers the Make Video entry', () => {
    const { onMakeVideo } = renderDashboard();
    fireEvent.click(screen.getByText('studio.makeVideo'));
    expect(onMakeVideo).toHaveBeenCalled();
  });

  it('shows an opened file in the recent list and reopens it on click', async () => {
    const { onOpenFile } = renderDashboard();
    fireEvent.click(screen.getByText('studio.open'));
    await waitFor(() => expect(screen.getByText('file.md')).toBeInTheDocument());
    onOpenFile.mockClear();
    fireEvent.click(screen.getByText('file.md'));
    expect(onOpenFile).toHaveBeenCalledWith('/picked/file.md');
  });
});

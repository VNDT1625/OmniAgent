/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import UpdateModal from '@/renderer/components/settings/UpdateModal';

const mocks = vi.hoisted(() => ({
  ipcBridge: {
    autoUpdate: {
      check: { invoke: vi.fn() },
      download: { invoke: vi.fn() },
      quitAndInstall: { invoke: vi.fn() },
      status: { on: vi.fn(() => () => undefined) },
    },
    update: {
      check: { invoke: vi.fn() },
      download: { invoke: vi.fn() },
      downloadProgress: { on: vi.fn(() => () => undefined) },
      open: { on: vi.fn(() => () => undefined) },
    },
    shell: {
      openExternal: { invoke: vi.fn() },
      openFile: { invoke: vi.fn() },
      showItemInFolder: { invoke: vi.fn() },
    },
  },
}));

vi.mock('@/common', () => ({
  ipcBridge: mocks.ipcBridge,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@/renderer/components/base/AionModal', () => ({
  default: ({ visible, children }: { visible: boolean; children: React.ReactNode }) =>
    visible ? <div data-testid='update-modal'>{children}</div> : null,
}));

vi.mock('@/renderer/components/Markdown', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock('@arco-design/web-react', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button type='button' disabled={disabled} onClick={onClick}>
      {children}
    </button>
  ),
  Progress: ({ percent }: { percent: number }) => <div data-testid='progress'>{percent}</div>,
  Message: {
    error: vi.fn(),
  },
}));

vi.mock('@icon-park/react', () => {
  const Icon = () => <span data-testid='icon' />;
  return {
    CheckOne: Icon,
    Download: Icon,
    FolderOpen: Icon,
    Refresh: Icon,
    CloseOne: Icon,
    Install: Icon,
  };
});

const latestRelease = {
  tagName: 'v2.1.12',
  version: '2.1.12',
  name: 'v2.1.12',
  body: '',
  htmlUrl: 'https://github.com/VNDT1625/OmniAgent/releases/tag/v2.1.12',
  prerelease: false,
  draft: false,
  assets: [],
  recommendedAsset: {
    name: 'AionUi-2.1.12-win-x64.exe',
    url: 'https://download.example/AionUi-2.1.12-win-x64.exe',
    fallbackUrl: 'https://github.example/AionUi-2.1.12-win-x64.exe',
    size: 1,
  },
};

const openUpdateModal = async (): Promise<void> => {
  render(<UpdateModal />);
  window.dispatchEvent(new Event('aionui-open-update-modal'));
  await screen.findByTestId('update-modal');
};

describe('UpdateModal download flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ipcBridge.autoUpdate.status.on.mockReturnValue(() => undefined);
    mocks.ipcBridge.update.downloadProgress.on.mockReturnValue(() => undefined);
    mocks.ipcBridge.update.open.on.mockReturnValue(() => undefined);
    mocks.ipcBridge.autoUpdate.download.invoke.mockResolvedValue({ success: true });
    mocks.ipcBridge.update.download.invoke.mockResolvedValue({
      success: true,
      data: { downloadId: 'manual-download', file_path: 'C:/Temp/AionUi.exe' },
    });
    mocks.ipcBridge.update.check.invoke.mockResolvedValue({
      success: true,
      data: {
        currentVersion: '2.1.10',
        updateAvailable: true,
        latest: latestRelease,
      },
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('uses electron-updater download when auto-update metadata is available', async () => {
    mocks.ipcBridge.autoUpdate.check.invoke.mockResolvedValue({
      success: true,
      data: {
        updateInfo: {
          version: '2.1.12',
          releaseNotes: '',
        },
      },
    });

    await openUpdateModal();

    const downloadButton = await screen.findByText('update.downloadAndInstall');
    fireEvent.click(downloadButton);

    await waitFor(() => {
      expect(mocks.ipcBridge.autoUpdate.download.invoke).toHaveBeenCalledTimes(1);
    });
    expect(mocks.ipcBridge.update.download.invoke).not.toHaveBeenCalled();
  });

  it('falls back to manual installer download when auto-update is not available', async () => {
    mocks.ipcBridge.autoUpdate.check.invoke.mockResolvedValue({
      success: true,
      data: {},
    });

    await openUpdateModal();

    const downloadButton = await screen.findByText('update.downloadButton');
    fireEvent.click(downloadButton);

    await waitFor(() => {
      expect(mocks.ipcBridge.update.download.invoke).toHaveBeenCalledWith({
        url: latestRelease.recommendedAsset.url,
        fallbackUrl: latestRelease.recommendedAsset.fallbackUrl,
        file_name: latestRelease.recommendedAsset.name,
      });
    });
    expect(mocks.ipcBridge.autoUpdate.download.invoke).not.toHaveBeenCalled();
  });
});

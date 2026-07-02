/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const originalFeedUrl = process.env.AIONUI_UPDATE_FEED_URL;

const importService = async (feedUrl: string | undefined) => {
  vi.resetModules();
  if (feedUrl === undefined) delete process.env.AIONUI_UPDATE_FEED_URL;
  else process.env.AIONUI_UPDATE_FEED_URL = feedUrl;

  const autoUpdater = {
    logger: null,
    autoDownload: true,
    autoInstallOnAppQuit: false,
    allowPrerelease: false,
    allowDowngrade: false,
    channel: undefined as string | undefined,
    setFeedURL: vi.fn(),
    on: vi.fn(),
    removeListener: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    checkForUpdatesAndNotify: vi.fn(),
  };
  const log = {
    transports: { file: { level: 'info' } },
    info: vi.fn(),
    error: vi.fn(),
  };

  vi.doMock('electron-updater', () => ({ autoUpdater }));
  vi.doMock('electron-log', () => ({ default: log }));
  vi.doMock('electron', () => ({
    app: {
      getVersion: vi.fn(() => '1.0.0'),
      getPath: vi.fn(() => '/tmp/aionui-test'),
    },
  }));

  await import('@process/services/autoUpdaterService');
  return { autoUpdater, log };
};

describe('autoUpdaterService update feed override', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    if (originalFeedUrl === undefined) delete process.env.AIONUI_UPDATE_FEED_URL;
    else process.env.AIONUI_UPDATE_FEED_URL = originalFeedUrl;
  });

  it('points electron-updater at a generic feed when AIONUI_UPDATE_FEED_URL is set', async () => {
    const { autoUpdater } = await importService('http://192.168.1.10:5077/releases');

    expect(autoUpdater.setFeedURL).toHaveBeenCalledWith({
      provider: 'generic',
      url: 'http://192.168.1.10:5077/releases/',
    });
  });

  it('logs and ignores invalid feed URLs instead of crashing startup', async () => {
    const { autoUpdater, log } = await importService('file:///tmp/releases');

    expect(autoUpdater.setFeedURL).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith('Invalid AIONUI_UPDATE_FEED_URL:', expect.any(Error));
  });
});

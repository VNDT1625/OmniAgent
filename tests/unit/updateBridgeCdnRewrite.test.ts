/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: vi.fn(() => {
      const handlerMap = new Map<string, Function>();
      return {
        provider: vi.fn((handler: Function) => {
          handlerMap.set('handler', handler);
          return vi.fn();
        }),
        invoke: vi.fn(),
        _getHandler: () => handlerMap.get('handler'),
      };
    }),
    buildEmitter: vi.fn(() => ({
      emit: vi.fn(),
      on: vi.fn(),
    })),
  },
  storage: {
    buildStorage: () => ({
      getSync: () => undefined,
      setSync: () => {},
      get: () => Promise.resolve(undefined),
      set: () => Promise.resolve(),
    }),
  },
}));

vi.mock('electron', () => ({
  app: {
    getVersion: vi.fn(() => '1.0.0'),
    getPath: vi.fn(() => '/test/path'),
    isPackaged: true,
  },
}));

vi.mock('electron-updater', () => ({
  autoUpdater: {
    logger: null,
    autoDownload: false,
    autoInstallOnAppQuit: true,
    allowPrerelease: false,
    allowDowngrade: false,
    on: vi.fn(),
    removeListener: vi.fn(),
    checkForUpdates: vi.fn(),
    downloadUpdate: vi.fn(),
    quitAndInstall: vi.fn(),
    checkForUpdatesAndNotify: vi.fn(),
  },
}));

vi.mock('electron-log', () => ({
  default: {
    transports: { file: { level: 'info' } },
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

const makeGitHubReleaseResponse = () => [
  {
    tag_name: 'v1.9.22',
    name: 'v1.9.22',
    body: 'release notes',
    html_url: 'https://github.com/VNDT1625/OmniAgent/releases/tag/v1.9.22',
    published_at: '2026-04-29T00:00:00Z',
    prerelease: false,
    draft: false,
    assets: [
      {
        name: 'AionUi-1.9.22-mac-arm64.dmg',
        browser_download_url:
          'https://github.com/VNDT1625/OmniAgent/releases/download/v1.9.22/AionUi-1.9.22-mac-arm64.dmg',
        size: 123,
        content_type: 'application/x-apple-diskimage',
      },
      {
        name: 'AionUi-1.9.22-win-x64.exe',
        browser_download_url:
          'https://github.com/VNDT1625/OmniAgent/releases/download/v1.9.22/AionUi-1.9.22-win-x64.exe',
        size: 456,
        content_type: 'application/vnd.microsoft.portable-executable',
      },
      {
        name: 'AionUi-1.9.22-linux-amd64.deb',
        browser_download_url:
          'https://github.com/VNDT1625/OmniAgent/releases/download/v1.9.22/AionUi-1.9.22-linux-amd64.deb',
        size: 789,
      },
    ],
  },
];

const makeOmniAgentReleaseResponse = () => [
  {
    tag_name: 'v2.1.15',
    name: 'v2.1.15',
    body: 'release notes',
    html_url: 'https://github.com/VNDT1625/OmniAgent/releases/tag/v2.1.15',
    published_at: '2026-07-02T00:00:00Z',
    prerelease: false,
    draft: false,
    assets: [
      {
        name: 'OmniAgentic-2.1.15-win-x64.exe',
        browser_download_url:
          'https://github.com/VNDT1625/OmniAgent/releases/download/v2.1.15/OmniAgentic-2.1.15-win-x64.exe',
        size: 456,
        content_type: 'application/vnd.microsoft.portable-executable',
      },
    ],
  },
];

const getCheckHandler = async () => {
  vi.resetModules();
  const { initUpdateBridge } = await import('@process/bridge/updateBridge');
  const { ipcBridge } = await import('@/common');

  initUpdateBridge();

  const provider = vi.mocked(ipcBridge.update.check.provider);
  const lastCall = provider.mock.calls.at(-1);
  if (!lastCall) throw new Error('update.check handler not registered');
  return lastCall[0];
};

describe('updateBridge Tomni release URLs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses the Tomni release repo by default', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeOmniAgentReleaseResponse(),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const handler = await getCheckHandler();
      const result = await handler({});

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledWith(
        'https://api.github.com/repos/VNDT1625/OmniAgent/releases',
        expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': 'TomniAgentic' }) })
      );
      const winAsset = result.data?.latest?.assets.find(
        (a: { name: string }) => a.name === 'OmniAgentic-2.1.15-win-x64.exe'
      );
      expect(winAsset?.url).toBe(
        'https://github.com/VNDT1625/OmniAgent/releases/download/v2.1.15/OmniAgentic-2.1.15-win-x64.exe'
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('does not rewrite fork release assets to the official AionUi CDN', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => makeOmniAgentReleaseResponse(),
    });
    vi.stubGlobal('fetch', fetchMock);

    try {
      const handler = await getCheckHandler();
      const result = await handler({ repo: 'VNDT1625/OmniAgent' });

      expect(result.success).toBe(true);
      const asset = result.data?.latest?.assets?.find(
        (item: { name: string }) => item.name === 'OmniAgentic-2.1.15-win-x64.exe'
      );
      expect(asset?.url).toBe(
        'https://github.com/VNDT1625/OmniAgent/releases/download/v2.1.15/OmniAgentic-2.1.15-win-x64.exe'
      );
      expect(asset?.fallbackUrl).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('updateBridge download host allowlist', () => {
  it('rejects non-allowlisted hosts', async () => {
    vi.resetModules();
    vi.clearAllMocks();

    const { initUpdateBridge } = await import('@process/bridge/updateBridge');
    const { ipcBridge } = await import('@/common');

    initUpdateBridge();

    const provider = vi.mocked(ipcBridge.update.download.provider);
    const lastCall = provider.mock.calls.at(-1);
    if (!lastCall) throw new Error('update.download handler not registered');
    const handler = lastCall[0];

    const result = await handler({
      url: 'https://evil.example.com/fake.dmg',
      file_name: 'fake.dmg',
    });

    // Download is refused before any network I/O; exact error text comes from i18n and isn't asserted here.
    expect(result.success).toBe(false);
  });
});

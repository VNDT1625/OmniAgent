/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for {@link createBrowserViewManager}, focused on the benign
 * `ERR_ABORTED` navigation handling in `loadURL` (the root cause of the
 * "browser_open errored / watch frame blank" bug): a redirect (youtube.com →
 * www.youtube.com, facebook.com → consent URL) makes Electron reject the
 * original `loadURL` promise with `ERR_ABORTED` even though the page loads. The
 * manager must swallow that abort and still surface real navigation failures.
 */

import { describe, expect, it, vi } from 'vitest';

// The manager value-imports `WebContentsView` from electron; provide a no-op
// stand-in so the module loads under Node. Tests inject their own `createView`,
// so this constructor is never actually called.
vi.mock('electron', () => ({
  WebContentsView: class {
    webContents = {};
  },
}));

import { createBrowserViewManager } from '@process/browser/browserViewManager';

/** Build a fake WebContents whose `loadURL` is controlled per test. */
const makeFakeView = (loadURL: (url: string) => Promise<void>) => {
  const webContents = {
    loadURL: vi.fn(loadURL),
    isDestroyed: () => false,
    getURL: () => 'https://www.example.com/',
    getTitle: () => 'Example',
    setVisible: vi.fn(),
    setAudioMuted: vi.fn(),
    setZoomFactor: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    on: vi.fn(),
    close: vi.fn(),
    reload: vi.fn(),
    navigationHistory: { canGoBack: () => false, canGoForward: () => false, goBack: vi.fn(), goForward: vi.fn() },
  };
  return {
    webContents,
    setBounds: vi.fn(),
    setVisible: vi.fn(),
  };
};

/** A minimal live main window stub. */
const fakeWindow = () => ({
  isDestroyed: () => false,
  contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
});

describe('browserViewManager loadURL abort handling', () => {
  it('swallows ERR_ABORTED (code) raised by a redirect so the open succeeds', async () => {
    const view = makeFakeView(() =>
      Promise.reject(Object.assign(new Error('navigation aborted'), { code: 'ERR_ABORTED' }))
    );
    const manager = createBrowserViewManager({
      getWindow: () => fakeWindow() as never,
      createView: () => view as never,
    });
    const id = manager.createTab({ visible: true });
    await expect(manager.loadURL(id, 'https://youtube.com')).resolves.toBeUndefined();
  });

  it('swallows ERR_ABORTED reported only via errno -3', async () => {
    const view = makeFakeView(() => Promise.reject(Object.assign(new Error('aborted'), { errno: -3 })));
    const manager = createBrowserViewManager({
      getWindow: () => fakeWindow() as never,
      createView: () => view as never,
    });
    const id = manager.createTab({ visible: true });
    await expect(manager.loadURL(id, 'https://facebook.com')).resolves.toBeUndefined();
  });

  it('rethrows a real navigation failure (e.g. name not resolved)', async () => {
    const view = makeFakeView(() =>
      Promise.reject(Object.assign(new Error('ERR_NAME_NOT_RESOLVED'), { code: 'ERR_NAME_NOT_RESOLVED' }))
    );
    const manager = createBrowserViewManager({
      getWindow: () => fakeWindow() as never,
      createView: () => view as never,
    });
    const id = manager.createTab({ visible: true });
    await expect(manager.loadURL(id, 'https://nope.invalid')).rejects.toThrow('ERR_NAME_NOT_RESOLVED');
  });

  it('resolves normally when the page loads without a redirect', async () => {
    const view = makeFakeView(() => Promise.resolve());
    const manager = createBrowserViewManager({
      getWindow: () => fakeWindow() as never,
      createView: () => view as never,
    });
    const id = manager.createTab({ visible: true });
    await expect(manager.loadURL(id, 'https://www.example.com')).resolves.toBeUndefined();
  });
});

describe('browserViewManager audio policy (background playback)', () => {
  it('keeps a USER tab unmuted when it is hidden (background YouTube playback)', () => {
    const view = makeFakeView(() => Promise.resolve());
    const manager = createBrowserViewManager({
      getWindow: () => fakeWindow() as never,
      createView: () => view as never,
    });
    // A user tab is created visible → not muted up-front.
    manager.createTab({ visible: true });
    expect(view.webContents.setAudioMuted).not.toHaveBeenCalledWith(true);

    // Leaving the Browser page hides every tab. The user tab must STAY unmuted
    // so its video keeps playing in the background.
    manager.hideAll();
    expect(view.webContents.setAudioMuted).not.toHaveBeenCalledWith(true);
  });

  it('mutes a BACKGROUND tab up-front and keeps it muted when shown', () => {
    const view = makeFakeView(() => Promise.resolve());
    const manager = createBrowserViewManager({
      getWindow: () => fakeWindow() as never,
      createView: () => view as never,
    });
    // Off-screen research/scrape tabs are created hidden → background → muted.
    const id = manager.createTab({ visible: false });
    expect(view.webContents.setAudioMuted).toHaveBeenCalledWith(true);

    view.webContents.setAudioMuted.mockClear();
    // Even if it is somehow made visible, a background tab must never unmute.
    manager.setVisible(id, true);
    expect(view.webContents.setAudioMuted).not.toHaveBeenCalledWith(false);
  });

  it('treats an explicitly non-background hidden tab (watch-grid surface) as a user tab', () => {
    const view = makeFakeView(() => Promise.resolve());
    const manager = createBrowserViewManager({
      getWindow: () => fakeWindow() as never,
      createView: () => view as never,
    });
    // Watch-grid surfaces start hidden but are user-watched → not muted.
    const id = manager.createTab({ visible: false, background: false });
    expect(view.webContents.setAudioMuted).not.toHaveBeenCalledWith(true);

    manager.setVisible(id, true);
    expect(view.webContents.setAudioMuted).not.toHaveBeenCalledWith(true);
  });
});

describe('browserViewManager popup handling (keep links in-app)', () => {
  it('denies a popup window and loads its URL in the same tab instead', () => {
    const view = makeFakeView(() => Promise.resolve());
    const manager = createBrowserViewManager({
      getWindow: () => fakeWindow() as never,
      createView: () => view as never,
    });
    manager.createTab({ visible: true });

    // A window-open handler must have been registered.
    expect(view.webContents.setWindowOpenHandler).toHaveBeenCalledTimes(1);
    const handler = view.webContents.setWindowOpenHandler.mock.calls[0][0] as (a: { url: string }) => {
      action: string;
    };

    view.webContents.loadURL.mockClear();
    const result = handler({ url: 'https://vnexpress.net/some-article' });

    // The popup is denied (no separate native window)…
    expect(result).toEqual({ action: 'deny' });
    // …and the URL is loaded in the existing tab instead.
    expect(view.webContents.loadURL).toHaveBeenCalledWith('https://vnexpress.net/some-article');
  });

  it('denies a non-http popup (e.g. about:blank) without navigating', () => {
    const view = makeFakeView(() => Promise.resolve());
    const manager = createBrowserViewManager({
      getWindow: () => fakeWindow() as never,
      createView: () => view as never,
    });
    manager.createTab({ visible: true });
    const handler = view.webContents.setWindowOpenHandler.mock.calls[0][0] as (a: { url: string }) => {
      action: string;
    };

    view.webContents.loadURL.mockClear();
    const result = handler({ url: 'about:blank' });
    expect(result).toEqual({ action: 'deny' });
    expect(view.webContents.loadURL).not.toHaveBeenCalled();
  });
});

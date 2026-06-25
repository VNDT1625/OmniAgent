/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Platform detection utilities
 * 平台检测工具函数
 */

import { getBaseUrl } from '@/common/adapter/httpBridge';

/**
 * Check if running in Electron desktop environment
 * 检测是否运行在 Electron 桌面环境
 */
export const isElectronDesktop = (): boolean => {
  return typeof window !== 'undefined' && Boolean(window.electronAPI);
};

/**
 * Check if running on macOS
 * 检测是否运行在 macOS
 */
export const isMacOS = (): boolean => {
  return typeof navigator !== 'undefined' && /mac/i.test(navigator.userAgent);
};

/**
 * Check if running on Windows
 * 检测是否运行在 Windows
 */
export const isWindows = (): boolean => {
  return typeof navigator !== 'undefined' && /win/i.test(navigator.userAgent);
};

/**
 * Check if running on Linux
 * 检测是否运行在 Linux
 */
export const isLinux = (): boolean => {
  return typeof navigator !== 'undefined' && /linux/i.test(navigator.userAgent);
};

function isAbsoluteAssetUrl(url: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(url) || url.startsWith('//');
}

/**
 * Resolve a backend-served asset URL for the current environment.
 * In Electron, renderer pages are file:// based, so backend-relative paths
 * must be expanded against the backend HTTP origin.
 */
export const resolveBackendAssetUrl = (url: string | undefined): string | undefined => {
  if (!url) return url;
  if (isAbsoluteAssetUrl(url) || /^data:/i.test(url)) return url;
  if (url.startsWith('/')) {
    return isElectronDesktop() ? `${getBaseUrl()}${url}` : url;
  }
  return url;
};

/**
 * Resolve an extension asset URL for the current environment.
 * Backend-managed extension assets are already emitted as HTTP URLs, so this
 * helper resolves app-relative backend paths into absolute backend URLs when
 * the desktop renderer is not same-origin with the backend process.
 *
 * 将扩展资源 URL 转换为当前环境可用的地址
 */
export const resolveExtensionAssetUrl = (url: string | undefined): string | undefined => {
  return resolveBackendAssetUrl(url);
};

/**
 * Open a URL in the built-in Browser tab (Main-process WebContentsView) and
 * focus the Browser page.
 *
 * Works outside React (e.g. the deep-link handler) by falling back to
 * hash-router navigation when no `navigate` function is supplied. The browser
 * client and constants are imported dynamically so this Node-bridge-backed code
 * is only pulled in when actually opening a tab.
 *
 * Desktop-only: in non-Electron (WebUI) contexts there is no embedded browser,
 * so this rejects and callers should fall back to `window.open`.
 */
export const openInAppBrowserTab = async (url: string, navigate?: (route: string) => void): Promise<void> => {
  if (!isElectronDesktop()) {
    throw new Error('In-app browser is only available in the desktop app.');
  }
  const [{ browserClient }, { requestActiveTab, requestChatOpen }, { emitter }] = await Promise.all([
    import('@/renderer/pages/browser/browserBridgeClient'),
    import('@/renderer/pages/browser/constants'),
    import('@/renderer/utils/emitter'),
  ]);
  const { id } = await browserClient.openTab({ url });
  requestActiveTab(id);
  // A URL opened from outside the app (deep link / default-browser hand-off)
  // should land with the AI chat panel ready. Cover both cases:
  //  - the Browser page is NOT mounted yet → requestChatOpen() is consumed on its
  //    next mount;
  //  - the Browser page IS already mounted (user was on it) → the emitter event
  //    opens the dock immediately (no remount, so the mount effect won't fire).
  requestChatOpen();
  if (navigate) {
    navigate('/settings/browser');
  } else if (typeof window !== 'undefined') {
    // HashRouter — set the hash directly so this works from non-React contexts.
    window.location.hash = '#/settings/browser';
  }
  // Emit after navigation so a mounted Browser page reacts even without remount.
  setTimeout(() => emitter.emit('browser.openChat'), 0);
};

/**
 * Whether links opened from inside the app should land in the built-in Browser
 * tab instead of the system browser. Reads the persisted `browser.openLinksInApp`
 * preference; only meaningful on the desktop app.
 */
const shouldOpenLinksInApp = async (): Promise<boolean> => {
  if (!isElectronDesktop()) return false;
  try {
    const { configService } = await import('@/common/config/configService');
    await configService.whenReady();
    return configService.get('browser.openLinksInApp') === true;
  } catch {
    return false;
  }
};

/**
 * Open external URL in the appropriate context
 * - Electron: uses shell.openExternal via IPC (opens on local machine), or the
 *   built-in Browser tab when the user enabled "open links in app".
 * - WebUI: uses window.open in client browser (opens on remote client)
 *
 * 在适当的环境中打开外部链接
 * - Electron: 通过 IPC 调用 shell.openExternal（在本地机器打开），或在内置浏览器标签页打开
 * - WebUI: 使用 window.open 在客户端浏览器打开（在远程客户端打开）
 */
export const openExternalUrl = async (url: string): Promise<void> => {
  if (!url) return;

  if (isElectronDesktop()) {
    // Route http/https into the built-in Browser tab when the user opted in.
    if (/^https?:\/\//i.test(url) && (await shouldOpenLinksInApp())) {
      try {
        await openInAppBrowserTab(url);
        return;
      } catch (error) {
        // Fall back to the system browser if the in-app browser is unavailable.
        console.error('[platform] In-app browser open failed, falling back to system browser:', error);
      }
    }
    const { ipcBridge } = await import('@/common');
    await ipcBridge.shell.openExternal.invoke(url);
  } else {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
};

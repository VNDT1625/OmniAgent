/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Default-browser registration (Main process, Windows).
 *
 * To appear in the Windows "Default apps" list as a browser AND be selectable
 * for the `HTTP` / `HTTPS` link types, an app must register a full
 * **Capabilities** set in the registry — `app.setAsDefaultProtocolClient`
 * alone is NOT enough for the http/https schemes (it works for custom schemes
 * like `aionui://`, but Windows ignores a bare scheme command for the built-in
 * web schemes). This module writes that Capabilities set.
 *
 * We register **per-user** (HKEY_CURRENT_USER): it needs no administrator
 * rights and applies to the signed-in account, which is what a personal install
 * wants. A per-machine (HKLM, all-users) registration would be done by the NSIS
 * installer instead; that is intentionally out of scope here.
 *
 * Windows 10/11 still do not let an app force itself as the default — after
 * registering, we open the OS "default apps" page so the user makes the final
 * choice. The required keys (per-user) are:
 *
 *   HKCU\Software\Classes\<ProgId>\shell\open\command   (default) = "<exe>" "%1"
 *   HKCU\Software\Classes\<ProgId>\DefaultIcon          (default) = "<exe>",0
 *   HKCU\Software\<App>\Capabilities  ApplicationName / ApplicationDescription
 *   HKCU\Software\<App>\Capabilities\URLAssociations  http=<ProgId> https=<ProgId>
 *   HKCU\Software\RegisteredApplications  <App> = Software\<App>\Capabilities
 *   HKCU\Software\Clients\StartMenuInternet\<App>  (web-browser category)
 *
 * Process boundary: Main-process (Node.js / Electron) module. No DOM APIs.
 */

import { app, shell } from 'electron';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { IDefaultBrowserStatus } from '@/common/adapter/ipcBridge';

const execFileAsync = promisify(execFile);

/** Web schemes AionUi registers as the default browser for. */
const WEB_SCHEMES = ['http', 'https'] as const;

/** ProgId that owns the URL-open command for AionUi's web handling. */
const PROG_ID = 'AionUiHTML';
/** Name AionUi is listed under in RegisteredApplications / StartMenuInternet. */
const APP_REG_NAME = 'AionUi';
/** Registry path (HKCU-relative) of the Capabilities block. */
const CAPABILITIES_PATH = `Software\\${APP_REG_NAME}\\Capabilities`;

/** Whether runtime default-browser registration is available on this OS. */
const isDefaultBrowserSupported = (): boolean => process.platform === 'win32';

/**
 * Build the URL-launch command Windows should run for AionUi.
 *
 * In a PACKAGED build `process.execPath` is `AionUi.exe`, which already embeds
 * the app, so `"<exe>" "%1"` is correct. In DEVELOPMENT (`bun start`),
 * `process.execPath` is the bare `electron.exe` — running it with only a URL
 * argument opens a blank default Electron window (with a menu bar) instead of
 * our app. So in dev we must also pass the app entry path that Electron was
 * originally launched with (`process.argv[1]`), reproducing the dev launch:
 *   "electron.exe" "<appPath>" "%1"
 */
const buildLaunchCommand = (): string => {
  const exe = process.execPath;
  if (app.isPackaged) return `"${exe}" "%1"`;
  // argv[0] is electron.exe; argv[1] is the app dir / entry passed by `bun start`.
  const appPath = process.argv[1];
  return appPath ? `"${exe}" "${appPath}" "%1"` : `"${exe}" "%1"`;
};

/** Run a single `reg.exe` command (no shell, so values are taken literally). */
const runReg = async (args: string[]): Promise<void> => {
  await execFileAsync('reg.exe', args, { windowsHide: true });
};

/**
 * Write the full per-user Capabilities set into HKCU so Windows lists AionUi as
 * a browser and offers it for the http/https link types. Best-effort: a failing
 * key is logged but does not abort the rest (a partial registration still lets
 * the user pick AionUi for whatever associations were written).
 */
const writeCapabilities = async (exePath: string): Promise<void> => {
  const command = buildLaunchCommand();
  const icon = `"${exePath}",0`;

  const steps: string[][] = [
    // ProgId: how Windows launches AionUi for a URL.
    ['add', `HKCU\\Software\\Classes\\${PROG_ID}`, '/ve', '/d', 'AionUi HTML Document', '/f'],
    ['add', `HKCU\\Software\\Classes\\${PROG_ID}\\DefaultIcon`, '/ve', '/d', icon, '/f'],
    ['add', `HKCU\\Software\\Classes\\${PROG_ID}\\shell\\open\\command`, '/ve', '/d', command, '/f'],

    // Capabilities block referenced by RegisteredApplications.
    ['add', `HKCU\\${CAPABILITIES_PATH}`, '/v', 'ApplicationName', '/d', 'AionUi', '/f'],
    [
      'add',
      `HKCU\\${CAPABILITIES_PATH}`,
      '/v',
      'ApplicationDescription',
      '/d',
      'AionUi AI workspace with a built-in browser.',
      '/f',
    ],

    // Tell Windows AionUi handles http/https.
    ['add', `HKCU\\${CAPABILITIES_PATH}\\URLAssociations`, '/v', 'http', '/d', PROG_ID, '/f'],
    ['add', `HKCU\\${CAPABILITIES_PATH}\\URLAssociations`, '/v', 'https', '/d', PROG_ID, '/f'],

    // Register the application so it shows up in Settings → Default apps.
    ['add', 'HKCU\\Software\\RegisteredApplications', '/v', APP_REG_NAME, '/d', CAPABILITIES_PATH, '/f'],

    // Web-browser category (StartMenuInternet) — points at the same Capabilities.
    ['add', `HKCU\\Software\\Clients\\StartMenuInternet\\${APP_REG_NAME}`, '/ve', '/d', 'AionUi', '/f'],
    [
      'add',
      `HKCU\\Software\\Clients\\StartMenuInternet\\${APP_REG_NAME}\\Capabilities`,
      '/v',
      'ApplicationName',
      '/d',
      'AionUi',
      '/f',
    ],
    [
      'add',
      `HKCU\\Software\\Clients\\StartMenuInternet\\${APP_REG_NAME}\\Capabilities`,
      '/v',
      'ApplicationDescription',
      '/d',
      'AionUi AI workspace with a built-in browser.',
      '/f',
    ],
    [
      'add',
      `HKCU\\Software\\Clients\\StartMenuInternet\\${APP_REG_NAME}\\Capabilities\\URLAssociations`,
      '/v',
      'http',
      '/d',
      PROG_ID,
      '/f',
    ],
    [
      'add',
      `HKCU\\Software\\Clients\\StartMenuInternet\\${APP_REG_NAME}\\Capabilities\\URLAssociations`,
      '/v',
      'https',
      '/d',
      PROG_ID,
      '/f',
    ],
    [
      'add',
      `HKCU\\Software\\Clients\\StartMenuInternet\\${APP_REG_NAME}\\shell\\open\\command`,
      '/ve',
      '/d',
      command,
      '/f',
    ],
  ];

  for (const args of steps) {
    try {
      await runReg(args);
    } catch (error) {
      console.error('[DefaultBrowser] reg add failed for', args[1], error);
    }
  }
};

/**
 * Report whether AionUi is currently the OS default for web URLs. `isDefault`
 * is true only when every web scheme reports AionUi as its handler.
 */
export const getDefaultBrowserStatus = (): IDefaultBrowserStatus => {
  const supported = isDefaultBrowserSupported();
  const isDefault = supported && WEB_SCHEMES.every((scheme) => app.isDefaultProtocolClient(scheme));
  return { supported, isDefault, platform: process.platform };
};

/**
 * Register AionUi as an http/https handler candidate (per-user Capabilities)
 * and open the OS "default apps" settings so the user can pick AionUi. Returns
 * the post-call status. No-op (returns the unsupported status) off Windows.
 */
export const setAsDefaultBrowser = async (): Promise<IDefaultBrowserStatus> => {
  if (!isDefaultBrowserSupported()) {
    return getDefaultBrowserStatus();
  }

  // 1) Per-user Capabilities so Windows lists AionUi as a browser candidate.
  await writeCapabilities(process.execPath);

  // 2) Keep the scheme commands in sync (covers the aionui:// path too and is
  //    harmless for http/https). Best-effort. In dev, pass the app entry path so
  //    Electron relaunches OUR app (not a blank window) — same reason as
  //    buildLaunchCommand().
  const devAppPath = app.isPackaged ? undefined : process.argv[1];
  for (const scheme of WEB_SCHEMES) {
    try {
      if (devAppPath) {
        app.setAsDefaultProtocolClient(scheme, process.execPath, [devAppPath]);
      } else {
        app.setAsDefaultProtocolClient(scheme);
      }
    } catch (error) {
      console.error(`[DefaultBrowser] setAsDefaultProtocolClient("${scheme}") failed:`, error);
    }
  }

  // 3) Windows 10/11 require the user to confirm in Settings — deep-link there.
  try {
    await shell.openExternal('ms-settings:defaultapps');
  } catch (error) {
    console.error('[DefaultBrowser] Failed to open Windows default-apps settings:', error);
  }

  return getDefaultBrowserStatus();
};

/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { networkInterfaces } from 'os';
import { getSystemDir } from './initStorage';
import { httpRequest } from '@/common/adapter/httpBridge';
import { startWebHost, type WebHostHandle } from '@aionui/web-host';
import { ensureCloudflared, startTunnel, stopTunnel } from '@process/studio/cloudflareTunnel';
import { getDataPath } from './utils';

const WEBUI_CONFIG_FILE = 'webui.config.json';
const DESKTOP_WEBUI_ENABLED_KEY = 'webui.desktop.enabled';
const DESKTOP_WEBUI_ALLOW_REMOTE_KEY = 'webui.desktop.allowRemote';
const DESKTOP_WEBUI_PORT_KEY = 'webui.desktop.port';

/**
 * Read WebUI preferences from the backend's /api/settings/client store.
 *
 * Historical note: this used to read from `ProcessConfig` (a local JSON file).
 * The renderer's `configService` was migrated to the backend HTTP store, but
 * this main-process path was not, so `webui.desktop.enabled` that the user
 * toggled via Settings was only ever persisted to SQLite — the next launch's
 * auto-restore always read `undefined` from the local file and did nothing,
 * yet the Settings page still showed the Switch as "on" (reading the SQLite
 * value), so users clicked the saved URL and got ERR_CONNECTION_REFUSED.
 */
async function readWebUIDesktopPreferences(): Promise<{
  enabled: boolean;
  allowRemote: boolean;
  port: number | undefined;
}> {
  try {
    const settings = await httpRequest<Record<string, unknown>>('GET', '/api/settings/client');
    const enabled = settings?.[DESKTOP_WEBUI_ENABLED_KEY] === true;
    const allowRemote = settings?.[DESKTOP_WEBUI_ALLOW_REMOTE_KEY] === true;
    const rawPort = settings?.[DESKTOP_WEBUI_PORT_KEY];
    const port = typeof rawPort === 'number' && rawPort > 0 ? rawPort : undefined;
    return { enabled, allowRemote, port };
  } catch (error) {
    console.error('[WebUI] Failed to read preferences from backend:', error);
    return { enabled: false, allowRemote: false, port: undefined };
  }
}

async function writeWebUIDesktopEnabled(enabled: boolean): Promise<void> {
  try {
    await httpRequest<void>('PUT', '/api/settings/client', { [DESKTOP_WEBUI_ENABLED_KEY]: enabled });
  } catch (error) {
    console.error('[WebUI] Failed to reconcile webui.desktop.enabled on backend:', error);
  }
}

export type WebUIUserConfig = {
  port?: number | string;
  allowRemote?: boolean;
  // Legacy fields, retired in favor of SQLite users table. Present only when
  // reading an older webui.config.json; stripped on every rewrite.
  passwordHash?: string;
  passwordUpdatedAt?: string;
  adminUsername?: string;
};

export const parsePortValue = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const portNumber = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (!Number.isFinite(portNumber) || portNumber < 1 || portNumber > 65535) {
    return null;
  }
  return portNumber;
};

export const parseBooleanEnv = (value?: string): boolean | null => {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
};

export const loadUserWebUIConfig = (): { config: WebUIUserConfig; path: string | null; exists: boolean } => {
  try {
    const userDataPath = app.getPath('userData');
    const configPath = path.join(userDataPath, WEBUI_CONFIG_FILE);
    if (!fs.existsSync(configPath)) {
      return { config: {}, path: configPath, exists: false };
    }

    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { config: {}, path: configPath, exists: false };
    }
    return { config: parsed as WebUIUserConfig, path: configPath, exists: true };
  } catch {
    return { config: {}, path: null, exists: false };
  }
};

/**
 * Atomic write of webui.config.json into the Electron userData dir.
 * Drops legacy password fields (passwordHash / passwordUpdatedAt); the SQLite
 * users table is now the single source of truth for credentials.
 * Write-to-tmp-then-rename prevents corruption if the process is killed mid-write.
 */
export const saveUserWebUIConfig = async (config: WebUIUserConfig): Promise<void> => {
  const userDataPath = app.getPath('userData');
  const configPath = path.join(userDataPath, WEBUI_CONFIG_FILE);
  const tmpPath = `${configPath}.tmp`;

  const sanitized: WebUIUserConfig = {};
  if (config.port !== undefined) sanitized.port = config.port;
  if (config.allowRemote !== undefined) sanitized.allowRemote = config.allowRemote;
  if (config.adminUsername !== undefined) sanitized.adminUsername = config.adminUsername;

  await fs.promises.mkdir(userDataPath, { recursive: true });
  const payload = JSON.stringify(sanitized, null, 2) + '\n';
  await fs.promises.writeFile(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 });
  await fs.promises.rename(tmpPath, configPath);
};

// Keep aligned with renderer's WEBUI_DEFAULT_PORT (common/config/constants.ts):
//   production -> 25808, dev -> 25809, multi-instance dev -> 25810
const DEFAULT_WEBUI_PORT = (() => {
  if (process.env.NODE_ENV === 'production') return 25808;
  if (process.env.AIONUI_MULTI_INSTANCE === '1') return 25810;
  return 25809;
})();

export const resolveWebUIPort = (
  config: WebUIUserConfig,
  getSwitchValue: (flag: string) => string | undefined
): number => {
  const cliPort = parsePortValue(getSwitchValue('port') ?? getSwitchValue('webui-port'));
  if (cliPort) return cliPort;

  const envPort = parsePortValue(process.env.AIONUI_PORT ?? process.env.PORT);
  if (envPort) return envPort;

  const configPort = parsePortValue(config.port);
  if (configPort) return configPort;

  return DEFAULT_WEBUI_PORT;
};

export const resolveRemoteAccess = (config: WebUIUserConfig, isRemoteMode: boolean): boolean => {
  const envRemote = parseBooleanEnv(process.env.AIONUI_ALLOW_REMOTE || process.env.AIONUI_REMOTE);
  const hostHint = process.env.AIONUI_HOST?.trim();
  const hostRequestsRemote = hostHint ? ['0.0.0.0', '::', '::0'].includes(hostHint) : false;
  const configRemote = config.allowRemote === true;

  return isRemoteMode || hostRequestsRemote || envRemote === true || configRemote;
};

// ---------------------------------------------------------------------------
// Desktop-managed WebUI lifecycle
// ---------------------------------------------------------------------------

export type DesktopWebUIHandle = {
  port: number;
  allowRemote: boolean;
  localUrl: string;
  networkUrl?: string;
  lanIP?: string;
  candidateLanIPs?: string[];
  publicUrl?: string;
  initialPassword?: string;
};

const WEBUI_TUNNEL_KEY = 'webui';
let currentHandle: (WebHostHandle & { allowRemote: boolean }) | null = null;
let currentPublicUrl: string | undefined;
// First-use plaintext password for the active handle. Set by webui.start IPC
// handler before startDesktopWebUI() when the backend reports needs_setup=true,
// so Settings can display the generated password exactly once. Cleared on stop.
let currentInitialPassword: string | undefined;

/**
 * Stash the plaintext password to surface on the next `getDesktopWebUIStatus()`
 * or IPC start response. Call with `undefined` to clear.
 */
export function setDesktopWebUIInitialPassword(password: string | undefined): void {
  currentInitialPassword = password;
}

const getCandidateLanIPs = (): string[] => {
  const nets = networkInterfaces();
  const candidates: Array<{ address: string; score: number }> = [];
  for (const name of Object.keys(nets)) {
    const netInfo = nets[name];
    if (!netInfo) continue;
    const normalizedName = name.toLowerCase();
    const virtualAdapter = /(radmin|virtual|vmware|vbox|hyper-v|tailscale|zerotier|docker|wsl|loopback|tunnel)/.test(
      normalizedName
    );
    const physicalAdapter = /(wi-?fi|wireless|wlan|ethernet|local area|^en\d|^eth\d)/.test(normalizedName);
    for (const net of netInfo) {
      const isIPv4 = net.family === 'IPv4' || (net.family as unknown) === 4;
      if (!isIPv4 || net.internal) continue;
      const isPrivate = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[0-1])\.)/.test(net.address);
      if (!candidates.some((candidate) => candidate.address === net.address)) {
        candidates.push({
          address: net.address,
          score: (isPrivate ? 100 : 0) + (physicalAdapter ? 20 : 0) - (virtualAdapter ? 80 : 0),
        });
      }
    }
  }

  return candidates.sort((a, b) => b.score - a.score).map((candidate) => candidate.address);
};

const getLanIP = (): string | null => getCandidateLanIPs()[0] ?? null;

const toDesktopHandle = (handle: WebHostHandle, allowRemote: boolean): DesktopWebUIHandle => {
  const candidateLanIPs = allowRemote ? getCandidateLanIPs() : [];
  const lanIP = handle.lanIP ?? candidateLanIPs[0];
  return {
    port: handle.port,
    allowRemote,
    localUrl: handle.localUrl,
    networkUrl: lanIP ? `http://${lanIP}:${handle.port}` : handle.networkUrl,
    lanIP,
    candidateLanIPs,
    publicUrl: currentPublicUrl,
    initialPassword: currentInitialPassword,
  };
};

/**
 * Spawn a WebUI instance (static server + backend) and remember the handle so
 * callers can later stop it or query its status.
 *
 * Shared by the boot-time auto-restore path and the interactive
 * Settings → "Enable WebUI" IPC handler.
 */
export async function startDesktopWebUI(opts: { port?: number; allowRemote?: boolean }): Promise<DesktopWebUIHandle> {
  // If already running, tear down first so we honour the new port / allowRemote.
  if (currentHandle) {
    await stopDesktopWebUI();
  }

  const allowRemote = opts.allowRemote === true;
  const preferredPort = parsePortValue(opts.port) ?? DEFAULT_WEBUI_PORT;
  const sysDir = getSystemDir();

  // Reuse the backend already spawned by backendManager.start() in src/index.ts.
  // Spawning a second backend here would race the first on the same SQLite file.
  const backendPort = (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
  if (!backendPort) {
    throw new Error('[WebUI] Cannot start: aioncore is not running (globalThis.__backendPort unset)');
  }

  const handle = await startWebHost({
    app: {
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      resourcesPath: app.getAppPath(),
      // webui.config.json must live next to the backend SQLite DB so --resetpass
      // CLI and the runtime settings path read/write the same user record.
      // getDataPath() returns ~/.aionui[-dev] symlink on macOS to sidestep
      // path-with-spaces issues under Application Support.
      userDataPath: getDataPath(),
    },
    // After bundling, this file is out/main/index.js — renderer assets live at ../renderer.
    staticDir: path.join(__dirname, '../renderer'),
    port: preferredPort,
    allowRemote,
    // Must align with the desktop IPC path's backend dataDir (src/index.ts), otherwise
    // users see divergent SQLite state between desktop app and bundled WebUI.
    dataDir: getDataPath(),
    logDir: sysDir.logDir,
    dirs: {
      cacheDir: sysDir.cacheDir,
      workDir: sysDir.workDir,
      logDir: sysDir.logDir,
    },
    backend: {
      kind: 'useExistingBackend',
      port: backendPort,
    },
  });

  currentHandle = Object.assign(handle, { allowRemote });
  currentPublicUrl = undefined;

  if (allowRemote) {
    const cloudflared = await ensureCloudflared();
    if (cloudflared.ok) {
      const tunnel = await startTunnel(WEBUI_TUNNEL_KEY, handle.localUrl);
      if (tunnel.ok) {
        currentPublicUrl = tunnel.url;
      } else {
        const reason = 'reason' in tunnel ? tunnel.reason : 'start-failed';
        const detail = 'detail' in tunnel ? tunnel.detail : undefined;
        console.warn(`[WebUI] Public tunnel unavailable: ${reason}${detail ? ` (${detail})` : ''}`);
      }
    } else {
      const detail = 'detail' in cloudflared ? cloudflared.detail : 'cloudflared installation failed';
      console.warn(`[WebUI] Public tunnel unavailable: ${detail}`);
    }
  }

  return toDesktopHandle(handle, allowRemote);
}

/**
 * Stop the currently running WebUI instance, if any. No-op when nothing is running.
 */
export async function stopDesktopWebUI(): Promise<void> {
  const handle = currentHandle;
  if (!handle) return;
  currentHandle = null;
  currentInitialPassword = undefined;
  currentPublicUrl = undefined;
  stopTunnel(WEBUI_TUNNEL_KEY);
  try {
    await handle.stop();
  } catch (err) {
    console.error('[WebUI] stop error:', err);
  }
}

/**
 * Snapshot of the currently running WebUI. Returns a stopped-state descriptor
 * when nothing is running, so callers don't need to branch on null.
 */
export function getDesktopWebUIStatus(): {
  running: boolean;
  port: number;
  allowRemote: boolean;
  localUrl: string;
  networkUrl?: string;
  lanIP?: string;
  candidateLanIPs?: string[];
  publicUrl?: string;
  initialPassword?: string;
} {
  if (!currentHandle) {
    const candidateLanIPs = getCandidateLanIPs();
    const lanIP = candidateLanIPs[0];
    return {
      running: false,
      port: DEFAULT_WEBUI_PORT,
      allowRemote: false,
      localUrl: `http://localhost:${DEFAULT_WEBUI_PORT}`,
      lanIP,
      candidateLanIPs,
    };
  }
  const candidateLanIPs = currentHandle.allowRemote ? getCandidateLanIPs() : [];
  const lanIP = currentHandle.lanIP ?? candidateLanIPs[0];
  return {
    running: true,
    port: currentHandle.port,
    allowRemote: currentHandle.allowRemote,
    localUrl: currentHandle.localUrl,
    networkUrl: lanIP ? `http://${lanIP}:${currentHandle.port}` : currentHandle.networkUrl,
    lanIP,
    candidateLanIPs,
    publicUrl: currentPublicUrl,
    initialPassword: currentInitialPassword,
  };
}

export const restoreDesktopWebUIFromPreferences = async (): Promise<void> => {
  const { enabled, allowRemote, port } = await readWebUIDesktopPreferences();
  if (!enabled) return;

  const preferredPort = port ?? DEFAULT_WEBUI_PORT;

  try {
    const handle = await startDesktopWebUI({ port: preferredPort, allowRemote });
    console.log(
      `[WebUI] Auto-restored from desktop preferences (port=${handle.port}, allowRemote=${handle.allowRemote})`
    );
  } catch (error) {
    // Reconcile the persisted preference with reality. Leaving enabled=true
    // means every subsequent launch will silently re-fail the same way, and
    // the Settings page's Switch would render "on" against an empty 25808.
    console.error('[WebUI] Failed to auto-restore from desktop preferences:', error);
    await writeWebUIDesktopEnabled(false);
  }
};

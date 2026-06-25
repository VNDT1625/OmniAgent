/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `cloudflareTunnel` — expose local services to the Internet on demand via
 * Cloudflare **quick tunnels** (`cloudflared tunnel --url ...`). This lets
 * collaborators on a DIFFERENT network join: peers only open the returned
 * `https://<random>.trycloudflare.com` URLs — no account, no install, no router
 * changes (works behind CGNAT, supports the WebSocket co-editing needs).
 *
 * Online sharing needs TWO public origins, so this module manages tunnels by a
 * string key:
 *  - `ds`   → the ONLYOFFICE Document Server (peers load api.js + websocket)
 *  - `host` → our integration host (peers hit `/collab/join` for the password
 *             gate; the file download/callback stay local to the host machine)
 *
 * Security: a quick tunnel makes the service reachable from the public Internet
 * for its lifetime. Access is still gated by the collaboration password (see
 * {@link collabServer}); the bridge enforces a STRONG password for Internet
 * sharing. Data transits Cloudflare's edge — surfaced to the user.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';

/** Result of starting a tunnel. */
export type TunnelResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'not-installed' | 'start-failed' | 'timeout'; detail?: string };

type Tunnel = { proc: ChildProcess; url: string | null };
const tunnels = new Map<string, Tunnel>();

/** Directory where we keep an app-managed cloudflared binary (download fallback). */
const managedDir = (): string => join(app.getPath('userData'), 'tools');
/** Full path of the app-managed cloudflared binary. */
const managedPath = (): string => join(managedDir(), process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared');

/** Resolve a usable `cloudflared` binary path; falls back to PATH lookup. */
const resolveCloudflared = (): string => {
  // 1) App-managed download (most reliable once installed by us).
  if (existsSync(managedPath())) return managedPath();
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const la = process.env.LOCALAPPDATA ?? '';
    const candidates = [
      `${pf}\\cloudflared\\cloudflared.exe`,
      `${pf86}\\cloudflared\\cloudflared.exe`,
      la ? `${la}\\Microsoft\\WinGet\\Links\\cloudflared.exe` : '',
    ].filter((p) => p && existsSync(p));
    if (candidates.length > 0) return candidates[0];
  } else {
    const candidates = ['/usr/local/bin/cloudflared', '/usr/bin/cloudflared', '/opt/homebrew/bin/cloudflared'].filter(
      (p) => existsSync(p)
    );
    if (candidates.length > 0) return candidates[0];
  }
  return 'cloudflared'; // rely on PATH
};

/** Whether cloudflared can be launched at all (quick probe). */
export const isCloudflaredAvailable = (): Promise<boolean> =>
  new Promise((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    try {
      const child = spawn(resolveCloudflared(), ['--version'], { windowsHide: true });
      child.on('error', () => done(false));
      child.on('close', (code) => done(code === 0));
      setTimeout(() => {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        done(false);
      }, 6000);
    } catch {
      done(false);
    }
  });

/** Outcome of {@link ensureCloudflared}. */
export type EnsureCloudflaredResult = { ok: true; installed: boolean } | { ok: false; detail: string };

/** Official direct-download URL of the cloudflared binary for this platform. */
const downloadUrlFor = (): string | null => {
  const repo = 'https://github.com/cloudflare/cloudflared/releases/latest/download';
  if (process.platform === 'win32') {
    return `${repo}/cloudflared-windows-${process.arch === 'arm64' ? 'arm64' : 'amd64'}.exe`;
  }
  if (process.platform === 'darwin') {
    // macOS ships a .tgz; we handle direct binary only for win/linux. mac falls back to brew.
    return null;
  }
  // linux
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'arm' ? 'arm' : 'amd64';
  return `${repo}/cloudflared-linux-${arch}`;
};

/** Run a command to completion; resolve with exit code (best-effort). */
const runToEnd = (cmd: string, args: string[], timeoutMs = 180000): Promise<number> =>
  new Promise((resolve) => {
    let child: ChildProcess;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch {
      resolve(-1);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve(-1);
    }, timeoutMs);
    child.on('error', () => {
      clearTimeout(timer);
      resolve(-1);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });

/** Download the cloudflared binary directly into the app-managed tools dir. */
const downloadBinary = async (): Promise<boolean> => {
  const url = downloadUrlFor();
  if (!url) return false;
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) });
    if (!res.ok || !res.body) return false;
    mkdirSync(managedDir(), { recursive: true });
    const bytes = Buffer.from(await res.arrayBuffer());
    await writeFile(managedPath(), bytes);
    if (process.platform !== 'win32') {
      await chmod(managedPath(), 0o755);
    }
    return existsSync(managedPath());
  } catch {
    return false;
  }
};

/**
 * Ensure cloudflared is installed, installing it on demand if missing.
 *
 * Strategy (best-effort, no admin rights needed for the primary path):
 *  1. Already available → done.
 *  2. Direct download the official binary into the app's userData/tools (win/linux).
 *  3. Fallback to a package manager (winget on Windows, brew on macOS).
 *
 * @returns `{ ok, installed }` where `installed` is true if we installed it now.
 */
export const ensureCloudflared = async (): Promise<EnsureCloudflaredResult> => {
  if (await isCloudflaredAvailable()) return { ok: true, installed: false };

  // 2) Direct binary download (works without admin / package managers).
  if (await downloadBinary()) {
    if (await isCloudflaredAvailable()) return { ok: true, installed: true };
  }

  // 3) Package-manager fallback.
  if (process.platform === 'win32') {
    const code = await runToEnd('winget', [
      'install',
      '--id',
      'Cloudflare.cloudflared',
      '-e',
      '--silent',
      '--accept-source-agreements',
      '--accept-package-agreements',
    ]);
    if (code === 0 && (await isCloudflaredAvailable())) return { ok: true, installed: true };
  } else if (process.platform === 'darwin') {
    const code = await runToEnd('brew', ['install', 'cloudflared']);
    if (code === 0 && (await isCloudflaredAvailable())) return { ok: true, installed: true };
  }

  return { ok: false, detail: 'Could not install cloudflared automatically. Install it manually, then retry.' };
};

/** Match the public quick-tunnel URL in cloudflared output. */
const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

/**
 * Start (or reuse) a quick tunnel named `key` pointing at `localUrl`. Resolves
 * with the public URL once cloudflared prints it.
 */
export const startTunnel = (key: string, localUrl: string, timeoutMs = 40000): Promise<TunnelResult> =>
  new Promise((resolve) => {
    const existing = tunnels.get(key);
    if (existing && existing.url) {
      resolve({ ok: true, url: existing.url });
      return;
    }
    let settled = false;
    const finish = (result: TunnelResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(resolveCloudflared(), ['tunnel', '--no-autoupdate', '--url', localUrl], { windowsHide: true });
    } catch {
      finish({ ok: false, reason: 'not-installed' });
      return;
    }

    const entry: Tunnel = { proc: child, url: null };
    tunnels.set(key, entry);
    let sawSpawnError = false;

    const onData = (buf: Buffer): void => {
      const match = buf.toString().match(URL_RE);
      if (match && !entry.url) {
        entry.url = match[0];
        finish({ ok: true, url: entry.url });
      }
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData); // cloudflared prints the URL to stderr

    child.on('error', () => {
      sawSpawnError = true;
      tunnels.delete(key);
      finish({ ok: false, reason: 'not-installed' });
    });
    child.on('close', () => {
      tunnels.delete(key);
      if (!settled && !sawSpawnError) finish({ ok: false, reason: 'start-failed' });
    });

    setTimeout(() => {
      if (!settled) {
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        tunnels.delete(key);
        finish({ ok: false, reason: 'timeout' });
      }
    }, timeoutMs);
  });

/** The active public URL for a tunnel key, or null. */
export const getTunnelUrl = (key: string): string | null => tunnels.get(key)?.url ?? null;

/** Stop a single tunnel (best-effort). */
export const stopTunnel = (key: string): void => {
  const entry = tunnels.get(key);
  if (entry) {
    try {
      entry.proc.kill();
    } catch {
      /* ignore */
    }
    tunnels.delete(key);
  }
};

/** Stop all tunnels (e.g. unpublish / shutdown). */
export const stopAllTunnels = (): void => {
  const keys = Array.from(tunnels.keys());
  for (const key of keys) stopTunnel(key);
};

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * On-demand ONLYOFFICE Document Server manager (Yêu cầu 2a — "chỉ gọi ra khi
 * dùng tới").
 *
 * The Document Server is the heavy editor engine. We do NOT bundle it (~GB);
 * instead this manager, when the user opens a document for full editing:
 *
 *  1. If a Document Server URL is already configured & reachable → use it.
 *  2. Otherwise, if Docker is available, start the official
 *     `onlyoffice/documentserver` container on a free port, wait until its
 *     healthcheck passes, and return its URL. If the Docker daemon is stopped,
 *     it tries to launch Docker Desktop first; on first run it pulls the image.
 *  3. The container is stopped when idle (no active edit sessions) to honor the
 *     "only when needed" requirement.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs. Uses `docker`
 * via child_process — a heavy, externally-visible action, so failures degrade
 * gracefully (the renderer falls back to asking for a manual URL).
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

/** Container name we manage so repeated launches reuse one instance. */
const CONTAINER_NAME = 'aionui-onlyoffice';
const IMAGE = 'onlyoffice/documentserver:latest';
const DEFAULT_PORT = 8080;
/** Default URL of the managed container — probed first as a fast path. */
const DEFAULT_URL = `http://localhost:${DEFAULT_PORT}`;
/** Path of the Document Server config file inside the container. */
const LOCAL_JSON_PATH = '/etc/onlyoffice/documentserver/local.json';

/**
 * Resolve the `docker` executable. Electron GUI processes on Windows often do
 * NOT inherit the Docker CLI on PATH (it lives under the install dir), which
 * made `docker --version` fail and falsely report "Docker not installed" even
 * while a container was running. We try PATH first, then well-known install
 * locations, and cache the winner.
 */
let cachedDockerCmd: string | null = null;
const dockerCandidates = (): string[] => {
  const list = ['docker'];
  if (process.platform === 'win32') {
    const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
    const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
    const la = process.env.LOCALAPPDATA ?? '';
    list.push(
      `${pf}\\Docker\\Docker\\resources\\bin\\docker.exe`,
      `${pf}\\Docker\\Docker\\resources\\docker.exe`,
      `${pf86}\\Docker\\Docker\\resources\\bin\\docker.exe`,
      la ? `${la}\\Docker\\Docker\\resources\\bin\\docker.exe` : ''
    );
  } else {
    list.push('/usr/local/bin/docker', '/usr/bin/docker', '/opt/homebrew/bin/docker');
  }
  return list.filter((p) => p.length > 0);
};

/** Run a command, capturing stdout; resolves with {code, stdout, stderr}. */
const run = (
  cmd: string,
  args: string[],
  timeoutMs = 20000
): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      resolve({ code: -1, stdout, stderr: `${stderr}\n[timeout]` });
    }, timeoutMs);
    child.stdout?.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

/** Resolve & cache a working `docker` command path, or null if none works. */
const resolveDockerCmd = async (): Promise<string | null> => {
  if (cachedDockerCmd && (await run(cachedDockerCmd, ['--version'], 6000)).code === 0) {
    return cachedDockerCmd;
  }
  for (const candidate of dockerCandidates()) {
    // PATH entries ('docker') need no existence check; absolute paths do.
    if (candidate !== 'docker' && !existsSync(candidate)) continue;
    const res = await run(candidate, ['--version'], 6000);
    if (res.code === 0) {
      cachedDockerCmd = candidate;
      return candidate;
    }
  }
  return null;
};

/** Run a docker subcommand using the resolved binary. */
const docker = async (args: string[], timeoutMs = 20000): Promise<{ code: number; stdout: string; stderr: string }> => {
  const cmd = await resolveDockerCmd();
  if (!cmd) return { code: -1, stdout: '', stderr: 'docker not found' };
  return run(cmd, args, timeoutMs);
};

/** Whether the Docker daemon is reachable. */
export const isDockerRunning = async (): Promise<boolean> => {
  const res = await docker(['info', '--format', '{{.ServerVersion}}'], 8000);
  return res.code === 0 && res.stdout.trim().length > 0;
};

/** Whether `docker` is installed at all (daemon may still be stopped). */
export const isDockerInstalled = async (): Promise<boolean> => {
  return (await resolveDockerCmd()) !== null;
};

/**
 * Try to launch Docker Desktop (the daemon) without blocking. Platform-aware:
 * Windows starts `Docker Desktop.exe`, macOS opens the app, Linux tries the
 * `systemctl --user start docker-desktop` / `docker desktop start` paths.
 * Best-effort — returns whether a launch command was issued.
 */
const launchDockerDesktop = (): boolean => {
  try {
    if (process.platform === 'win32') {
      const candidates = [
        `${process.env.ProgramFiles ?? 'C:\\Program Files'}\\Docker\\Docker\\Docker Desktop.exe`,
        `${process.env.LOCALAPPDATA ?? ''}\\Docker\\Docker Desktop.exe`,
      ].filter((p) => p && existsSync(p));
      if (candidates.length === 0) return false;
      const child = spawn(candidates[0], [], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      return true;
    }
    if (process.platform === 'darwin') {
      const child = spawn('open', ['-a', 'Docker'], { detached: true, stdio: 'ignore' });
      child.unref();
      return true;
    }
    // Linux: best-effort, `docker desktop start` is a no-op if not installed.
    const child = spawn('sh', ['-c', 'systemctl --user start docker-desktop || docker desktop start'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
};

/** Poll until the Docker daemon answers `docker info`, up to `timeoutMs`. */
const waitForDockerDaemon = async (timeoutMs = 90000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDockerRunning()) return true;
    await new Promise((r) => setTimeout(r, 3000));
  }
  return false;
};

/** Whether the managed image is already pulled locally. */
const imageExists = async (): Promise<boolean> => {
  const res = await docker(['images', '-q', IMAGE], 10000);
  return res.code === 0 && res.stdout.trim().length > 0;
};

/** Pull the Document Server image (first run only — can be large/slow). */
const pullImage = async (): Promise<boolean> => {
  const res = await docker(['pull', IMAGE], 1200000);
  return res.code === 0;
};

/** Probe a Document Server URL for readiness (its healthcheck endpoint). */
export const isServerReachable = async (url: string): Promise<boolean> => {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/healthcheck`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return false;
    const text = (await res.text()).trim().toLowerCase();
    return text.includes('true') || res.status === 200;
  } catch {
    return false;
  }
};

/** Find the host port our managed container is published on, if running. */
const findManagedPort = async (): Promise<number | null> => {
  // `docker port <name> 80/tcp` → e.g. "0.0.0.0:8080" ; empty if not running.
  const res = await docker(['port', CONTAINER_NAME, '80/tcp'], 8000);
  if (res.code !== 0) return null;
  const match = res.stdout.match(/:(\d+)\s*$/m);
  return match ? Number(match[1]) : null;
};

/** Whether our managed container exists (any state). */
const containerExists = async (): Promise<boolean> => {
  const res = await docker(['ps', '-a', '--filter', `name=^/${CONTAINER_NAME}$`, '--format', '{{.Names}}'], 8000);
  return res.code === 0 && res.stdout.includes(CONTAINER_NAME);
};

/** Whether our managed container is currently running. */
const containerRunning = async (): Promise<boolean> => {
  const res = await docker(['ps', '--filter', `name=^/${CONTAINER_NAME}$`, '--format', '{{.Names}}'], 8000);
  return res.code === 0 && res.stdout.includes(CONTAINER_NAME);
};

/**
 * Whether our managed container was created with JWT disabled. The official
 * image enables JWT by default (v7.2+), which makes the editor reject our
 * unsigned documents. We run a local, localhost-only, single-user server, so
 * we disable JWT — but a container created before this fix must be recreated.
 */
const containerHasJwtDisabled = async (): Promise<boolean> => {
  const res = await docker(['inspect', '--format', '{{range .Config.Env}}{{println .}}{{end}}', CONTAINER_NAME], 8000);
  if (res.code !== 0) return false;
  return /JWT_ENABLED=false/i.test(res.stdout);
};

/** Remove our managed container (force), e.g. to recreate it with new config. */
const removeContainer = async (): Promise<void> => {
  await docker(['rm', '-f', CONTAINER_NAME], 30000);
};

/**
 * ONLYOFFICE blocks downloads from private IPs by default (SSRF guard) AND caps
 * the converter download size at ~100 MB. Our integration host is reached via
 * `host.docker.internal` (a private IP), and large documents (e.g. a 300 MB PDF)
 * exceed the default size cap — both make the Document Server refuse to
 * fetch/open the document. This patches `local.json` inside the container to
 *  (a) allow private IPs, and
 *  (b) raise the converter / co-authoring size limits to 2 GB,
 * then reloads the docservice. Idempotent — safe to run on every ensure.
 */
const SETTINGS_MARKER = 'maxDownloadBytes';
/** Generous size cap (2 GB) for converter download + co-authoring temp upload. */
const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const ensureServerLimits = async (): Promise<void> => {
  // Already patched (size limit present)? Then skip the (slow) reload.
  const check = await docker(['exec', CONTAINER_NAME, 'grep', '-l', SETTINGS_MARKER, LOCAL_JSON_PATH], 8000);
  if (check.code === 0 && check.stdout.includes(LOCAL_JSON_PATH)) return;

  // Merge the request-filtering-agent flags AND the size limits into local.json
  // with python3 (always present in the image). One -c script avoids quoting woes.
  const py = [
    'import json',
    `p='${LOCAL_JSON_PATH}'`,
    'd=json.load(open(p))',
    "s=d.setdefault('services',{}).setdefault('CoAuthoring',{})",
    // Allow downloads from private IPs (host.docker.internal).
    "rfa=s.setdefault('request-filtering-agent',{})",
    "rfa['allowPrivateIPAddress']=True",
    "rfa['allowMetaIPAddress']=True",
    // Raise the converter download size limit (default ~100 MB) so large
    // documents (e.g. a 300 MB PDF) can be fetched + opened.
    `fc=d.setdefault('FileConverter',{}).setdefault('converter',{})`,
    `fc['maxDownloadBytes']=${MAX_FILE_BYTES}`,
    `fc['downloadAttemptMaxCount']=3`,
    'json.dump(d,open(p,"w"),indent=2)',
  ].join('; ');
  await docker(['exec', CONTAINER_NAME, 'python3', '-c', py], 20000);
  // Reload the document service so the new config takes effect.
  await docker(['exec', CONTAINER_NAME, 'supervisorctl', 'restart', 'ds:docservice'], 30000);
};

/** Create + start the managed container with JWT disabled, pulling if needed. */
const createContainer = async (): Promise<EnsureServerResult | null> => {
  if (!(await imageExists())) {
    const pulled = await pullImage();
    if (!pulled) {
      return { ok: false, reason: 'start-failed', detail: 'Could not pull the ONLYOFFICE Document Server image.' };
    }
  }
  const startRes = await docker(
    [
      'run',
      '-d',
      '--name',
      CONTAINER_NAME,
      '-e',
      'JWT_ENABLED=false',
      '--add-host',
      'host.docker.internal:host-gateway',
      '-p',
      `${DEFAULT_PORT}:80`,
      IMAGE,
    ],
    120000
  );
  if (startRes.code !== 0) {
    return { ok: false, reason: 'start-failed', detail: startRes.stderr.slice(0, 400) };
  }
  return null; // success — caller waits for readiness
};

/** Result of ensuring a Document Server is available. */
export type EnsureServerResult =
  | { ok: true; url: string; managed: boolean }
  | { ok: false; reason: 'docker-missing' | 'docker-stopped' | 'start-failed' | 'timeout'; detail?: string };

/** Wait until a URL passes its healthcheck, polling up to `timeoutMs`. */
const waitUntilReady = async (url: string, timeoutMs = 120000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isServerReachable(url)) return true;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
};

/**
 * Ensure a Document Server is available, starting the managed Docker container
 * if necessary.
 *
 * @param configuredUrl - A user-provided URL to prefer (checked first).
 * @returns The reachable Document Server URL, or a typed failure reason.
 */
export const ensureDocumentServer = async (configuredUrl?: string): Promise<EnsureServerResult> => {
  // 0) FAST PATH: a user-configured URL that answers is used as-is (their server,
  //    their JWT policy — we don't manage it).
  if (configuredUrl && (await isServerReachable(configuredUrl))) {
    return { ok: true, url: configuredUrl.replace(/\/+$/, ''), managed: false };
  }

  // 0b) If the default managed port already answers AND docker isn't usable to
  //     verify config, trust it (best effort — avoids blocking when CLI is absent).
  const dockerCmd = await resolveDockerCmd();
  if (!dockerCmd) {
    if (await isServerReachable(DEFAULT_URL)) {
      return { ok: true, url: DEFAULT_URL, managed: true };
    }
    return { ok: false, reason: 'docker-missing' };
  }

  // 1) If the daemon is stopped, try to launch Docker Desktop and wait for it.
  if (!(await isDockerRunning())) {
    // A reachable default URL means a server is up even if `docker info` is racy.
    if (await isServerReachable(DEFAULT_URL)) {
      return { ok: true, url: DEFAULT_URL, managed: true };
    }
    const launched = launchDockerDesktop();
    if (!launched) {
      return { ok: false, reason: 'docker-stopped' };
    }
    const up = await waitForDockerDaemon();
    if (!up) {
      return { ok: false, reason: 'docker-stopped', detail: 'Docker Desktop is starting — please retry in a moment.' };
    }
  }

  // 2) Reconcile the managed container. If it exists but was created with JWT
  //    enabled (older builds / manual run), recreate it with JWT disabled so the
  //    editor accepts our unsigned documents.
  if (await containerExists()) {
    const jwtOk = await containerHasJwtDisabled();
    if (!jwtOk) {
      await removeContainer();
      const failed = await createContainer();
      if (failed) return failed;
    } else if (!(await containerRunning())) {
      await docker(['start', CONTAINER_NAME], 30000);
    }
  } else {
    const failed = await createContainer();
    if (failed) return failed;
  }

  // 3) Wait until the (now correctly-configured) server is ready.
  const port = (await findManagedPort()) ?? DEFAULT_PORT;
  const url = `http://localhost:${port}`;
  if (await waitUntilReady(url)) {
    // 4) Allow downloads from private IPs (host.docker.internal) AND raise the
    //    file-size limits so large documents (e.g. a 300 MB PDF) open. Reloads
    //    docservice if a change was needed.
    await ensureServerLimits();
    if (await waitUntilReady(url, 60000)) {
      return { ok: true, url, managed: true };
    }
  }
  return { ok: false, reason: 'timeout' };
};

/** Stop the managed container (best-effort), e.g. when editing finishes. */
export const stopManagedServer = async (): Promise<void> => {
  await docker(['stop', CONTAINER_NAME], 30000);
};

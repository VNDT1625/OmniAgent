/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { startIdeMcpHost, stopIdeMcpHost } from './ideMcpHost';
import { buildOmniNodeIdeServer, createTerminalAgentService } from './omniNodeWiring';

const DEFAULT_PORT = 17890;
const SIDECAR_NAME = 'omni-mcp-sidecar';

type Mode = 'start' | 'rescue' | 'doctor' | 'health' | 'stop';

type SidecarPaths = {
  repoRoot: string;
  stateDir: string;
  statePath: string;
  logDir: string;
  logPath: string;
};

type SidecarState = {
  pid: number;
  repoRoot: string;
  url: string;
  healthUrl: string;
  port: number;
  logPath: string;
  startedAt: string;
  mode: string;
};

const main = async (): Promise<void> => {
  const mode = parseMode(process.argv[2]);
  const repoRoot = path.resolve(process.env.OMNI_REPO_PATH || process.cwd());
  const paths = resolvePaths(repoRoot);
  const port = Number(process.env.OMNI_MCP_PORT || DEFAULT_PORT);

  if (mode === 'doctor') {
    await runDoctor(paths, port);
    return;
  }
  if (mode === 'health') {
    await runHealth(paths, port);
    return;
  }
  if (mode === 'stop') {
    await runStop(paths, port);
    return;
  }

  await startSidecar(paths, port, mode);
};

const parseMode = (raw?: string): Mode => {
  if (raw === 'rescue' || raw === 'doctor' || raw === 'health' || raw === 'stop') return raw;
  return 'start';
};

const resolvePaths = (repoRoot: string): SidecarPaths => {
  const stateDir = path.join(repoRoot, '.omni-sidecar');
  const logDir = existsSync(path.join(repoRoot, '.omni'))
    ? path.join(repoRoot, '.omni', 'logs')
    : existsSync(path.join(repoRoot, '.aionui'))
      ? path.join(repoRoot, '.aionui', 'logs')
      : path.join(stateDir, 'logs');
  return {
    repoRoot,
    stateDir,
    statePath: path.join(stateDir, 'omni-mcp-sidecar.json'),
    logDir,
    logPath: path.join(logDir, 'omni-mcp-sidecar.log'),
  };
};

const startSidecar = async (paths: SidecarPaths, port: number, mode: 'start' | 'rescue'): Promise<void> => {
  await mkdir(paths.stateDir, { recursive: true });
  await mkdir(paths.logDir, { recursive: true });
  setupLogging(paths.logPath, mode === 'rescue');

  const existing = await fetchHealth(`http://127.0.0.1:${port}/health`);
  if (existing.ok) {
    console.log(`[${SIDECAR_NAME}] already running on port ${port}`);
    console.log(JSON.stringify(existing.data, null, 2));
    return;
  }

  const startedAt = new Date().toISOString();
  const host = await startIdeMcpHost({
    port,
    buildServer: buildOmniNodeIdeServer,
    serverName: SIDECAR_NAME,
    allowShutdown: true,
    health: {
      mode,
      pid: process.pid,
      repoRoot: paths.repoRoot,
      logPath: paths.logPath,
      source: 'standalone',
    },
  });

  const state: SidecarState = {
    pid: process.pid,
    repoRoot: paths.repoRoot,
    url: host.url,
    healthUrl: host.healthUrl,
    port: host.port,
    logPath: paths.logPath,
    startedAt,
    mode,
  };
  await writeFile(paths.statePath, `${JSON.stringify(state, null, 2)}\n`, 'utf-8');

  console.log(`[${SIDECAR_NAME}] ready`);
  console.log(`MCP SSE: ${host.url}`);
  console.log(`Health:  ${host.healthUrl}`);
  console.log(`Repo:    ${paths.repoRoot}`);
  console.log(`Logs:    ${paths.logPath}`);
  console.log(`State:   ${paths.statePath}`);

  process.on('SIGINT', () => void shutdown(paths));
  process.on('SIGTERM', () => void shutdown(paths));
};

const shutdown = async (paths: SidecarPaths): Promise<void> => {
  console.log(`[${SIDECAR_NAME}] stopping`);
  await stopIdeMcpHost();
  await rm(paths.statePath, { force: true });
  process.exit(0);
};

const runDoctor = async (paths: SidecarPaths, port: number): Promise<void> => {
  const terminal = createTerminalAgentService();
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  checks.push({ name: 'repo path', ok: existsSync(paths.repoRoot), detail: paths.repoRoot });
  checks.push({ name: 'log path', ok: true, detail: paths.logPath });

  const git = await terminal.run('git', ['--version'], { cwd: paths.repoRoot, timeoutMs: 5000 });
  checks.push({ name: 'git', ok: git.exitCode === 0, detail: oneLine(git.stdout || git.stderr) });

  const node = await terminal.run(process.execPath, ['--version'], { cwd: paths.repoRoot, timeoutMs: 5000 });
  checks.push({
    name: 'node',
    ok: node.exitCode === 0,
    detail: oneLine(node.stdout || node.stderr || process.execPath),
  });

  const bun = await terminal.run('bun', ['--version'], { cwd: paths.repoRoot, timeoutMs: 5000 });
  checks.push({ name: 'bun', ok: bun.exitCode === 0, detail: oneLine(bun.stdout || bun.stderr || 'bun not found') });

  const health = await fetchHealth(`http://127.0.0.1:${port}/health`);
  checks.push({
    name: `port ${port}`,
    ok: true,
    detail: health.ok
      ? `sidecar already running: ${health.data?.url ?? ''}`
      : 'available or no sidecar health response',
  });

  console.log(`${SIDECAR_NAME} doctor`);
  for (const check of checks) {
    console.log(`${check.ok ? 'OK ' : 'ERR'} ${check.name}: ${check.detail}`);
  }

  if (checks.some((check) => !check.ok)) process.exitCode = 1;
};

const runHealth = async (paths: SidecarPaths, port: number): Promise<void> => {
  const state = await readState(paths.statePath);
  const healthUrl = state?.healthUrl ?? `http://127.0.0.1:${port}/health`;
  const health = await fetchHealth(healthUrl);
  if (!health.ok) {
    console.log(`${SIDECAR_NAME} is not responding at ${healthUrl}`);
    process.exitCode = 1;
    return;
  }
  console.log(JSON.stringify(health.data, null, 2));
};

const runStop = async (paths: SidecarPaths, port: number): Promise<void> => {
  const state = await readState(paths.statePath);
  const targetPort = state?.port ?? port;
  const result = await httpRequest(`http://127.0.0.1:${targetPort}/shutdown`, 'POST');
  if (!result.ok) {
    console.log(`${SIDECAR_NAME} did not accept stop request. Use Ctrl+C in its terminal if it is foregrounded.`);
    process.exitCode = 1;
    return;
  }
  await rm(paths.statePath, { force: true });
  console.log(`${SIDECAR_NAME} stop requested.`);
};

const setupLogging = (logPath: string, truncate: boolean): void => {
  if (truncate) void writeFile(logPath, '', 'utf-8');
  const write = (level: string, args: unknown[]): void => {
    const line = `[${new Date().toISOString()}] ${level} ${args.map(formatLogArg).join(' ')}\n`;
    void writeFile(logPath, line, { encoding: 'utf-8', flag: 'a' });
  };
  const originalLog = console.log.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  console.log = (...args: unknown[]) => {
    write('INFO', args);
    originalLog(...args);
  };
  console.warn = (...args: unknown[]) => {
    write('WARN', args);
    originalWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    write('ERROR', args);
    originalError(...args);
  };
};

const readState = async (statePath: string): Promise<SidecarState | null> => {
  try {
    return JSON.parse(await readFile(statePath, 'utf-8')) as SidecarState;
  } catch {
    return null;
  }
};

const fetchHealth = async (url: string): Promise<{ ok: boolean; data?: Record<string, unknown> }> => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) return { ok: false };
    return { ok: true, data: (await response.json()) as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
};

const httpRequest = async (url: string, method: string): Promise<{ ok: boolean }> =>
  new Promise((resolve) => {
    const req = http.request(url, { method, timeout: 1500 }, (res) => {
      res.resume();
      resolve({ ok: (res.statusCode ?? 500) < 400 });
    });
    req.on('error', () => resolve({ ok: false }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false });
    });
    req.end();
  });

const oneLine = (value: string): string => value.trim().replace(/\s+/g, ' ') || '(no output)';

const formatLogArg = (value: unknown): string => {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

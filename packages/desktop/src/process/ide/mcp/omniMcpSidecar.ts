/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as path from 'node:path';
import { createCredentialStore, type Credential, type ICredentialStore } from '../../automation/credentialStore';
import { createOmniGatewayRuntime, type OmniGatewayRuntime } from '../../omni-gateway/omniGatewayRuntime';
import { stopOmniTunnel } from '../../omni-gateway/omniGatewayTunnel';
import { createOmniSecurityStore } from '../../omni-gateway/auth/omniGatewaySecurityStore';
import { createOmniOAuthStore } from '../../omni-gateway/auth/omniGatewayOAuthStore';
import { startIdeMcpHost, stopIdeMcpHost } from './ideMcpHost';
import {
  buildOmniNodeIdeServer,
  createGitAgentService,
  createNodeIdeMcpService,
  createNodeTeamEditService,
  createTerminalAgentService,
} from './omniNodeWiring';

const DEFAULT_PORT = 17890;
const DEFAULT_EXTERNAL_PORT = 47821;
const SIDECAR_NAME = 'omni-mcp-sidecar';
const OMNI_GATEWAY_CREDENTIAL_ID = 'omni-gateway-token';
const OMNI_GATEWAY_TOKEN_BYTES = 32;

type Mode = 'start' | 'rescue' | 'rescue-external' | 'doctor' | 'health' | 'stop';

type ParsedMode = {
  mode: Mode;
  tunnel: boolean;
};

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
  ideMcpUrl?: string;
  ideSseUrl?: string;
  publicMcpUrl?: string;
  tunnelUrl?: string;
};

let externalRuntime: OmniGatewayRuntime | undefined;

const main = async (): Promise<void> => {
  const parsed = parseMode(process.argv.slice(2));
  const { mode } = parsed;
  const repoRoot = path.resolve(process.env.OMNI_REPO_PATH || process.cwd());
  const paths = resolvePaths(repoRoot);
  const port = Number(process.env.OMNI_MCP_PORT || DEFAULT_PORT);
  const externalPort = Number(
    process.env.OMNI_GATEWAY_PORT || process.env.OMNI_MCP_EXTERNAL_PORT || DEFAULT_EXTERNAL_PORT
  );

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

  if (mode === 'rescue-external') {
    await startExternalRescue(paths, port, externalPort, { tunnel: parsed.tunnel });
    return;
  }

  const sidecarStatus = await startSidecar(paths, port, mode, { setupLog: true });
  if (sidecarStatus === 'existing') await exitStatusCommand();
};

const parseMode = (args: string[]): ParsedMode => {
  const raw = args[0];
  const tunnel = args.includes('--tunnel') || process.env.OMNI_RESCUE_TUNNEL === '1';
  if (raw === 'rescue' && args.includes('--local')) return { mode: 'rescue', tunnel: false };
  if (raw === 'rescue' && args.includes('--external')) return { mode: 'rescue-external', tunnel };
  if (raw === 'rescue' || raw === 'doctor' || raw === 'health' || raw === 'stop') return { mode: raw, tunnel: false };
  return { mode: 'start', tunnel: false };
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

const resolveGatewayDataDir = (): string => {
  const override = process.env.OMNI_GATEWAY_USER_DATA_DIR || process.env.OMNI_APP_USER_DATA_DIR;
  if (override?.trim()) return path.resolve(override.trim());

  const candidates =
    process.platform === 'win32'
      ? [
          path.join(
            process.env.APPDATA || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Roaming'),
            'AionUi-Dev'
          ),
          path.join(
            process.env.APPDATA || path.join(process.env.USERPROFILE || process.cwd(), 'AppData', 'Roaming'),
            'AionUi'
          ),
        ]
      : [
          path.join(process.env.HOME || process.cwd(), '.config', 'AionUi-Dev'),
          path.join(process.env.HOME || process.cwd(), '.config', 'AionUi'),
        ];

  return (
    candidates.find(
      (dir) =>
        existsSync(path.join(dir, 'automation-credentials.json')) ||
        existsSync(path.join(dir, 'omni-gateway-security.json')) ||
        existsSync(path.join(dir, 'config', 'aionui-config.txt'))
    ) ?? candidates[0]
  );
};

const gatewayCredentialStore = (dataDir: string): ICredentialStore =>
  createCredentialStore({ dir: dataDir, encryptionKey: createHash('sha256').update(dataDir).digest() });

const findGatewayCredential = async (store: ICredentialStore): Promise<Credential | undefined> =>
  store.list().then((list) => list.find((c) => c.id === OMNI_GATEWAY_CREDENTIAL_ID));

const readOrCreateBearerToken = async (dataDir: string): Promise<{ token: string; source: string }> => {
  const store = gatewayCredentialStore(dataDir);
  const envToken = process.env.OMNI_GATEWAY_TOKEN?.trim();
  if (envToken) {
    await store.save({
      id: OMNI_GATEWAY_CREDENTIAL_ID,
      name: 'AionUi External MCP Gateway',
      kind: 'token',
      fields: { bearer: envToken },
    });
    return { token: envToken, source: 'env' };
  }

  const cred = await findGatewayCredential(store);
  if (cred) {
    const decrypted = await store.getDecrypted(cred.id);
    const token = decrypted?.bearer;
    if (typeof token === 'string' && token.length > 0) return { token, source: 'app-credential' };
  }

  const token = randomBytes(OMNI_GATEWAY_TOKEN_BYTES).toString('hex');
  await store.save({
    id: OMNI_GATEWAY_CREDENTIAL_ID,
    name: 'AionUi External MCP Gateway',
    kind: 'token',
    fields: { bearer: token },
  });
  return { token, source: 'app-credential-created' };
};

const decodeConfigFile = (raw: string): Record<string, unknown> => {
  try {
    return JSON.parse(decodeURIComponent(Buffer.from(raw.trim(), 'base64').toString('utf-8'))) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
};

const readSavedGatewayConfig = async (dataDir: string): Promise<Record<string, unknown>> => {
  const configPath = path.join(dataDir, 'config', 'aionui-config.txt');
  try {
    const allConfig = decodeConfigFile(await readFile(configPath, 'utf-8'));
    const cfg = allConfig['externalMcp.config'];
    return cfg && typeof cfg === 'object' ? (cfg as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);
const str = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);
const num = (value: unknown, fallback: number): number =>
  typeof value === 'number' && value >= 1024 && value <= 65535 ? value : fallback;

const startSidecar = async (
  paths: SidecarPaths,
  port: number,
  mode: 'start' | 'rescue',
  options: { setupLog: boolean }
): Promise<'started' | 'existing'> => {
  await mkdir(paths.stateDir, { recursive: true });
  await mkdir(paths.logDir, { recursive: true });

  const existing = await fetchHealth(`http://127.0.0.1:${port}/health`);
  if (existing.ok) {
    console.log(`[${SIDECAR_NAME}] already running on port ${port}`);
    console.log(JSON.stringify(existing.data, null, 2));
    return 'existing';
  }

  if (options.setupLog) setupLogging(paths.logPath, mode === 'rescue');

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
  return 'started';
};

const startExternalRescue = async (
  paths: SidecarPaths,
  port: number,
  externalPort: number,
  options: { tunnel: boolean }
): Promise<void> => {
  await mkdir(paths.stateDir, { recursive: true });
  await mkdir(paths.logDir, { recursive: true });

  const sidecarStatus = await startSidecar(paths, port, 'rescue', { setupLog: true });

  const gatewayDataDir = resolveGatewayDataDir();
  const savedConfig = await readSavedGatewayConfig(gatewayDataDir);
  const bearer = await readOrCreateBearerToken(gatewayDataDir);
  const gatewayPort = num(savedConfig.port, externalPort);
  const existingGateway = await fetchGatewayEndpoint(`http://127.0.0.1:${gatewayPort}/ide/mcp`);
  if (existingGateway.ok) {
    const saved = await readState(paths.statePath);
    await writeFile(
      paths.statePath,
      JSON.stringify(
        {
          ...saved,
          mode: 'rescue-external',
          ideMcpUrl: `http://127.0.0.1:${gatewayPort}/ide/mcp`,
          ideSseUrl: `http://127.0.0.1:${gatewayPort}/ide/sse`,
        },
        null,
        2
      ) + '\n',
      'utf-8'
    );
    console.log('[' + SIDECAR_NAME + '] app-compatible external gateway already running');
    console.log('Gateway config dir:  ' + gatewayDataDir);
    console.log('Gateway token:       ' + bearer.source);
    console.log('MCP Streamable HTTP: http://127.0.0.1:' + gatewayPort + '/ide/mcp');
    console.log('MCP local SSE:       http://127.0.0.1:' + gatewayPort + '/ide/sse');
    console.log('Authorization:       Bearer ' + bearer.token);
    console.log('Required path:       /ide/mcp');
    console.log('Bootstrap tool:      omni_bootstrap_session');
    await attachToExistingRescue({
      healthUrl: saved?.healthUrl ?? `http://127.0.0.1:${port}/health`,
      gatewayUrl: `http://127.0.0.1:${gatewayPort}/ide/mcp`,
    });
  }
  if (sidecarStatus === 'existing') setupLogging(paths.logPath, false);
  const security = createOmniSecurityStore({
    dir: gatewayDataDir,
    encryptionKey: createHash('sha256').update(gatewayDataDir).digest(),
  });
  const oauth = createOmniOAuthStore({
    security,
    now: () => Date.now(),
    newToken: () => randomBytes(OMNI_GATEWAY_TOKEN_BYTES).toString('hex'),
    newId: () => `oc-${randomBytes(12).toString('hex')}`,
  });
  const terminal = createTerminalAgentService();
  const allowDangerous = bool(savedConfig.allowDangerous, process.env.OMNI_GATEWAY_ALLOW_DANGEROUS !== '0');
  const runtime = createOmniGatewayRuntime({
    loadSecurityState: () => security.load(),
    oauth: () => oauth,
    buildIdeDeps: () => ({
      ide: createNodeIdeMcpService(),
      terminal,
      git: createGitAgentService(terminal),
      teamEdit: createNodeTeamEditService(),
    }),
    emitProgress: (phase, detail) => {
      const suffix = detail?.message ? ': ' + detail.message : detail?.error ? ': ' + detail.error : '';
      console.log('[omni-rescue-gateway] ' + phase + suffix);
    },
    now: () => Date.now(),
    newToken: () => randomBytes(OMNI_GATEWAY_TOKEN_BYTES).toString('hex'),
    newId: () => 'omni-rescue-' + randomBytes(16).toString('hex'),
  });

  await runtime.start(
    {
      port: gatewayPort,
      rootPath: str(savedConfig.rootPath) ?? paths.repoRoot,
      allowDangerous,
      externalMode: {
        enabled:
          options.tunnel || bool((savedConfig.externalMode as { enabled?: unknown } | undefined)?.enabled, false),
      },
    },
    bearer.token
  );
  externalRuntime = runtime;

  const snapshot = runtime.snapshot();
  const gateway = snapshot.live?.host;
  const publicMcpUrl = snapshot.liveExternal ? snapshot.liveExternal.tunnelUrl + '/ide/mcp' : undefined;
  const saved = await readState(paths.statePath);
  if (saved && gateway) {
    await writeFile(
      paths.statePath,
      JSON.stringify(
        {
          ...saved,
          mode: 'rescue-external',
          ideMcpUrl: gateway.ideMcpUrl,
          ideSseUrl: gateway.ideSseUrl,
          publicMcpUrl,
          tunnelUrl: snapshot.liveExternal?.tunnelUrl,
        },
        null,
        2
      ) + '\n',
      'utf-8'
    );
  }

  console.log('[' + SIDECAR_NAME + '] app-compatible external gateway ready');
  console.log('Gateway config dir:  ' + gatewayDataDir);
  console.log('Gateway token:       ' + bearer.source);
  console.log('MCP Streamable HTTP: ' + (gateway?.ideMcpUrl ?? 'not running'));
  console.log('MCP local SSE:       ' + (gateway?.ideSseUrl ?? 'not running'));
  if (publicMcpUrl) console.log('MCP public URL:      ' + publicMcpUrl);
  console.log('Authorization:       Bearer ' + bearer.token);
  console.log('Required path:       /ide/mcp');
  console.log('Bootstrap tool:      omni_bootstrap_session');
  console.log('Auth mode:           ' + snapshot.authMode);
  console.log('Dangerous tools:     ' + (allowDangerous ? 'enabled' : 'disabled'));
  if (!publicMcpUrl) {
    console.log(
      'ChatGPT connector:   tunnel is not running; forward https://mcp.omni-mcp.xyz/ide/mcp to ' +
        (gateway?.ideMcpUrl ?? '127.0.0.1:47821/ide/mcp')
    );
  }
};

const shutdown = async (paths: SidecarPaths): Promise<void> => {
  console.log(`[${SIDECAR_NAME}] stopping`);
  stopOmniTunnel();
  await externalRuntime?.stop();
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

  await exitStatusCommand(checks.some((check) => !check.ok) ? 1 : 0);
};

const runHealth = async (paths: SidecarPaths, port: number): Promise<void> => {
  const state = await readState(paths.statePath);
  const healthUrl = state?.healthUrl ?? `http://127.0.0.1:${port}/health`;
  const health = await fetchHealth(healthUrl);
  if (!health.ok) {
    console.log(`${SIDECAR_NAME} is not responding at ${healthUrl}`);
    await exitStatusCommand(1);
  }
  console.log(JSON.stringify(health.data, null, 2));
  await exitStatusCommand();
};

const runStop = async (paths: SidecarPaths, port: number): Promise<void> => {
  const state = await readState(paths.statePath);
  const targetPort = state?.port ?? port;
  const result = await httpRequest(`http://127.0.0.1:${targetPort}/shutdown`, 'POST');
  if (!result.ok) {
    console.log(`${SIDECAR_NAME} did not accept stop request. Use Ctrl+C in its terminal if it is foregrounded.`);
    await exitStatusCommand(1);
  }
  await rm(paths.statePath, { force: true });
  console.log(`${SIDECAR_NAME} stop requested.`);
  await exitStatusCommand();
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
  const response = await httpProbe(url, 'GET');
  if (!response.ok) return { ok: false };
  try {
    return { ok: true, data: JSON.parse(response.body) as Record<string, unknown> };
  } catch {
    return { ok: false };
  }
};

const fetchGatewayEndpoint = async (url: string): Promise<{ ok: boolean }> => httpProbe(url, 'OPTIONS');

const httpProbe = async (url: string, method: string): Promise<{ ok: boolean; body: string }> =>
  new Promise((resolve) => {
    const req = http.request(url, { method, timeout: 1500, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      res.on('end', () => {
        resolve({ ok: (res.statusCode ?? 500) < 400, body: Buffer.concat(chunks).toString('utf-8') });
      });
      res.on('error', () => resolve({ ok: false, body: '' }));
    });
    req.on('error', () => resolve({ ok: false, body: '' }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, body: '' });
    });
    req.end();
  });

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

const attachToExistingRescue = async (input: { healthUrl: string; gatewayUrl: string }): Promise<never> => {
  console.log('Attached to existing rescue gateway. Keep this terminal open; Ctrl+C detaches.');

  let checking = false;
  const timer = setInterval(() => {
    if (checking) return;
    checking = true;
    void Promise.all([fetchHealth(input.healthUrl), fetchGatewayEndpoint(input.gatewayUrl)])
      .then(([health, gateway]) => {
        if (!health.ok || !gateway.ok) {
          console.error(`[${SIDECAR_NAME}] existing rescue gateway stopped responding`);
          clearInterval(timer);
          process.exit(1);
        }
      })
      .finally(() => {
        checking = false;
      });
  }, 5000);

  const detach = (): void => {
    clearInterval(timer);
    console.log(`[${SIDECAR_NAME}] detached`);
    process.exit(0);
  };
  process.once('SIGINT', detach);
  process.once('SIGTERM', detach);

  return new Promise<never>(() => undefined);
};

const exitStatusCommand = async (code = 0): Promise<never> => {
  await new Promise<void>((resolve) => process.stdout.write('', () => resolve()));
  process.exit(code);
};

const formatLogArg = (value: unknown): string => {
  if (value instanceof Error) return value.stack || value.message;
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
};

void main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
});

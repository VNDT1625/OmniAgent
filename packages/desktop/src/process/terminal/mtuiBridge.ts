/**
 * MTUI bridge — spawn the MTUI Rust CLI from Electron Main and expose
 * safe file operations, command recording, suggestions, and repair to
 * the renderer via IPC.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, isAbsolute, relative, resolve as resolvePath } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MtuiResponse {
  ok: boolean;
  [key: string]: unknown;
}

export class MtuiCliError extends Error {
  constructor(
    message: string,
    public readonly stdout: string,
    public readonly stderr: string,
    public readonly exitCode: number | null
  ) {
    super(message);
    this.name = 'MtuiCliError';
  }
}

export interface MtuiSuggestion {
  command: string;
  score: number;
  success_rate: number;
  used_count: number;
  last_used: string;
  source: string;
}

export interface MtuiSuggestResult {
  ok: boolean;
  command: string;
  query: string;
  suggestions: MtuiSuggestion[];
}

export interface MtuiRepairResult {
  ok: boolean;
  command: string;
  repair_available: boolean;
  original_command: string;
  suggested_command?: string;
  message?: string;
  source?: string;
  risk?: string;
  requires_confirm?: boolean;
}

export interface MtuiRecordRequest {
  command: string;
  exitCode: number;
  durationMs: number;
}

export interface MtuiRunRequest {
  args: string[];
}

// ---------------------------------------------------------------------------
// Resolve MTUI binary path
// ---------------------------------------------------------------------------

export function resolveMtuiPath(): string {
  const isProduction = process.env.NODE_ENV === 'production';
  const platform = process.platform;

  if (isProduction) {
    const resourceDir = process.resourcesPath ?? resolvePath(__dirname, '..', '..');
    const binName = platform === 'win32' ? 'mtui.exe' : 'mtui';
    return resolvePath(resourceDir, 'binaries', binName);
  }

  // Dev: look in the Rust cargo build output
  const binName = platform === 'win32' ? 'mtui.exe' : 'mtui';
  const installedPath =
    platform === 'win32'
      ? resolveInstalledWindowsMtui(binName)
      : resolvePath(process.env.HOME ?? '', '.local', 'bin', binName);
  if (fs.existsSync(installedPath)) return installedPath;
  const devPath = resolvePath(process.cwd(), 'packages', 'mtui', 'target', 'debug', binName);
  if (fs.existsSync(devPath)) return devPath;
  const releasePath = resolvePath(process.cwd(), 'packages', 'mtui', 'target', 'release', binName);
  if (fs.existsSync(releasePath)) return releasePath;
  return installedPath;
}

type MtuiLatestMetadata = {
  binary?: unknown;
};

function resolveLatestWindowsMtui(installDir: string): string | null {
  const latestPath = resolvePath(installDir, 'latest.json');
  try {
    const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8')) as MtuiLatestMetadata;
    if (typeof latest.binary !== 'string' || latest.binary.trim().length === 0) {
      return null;
    }
    return fs.existsSync(latest.binary) ? latest.binary : null;
  } catch {
    return null;
  }
}

export function resolveInstalledWindowsMtui(
  binName: string,
  installDir = resolvePath(process.env.LOCALAPPDATA ?? '', 'mtui')
): string {
  const latestPath = resolveLatestWindowsMtui(installDir);
  if (latestPath !== null) return latestPath;

  const primaryPath = resolvePath(installDir, binName);
  const versionsDir = resolvePath(installDir, 'versions');
  try {
    const versions = fs
      .readdirSync(versionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => resolvePath(versionsDir, entry.name, binName))
      .filter((candidate) => fs.existsSync(candidate))
      .toSorted((a, b) => b.localeCompare(a));
    return versions[0] ?? primaryPath;
  } catch {
    return primaryPath;
  }
}

// ---------------------------------------------------------------------------
// Spawn helpers
// ---------------------------------------------------------------------------

/** Get the project root (where .mtui lives, resolved from cwd). */
let _cachedProjectRoot: string | null = null;

function getProjectRoot(): string {
  if (_cachedProjectRoot) return _cachedProjectRoot;

  let current = process.cwd();
  for (let i = 0; i < 20; i++) {
    try {
      if (fs.existsSync(resolvePath(current, '.mtui')) || fs.existsSync(resolvePath(current, '.git'))) {
        _cachedProjectRoot = current;
        return current;
      }
    } catch {
      // continue walking
    }
    const parent = resolvePath(current, '..');
    if (parent === current) break;
    current = parent;
  }

  _cachedProjectRoot = process.cwd();
  return _cachedProjectRoot;
}

function resolveProjectRootForPath(filePath: string): string {
  const absolute = isAbsolute(filePath) ? filePath : resolvePath(process.cwd(), filePath);
  let current = dirname(absolute);
  for (let i = 0; i < 20; i++) {
    try {
      if (fs.existsSync(resolvePath(current, '.mtui')) || fs.existsSync(resolvePath(current, '.git'))) {
        return current;
      }
    } catch {
      // continue walking
    }
    const parent = resolvePath(current, '..');
    if (parent === current) break;
    current = parent;
  }
  return dirname(absolute);
}

function spawnMtui(args: string[], options?: { cwd?: string; stdin?: string }): Promise<string> {
  return new Promise((resolve, reject) => {
    const mtuiPath = resolveMtuiPath();
    const child = spawn(mtuiPath, args, {
      cwd: options?.cwd ?? getProjectRoot(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new MtuiCliError(stderr || stdout || `mtui exited with code ${code}`, stdout, stderr, code));
      }
    });

    child.on('error', (err) => {
      reject(new Error(`Failed to spawn mtui: ${err.message}`));
    });

    if (options?.stdin !== undefined) {
      child.stdin?.end(options.stdin);
    } else {
      child.stdin?.end();
    }
  });
}

export function parseMtuiOutput(output: string, fallbackMessage = 'mtui returned invalid JSON'): MtuiResponse {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (parsed && typeof parsed === 'object') {
      return parsed as MtuiResponse;
    }
  } catch {
    // Fall through to compact parse error response.
  }
  return { ok: false, error_type: 'PARSE_ERROR', message: output || fallbackMessage };
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

export async function runMtui(args: string[]): Promise<MtuiResponse> {
  try {
    const output = await spawnMtui(args);
    return parseMtuiOutput(output);
  } catch (err) {
    if (err instanceof MtuiCliError) {
      return parseMtuiOutput(err.stdout || err.stderr, err.message);
    }
    throw err;
  }
}

export async function runMtuiInRoot(args: string[], rootPath: string): Promise<MtuiResponse> {
  try {
    const output = await spawnMtui(args, { cwd: rootPath });
    return parseMtuiOutput(output);
  } catch (err) {
    if (err instanceof MtuiCliError) {
      return parseMtuiOutput(err.stdout || err.stderr, err.message);
    }
    throw err;
  }
}

export async function recordCommand(command: string, exitCode: number, durationMs: number): Promise<MtuiResponse> {
  return runMtui([
    'history',
    'record',
    '--command',
    command,
    '--exit-code',
    String(exitCode),
    '--duration-ms',
    String(durationMs),
    '--json',
  ]);
}

export async function getSuggestions(prefix: string): Promise<MtuiSuggestResult> {
  const output = await spawnMtui(['suggest', prefix, '--json']);
  return JSON.parse(output) as MtuiSuggestResult;
}

export async function getRepair(command: string, stderr: string): Promise<MtuiRepairResult> {
  const output = await spawnMtui(['repair', '--command', command, '--stderr', stderr, '--json']);
  return JSON.parse(output) as MtuiRepairResult;
}

export async function writeTextFileWithMtui(filePath: string, data: string): Promise<MtuiResponse> {
  const projectRoot = resolveProjectRootForPath(filePath);
  const absolute = isAbsolute(filePath) ? filePath : resolvePath(projectRoot, filePath);
  const relPath = relative(projectRoot, absolute) || absolute;
  const output = await spawnMtui(['--json', 'new', relPath, '--content-stdin', '--overwrite'], {
    cwd: projectRoot,
    stdin: data,
  });
  return JSON.parse(output) as MtuiResponse;
}

// ---------------------------------------------------------------------------
// IPC channel names
// ---------------------------------------------------------------------------

export const MTUI_CHANNELS = {
  run: 'terminal.mtui-run',
  suggest: 'terminal.mtui-suggest',
  repair: 'terminal.mtui-repair',
  record: 'terminal.mtui-record',
} as const;

export type MtuiRunPayload = { args: string[] };
export type MtuiSuggestPayload = { prefix: string };
export type MtuiRepairPayload = { command: string; stderr: string };
export type MtuiRecordPayload = { command: string; exitCode: number; durationMs: number };

export type MtuiResult<T> = { ok: true; data: T } | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Bridge providers
// ---------------------------------------------------------------------------

export const mtuiChannels = {
  run: bridge.buildProvider<MtuiResult<MtuiResponse>, MtuiRunPayload>(MTUI_CHANNELS.run),
  suggest: bridge.buildProvider<MtuiResult<MtuiSuggestResult>, MtuiSuggestPayload>(MTUI_CHANNELS.suggest),
  repair: bridge.buildProvider<MtuiResult<MtuiRepairResult>, MtuiRepairPayload>(MTUI_CHANNELS.repair),
  record: bridge.buildProvider<MtuiResult<MtuiResponse>, MtuiRecordPayload>(MTUI_CHANNELS.record),
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerMtuiBridge(): void {
  const safe =
    <Req, Res>(label: string, handler: (req: Req) => Promise<Res> | Res) =>
    async (req: Req): Promise<MtuiResult<Res>> => {
      try {
        const data = await handler(req);
        return { ok: true, data };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, error: `${label}: ${message}` };
      }
    };

  mtuiChannels.run.provider(safe('mtui.run', async ({ args }: MtuiRunPayload) => runMtui(args)));
  mtuiChannels.suggest.provider(safe('mtui.suggest', async ({ prefix }: MtuiSuggestPayload) => getSuggestions(prefix)));
  mtuiChannels.repair.provider(
    safe('mtui.repair', async ({ command, stderr }: MtuiRepairPayload) => getRepair(command, stderr))
  );
  mtuiChannels.record.provider(
    safe('mtui.record', async ({ command, exitCode, durationMs }: MtuiRecordPayload) =>
      recordCommand(command, exitCode, durationMs)
    )
  );
}

export function unregisterMtuiBridge(): void {
  // The platform provider API replaces handlers on repeated registration and
  // does not expose per-provider unsubscribe handles.
}

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LSP install manager — the side-effecting half of the on-demand LSP model
 * (the pure "brain" is {@link file://./lspCatalog.ts}).
 *
 * When the user opts in to a language server, this module fetches it INTO THE
 * APP'S OWN DATA DIR (`<userData>/lsp/<id>/`) and never touches the user's
 * global toolchain. Two fetch strategies, mirroring {@link InstallMethod}:
 *
 *  - `npm`     — runs `npm install <pkg>` into the per-server prefix dir, then
 *    resolves the server's executable from `node_modules/.bin`. Used for
 *    `typescript-language-server` and `pyright`. Real download, fully automatic.
 *  - `binary-release` — standalone binaries (rust-analyzer / gopls / clangd)
 *    are NOT auto-downloaded from a hardcoded URL (those URLs drift across
 *    releases and pinning them here is brittle + a supply-chain risk). Instead
 *    we look for an already-installed binary on PATH and adopt it; if absent we
 *    return a `needs-manual` result telling the UI how to provide it (install
 *    via the system package manager / MTUI, or drop the binary in the data dir).
 *
 * Install state is mirrored to `<userData>/lsp/installed.json` so a server is
 * fetched once and reused across sessions.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { app } from 'electron';
import { catalogById, type LspServerInfo } from './lspCatalog';

/** Where an installed server lives + how to launch it. */
export type InstalledServer = {
  /** Catalog server id. */
  id: string;
  /** Absolute path to the server executable. */
  command: string;
  /** Launch arguments (e.g. `--stdio`). */
  args: string[];
  /** How it was obtained, for diagnostics. */
  source: 'npm' | 'path' | 'manual';
};

/** Outcome of an install request. */
export type InstallOutcome =
  | { status: 'installed'; server: InstalledServer }
  | { status: 'already-installed'; server: InstalledServer }
  | { status: 'needs-manual'; id: string; instructions: string }
  | { status: 'error'; id: string; error: string };

/** The on-disk install-state record (one entry per installed server). */
type InstallState = Record<string, InstalledServer>;

/** Default stdio launch args per server id (LSP servers speak `--stdio`). */
const LAUNCH_ARGS: Record<string, string[]> = {
  'typescript-language-server': ['--stdio'],
  pyright: ['--stdio'],
  'rust-analyzer': [],
  gopls: [],
  clangd: [],
};

/** The executable base name to resolve for a `path`-adopted binary. */
const BINARY_NAME: Record<string, string> = {
  'rust-analyzer': 'rust-analyzer',
  gopls: 'gopls',
  clangd: 'clangd',
};

/** Root dir holding every installed server + the state file. */
const lspRoot = (): string => path.join(app.getPath('userData'), 'lsp');

/** Per-server install prefix. */
const serverDir = (id: string): string => path.join(lspRoot(), id);

/** Path to the install-state mirror. */
const stateFile = (): string => path.join(lspRoot(), 'installed.json');

/** Read the install-state mirror (tolerant of absence / corruption). */
const readState = async (): Promise<InstallState> => {
  try {
    const raw = await fsp.readFile(stateFile(), 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as InstallState) : {};
  } catch {
    return {};
  }
};

/** Persist the install-state mirror (atomic tmp + rename). */
const writeState = async (state: InstallState): Promise<void> => {
  await fsp.mkdir(lspRoot(), { recursive: true });
  const tmp = `${stateFile()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(state, null, 2), 'utf-8');
  await fsp.rename(tmp, stateFile());
};

/** Promisified `execFile` returning stdout, rejecting on non-zero exit. */
const run = (command: string, args: string[], cwd: string): Promise<string> =>
  new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      { cwd, windowsHide: true, shell: process.platform === 'win32' },
      (error, stdout, stderr) => {
        if (error) reject(new Error(stderr || error.message));
        else resolve(stdout);
      }
    );
  });

/** Resolve an executable on PATH (cross-platform `which`/`where`). */
const whichOnPath = async (name: string): Promise<string | null> => {
  const finder = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = await run(finder, [name], os.tmpdir());
    const first = out.split(/\r?\n/).find((line) => line.trim().length > 0);
    return first ? first.trim() : null;
  } catch {
    return null;
  }
};

/** Resolve the npm-installed server executable under a prefix's `.bin`. */
const resolveNpmBin = (prefix: string, packageName: string): string | null => {
  // npm bin names usually match the package, sometimes a sub-name; check both.
  const binDir = path.join(prefix, 'node_modules', '.bin');
  const exe = process.platform === 'win32' ? '.cmd' : '';
  const candidates = [packageName, packageName.replace(/^@[^/]+\//, '')];
  for (const candidate of candidates) {
    const full = path.join(binDir, `${candidate}${exe}`);
    if (fs.existsSync(full)) return full;
  }
  return null;
};

/** Human-readable manual-install hint for a binary-release server. */
const manualInstructions = (server: LspServerInfo): string => {
  const map: Record<string, string> = {
    'rust-analyzer': 'Install rust-analyzer (e.g. `rustup component add rust-analyzer`) and ensure it is on PATH.',
    gopls: 'Install gopls (e.g. `go install golang.org/x/tools/gopls@latest`) and ensure it is on PATH.',
    clangd: 'Install clangd (your platform LLVM package) and ensure it is on PATH.',
  };
  return map[server.id] ?? `Install ${server.displayName} and ensure it is on PATH.`;
};

/** Install (or adopt) an npm-distributed language server. */
const installNpm = async (server: LspServerInfo): Promise<InstallOutcome> => {
  if (!server.npmPackage) return { status: 'error', id: server.id, error: 'No npm package configured.' };
  const prefix = serverDir(server.id);
  await fsp.mkdir(prefix, { recursive: true });
  // A bare package.json so `npm install` treats the prefix as a project root.
  const pkgJson = path.join(prefix, 'package.json');
  if (!fs.existsSync(pkgJson)) {
    await fsp.writeFile(pkgJson, JSON.stringify({ name: `aionui-lsp-${server.id}`, private: true }, null, 2), 'utf-8');
  }
  await run('npm', ['install', server.npmPackage, '--no-audit', '--no-fund', '--loglevel=error'], prefix);
  const command = resolveNpmBin(prefix, server.npmPackage);
  if (!command) {
    return { status: 'error', id: server.id, error: `Installed ${server.npmPackage} but no executable was found.` };
  }
  return {
    status: 'installed',
    server: { id: server.id, command, args: LAUNCH_ARGS[server.id] ?? ['--stdio'], source: 'npm' },
  };
};

/** Adopt a binary-release server already present on PATH, else ask for manual install. */
const installBinary = async (server: LspServerInfo): Promise<InstallOutcome> => {
  const binName = BINARY_NAME[server.id] ?? server.id;
  const onPath = await whichOnPath(binName);
  if (onPath) {
    return {
      status: 'installed',
      server: { id: server.id, command: onPath, args: LAUNCH_ARGS[server.id] ?? [], source: 'path' },
    };
  }
  return { status: 'needs-manual', id: server.id, instructions: manualInstructions(server) };
};

/** Get the install record for a server id, or `null` if not installed. */
export const getInstalledServer = async (id: string): Promise<InstalledServer | null> => {
  const state = await readState();
  const record = state[id];
  if (!record) return null;
  // Validate the executable still exists (npm dir wiped, PATH changed, …).
  if (record.source === 'npm' && !fs.existsSync(record.command)) return null;
  return record;
};

/** List the ids of all currently-installed servers. */
export const listInstalledServerIds = async (): Promise<string[]> => Object.keys(await readState());

/**
 * Ensure a catalog server is installed, fetching it if needed. Idempotent: a
 * server already recorded (and still present) returns `already-installed`
 * without re-fetching. Persists the install record on success.
 */
export const ensureServerInstalled = async (id: string): Promise<InstallOutcome> => {
  const server = catalogById(id);
  if (!server) return { status: 'error', id, error: `Unknown server id: ${id}` };

  const existing = await getInstalledServer(id);
  if (existing) return { status: 'already-installed', server: existing };

  try {
    const outcome = server.installMethod === 'npm' ? await installNpm(server) : await installBinary(server);
    if (outcome.status === 'installed') {
      const state = await readState();
      state[id] = outcome.server;
      await writeState(state);
    }
    return outcome;
  } catch (error) {
    return { status: 'error', id, error: error instanceof Error ? error.message : String(error) };
  }
};

/** Forget an installed server (state record only; leaves files on disk). */
export const forgetServer = async (id: string): Promise<void> => {
  const state = await readState();
  if (state[id]) {
    delete state[id];
    await writeState(state);
  }
};

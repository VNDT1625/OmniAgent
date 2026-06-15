/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Locate optional external CLI tools used by the content-extraction service:
 *
 * - **yt-dlp** — the gold-standard YouTube transcript/subtitle downloader. Used
 *   as the primary transcript path because, running on the user's desktop
 *   (residential IP) optionally with their browser cookies, it is far more
 *   reliable than anonymous in-app fetches.
 * - **uvx** (from Astral's `uv`) — runs Python tools without a managed venv.
 *   Used to invoke Microsoft's **markitdown** for high-fidelity
 *   file → Markdown conversion (`uvx markitdown <file>`), matching the project's
 *   existing `uvx`-based MCP convention.
 *
 * Neither tool is bundled or required: if it is not on the machine the service
 * degrades to the next strategy. Resolution probes the system `PATH` plus a few
 * well-known install locations, and caches the outcome (including "absent") so
 * repeated extractions don't re-spawn `where`/`which`.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A resolved tool: its absolute path or command name, or `null` when absent. */
export type ResolvedTool = string | null;

/** Names of the optional tools this module can locate. */
export type ExternalToolName = 'yt-dlp' | 'uvx';

const isWin = process.platform === 'win32';

/** Candidate executable names per tool (platform-aware). */
const TOOL_BINARIES: Record<ExternalToolName, string[]> = {
  'yt-dlp': isWin ? ['yt-dlp.exe', 'yt-dlp'] : ['yt-dlp'],
  uvx: isWin ? ['uvx.exe', 'uvx'] : ['uvx'],
};

/** Well-known install directories to check in addition to `PATH`. */
const extraDirs = (): string[] => {
  const home = homedir();
  if (isWin) {
    return [
      join(home, '.local', 'bin'),
      join(home, 'AppData', 'Local', 'Programs', 'Python', 'Scripts'),
      join(home, 'AppData', 'Roaming', 'Python', 'Scripts'),
      'C:\\ProgramData\\chocolatey\\bin',
    ];
  }
  return [join(home, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin'];
};

/** Run a `--version`-style probe; resolves true when the command is invokable. */
const canRun = (command: string, args: string[]): Promise<boolean> =>
  new Promise((resolve) => {
    try {
      execFile(command, args, { timeout: 5000, windowsHide: true }, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });

/** Look the command up on `PATH` via the platform locator (`where`/`which`). */
const lookupOnPath = (binary: string): Promise<ResolvedTool> =>
  new Promise((resolve) => {
    const locator = isWin ? 'where' : 'which';
    try {
      execFile(locator, [binary], { timeout: 5000, windowsHide: true }, (error, stdout) => {
        if (error) {
          resolve(null);
          return;
        }
        const first = String(stdout)
          .split(/\r?\n/)
          .map((l) => l.trim())
          .find((l) => l.length > 0 && existsSync(l));
        resolve(first ?? null);
      });
    } catch {
      resolve(null);
    }
  });

/** Resolve one tool: PATH first, then well-known dirs. Returns null when absent. */
const resolveTool = async (tool: ExternalToolName): Promise<ResolvedTool> => {
  const binaries = TOOL_BINARIES[tool];
  for (const binary of binaries) {
    const onPath = await lookupOnPath(binary);
    if (onPath) return onPath;
  }
  for (const dir of extraDirs()) {
    for (const binary of binaries) {
      const candidate = join(dir, binary);
      if (existsSync(candidate)) return candidate;
    }
  }
  // Last resort: the bare name might still be runnable (PATH lookup can miss
  // shims). Confirm with a cheap `--version` probe before trusting it.
  const bare = binaries[0].replace(/\.exe$/i, '');
  if (await canRun(bare, ['--version'])) return bare;
  return null;
};

/** Cache resolved tools (including a resolved `null`) for the process lifetime. */
const cache = new Map<ExternalToolName, ResolvedTool>();

/**
 * Resolve an optional external tool, caching the outcome.
 *
 * @param tool The tool to locate.
 * @returns The absolute path / command name, or `null` when not installed.
 */
export const findExternalTool = async (tool: ExternalToolName): Promise<ResolvedTool> => {
  if (cache.has(tool)) return cache.get(tool) ?? null;
  const resolved = await resolveTool(tool);
  cache.set(tool, resolved);
  return resolved;
};

/** Clear the resolution cache (tests / after the user installs a tool). */
export const clearExternalToolCache = (): void => cache.clear();

/**
 * Build an augmented PATH that includes the well-known user install dirs
 * ({@link extraDirs}) so a spawned tool (yt-dlp, uvx) can find its OWN
 * dependencies — most importantly `deno`, which yt-dlp shells out to for
 * YouTube's JS challenge. The Electron Main process does not inherit the user's
 * login-shell PATH, so `~/.deno/bin` / `~/.local/bin` are usually absent; without
 * this, yt-dlp finds no JS runtime and caption extraction degrades.
 *
 * @returns A `PATH`-augmented copy of `process.env` (original env untouched).
 */
export const envWithToolPaths = (): NodeJS.ProcessEnv => {
  const sep = isWin ? ';' : ':';
  const denoBin = join(homedir(), '.deno', 'bin');
  const dirs = [denoBin, ...extraDirs()];
  const current = process.env.PATH ?? process.env.Path ?? '';
  const have = new Set(current.split(sep).map((p) => p.toLowerCase()));
  const additions = dirs.filter((d) => d && !have.has(d.toLowerCase()));
  const nextPath = additions.length > 0 ? [current, ...additions].filter(Boolean).join(sep) : current;
  return { ...process.env, PATH: nextPath };
};

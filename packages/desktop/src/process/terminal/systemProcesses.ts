/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Read-only discovery of shell/terminal-like processes running on the machine
 * (the Settings › Terminal "how many terminals are running everywhere" view).
 *
 * IMPORTANT — these are NOT interactive. The app did not spawn them, so it can
 * neither read their output nor send them input; it only enumerates and counts
 * them via the OS process table (`tasklist` on Windows, `ps` on POSIX). This is
 * deliberately a separate, clearly-labelled capability from the app-managed
 * sessions in {@link ITerminalManager}, which ARE fully interactive.
 *
 * The exec function is injectable so the parser is unit-testable without
 * spawning real OS tools.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { exec } from 'node:child_process';
import type { SystemTerminalProcess } from './terminalTypes';

/** Runs a command and resolves its stdout (rejects on spawn error). */
export type ExecFn = (command: string) => Promise<string>;

const defaultExec: ExecFn = (command) =>
  new Promise<string>((resolve, reject) => {
    exec(command, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      // tasklist/ps return non-zero in benign cases (e.g. no match); prefer stdout.
      if (error && !stdout) reject(error);
      else resolve(stdout);
    });
  });

/**
 * Process image names considered "terminal / shell" surfaces. Lower-cased,
 * matched against the OS process name. Kept broad but conservative to avoid
 * false positives.
 */
const SHELL_NAMES = new Set([
  // Windows shells + terminal hosts
  'cmd.exe',
  'powershell.exe',
  'pwsh.exe',
  'wt.exe',
  'conhost.exe',
  'windowsterminal.exe',
  'bash.exe',
  'git-bash.exe',
  'mintty.exe',
  // POSIX shells + terminal emulators
  'bash',
  'zsh',
  'sh',
  'fish',
  'tcsh',
  'ksh',
  'dash',
  'gnome-terminal',
  'konsole',
  'xterm',
  'alacritty',
  'kitty',
  'iterm2',
  'terminal',
]);

const isShellName = (name: string): boolean => SHELL_NAMES.has(name.toLowerCase());

/** Parse Windows `tasklist /FO CSV /NH` output into shell processes. */
export const parseTasklistCsv = (stdout: string): SystemTerminalProcess[] => {
  const result: SystemTerminalProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    // CSV columns: "Image Name","PID","Session Name","Session#","Mem Usage"
    const cells = line.match(/"([^"]*)"/g);
    if (!cells || cells.length < 2) continue;
    const name = cells[0].replace(/"/g, '');
    const pid = Number.parseInt(cells[1].replace(/"/g, ''), 10);
    if (Number.isFinite(pid) && isShellName(name)) result.push({ pid, name });
  }
  return result;
};

/** Parse POSIX `ps -eo pid=,comm=` output into shell processes. */
export const parsePsOutput = (stdout: string): SystemTerminalProcess[] => {
  const result: SystemTerminalProcess[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number.parseInt(match[1], 10);
    const full = match[2].trim();
    const name = full.split(/[/\\]/).pop() ?? full;
    if (Number.isFinite(pid) && isShellName(name)) result.push({ pid, name });
  }
  return result;
};

/**
 * List shell/terminal-like processes on the machine (read-only). On any failure
 * returns an empty list rather than throwing — the UI degrades to "0 / unknown".
 */
export const listSystemTerminals = async (execFn: ExecFn = defaultExec): Promise<SystemTerminalProcess[]> => {
  try {
    if (process.platform === 'win32') {
      const out = await execFn('tasklist /FO CSV /NH');
      return parseTasklistCsv(out);
    }
    const out = await execFn('ps -eo pid=,comm=');
    return parsePsOutput(out);
  } catch (error) {
    console.warn('[systemProcesses] Failed to list system terminals:', error);
    return [];
  }
};

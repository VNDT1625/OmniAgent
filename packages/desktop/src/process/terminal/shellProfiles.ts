/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shell profile discovery — the list of shells the user can pick when opening a
 * new terminal, mirroring VS Code's "Select Default Profile" / profile dropdown.
 *
 * On Windows we probe for the common shells (PowerShell 5, PowerShell 7 / pwsh,
 * Command Prompt, Git Bash, WSL); on POSIX we read `/etc/shells` plus the usual
 * suspects (bash, zsh, fish, sh). Probing is filesystem-existence based and
 * degrade-safe: a profile whose executable is missing is simply omitted, and any
 * error yields just the platform's guaranteed default.
 *
 * The result is renderer-safe data ({@link ShellProfile}) surfaced through the
 * terminal bridge so the UI can render a picker without touching Node APIs.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveDefaultShell } from './ptyBackend';

/** A shell the user can launch, with the argv needed to start it interactively. */
export type ShellProfile = {
  /** Stable id (e.g. `pwsh`, `cmd`, `git-bash`, `bash`). */
  id: string;
  /** Human label shown in the picker (e.g. "PowerShell 7"). */
  label: string;
  /** Absolute path to the shell executable. */
  path: string;
  /** Extra argv to start the shell (beyond what the pty backend adds). */
  args?: string[];
  /** Icon-park icon name hint for the UI (renderer maps it to a component). */
  icon?: string;
  /** True for the platform's default shell (pre-selected in the picker). */
  isDefault?: boolean;
};

/** Does a file exist and is readable? (sync, best-effort). */
const exists = (p: string): boolean => {
  try {
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** First existing path from a candidate list, or null. */
const firstExisting = (candidates: string[]): string | null => candidates.find(exists) ?? null;

/** Discover Windows shell profiles by probing well-known install locations. */
const discoverWindowsProfiles = (): ShellProfile[] => {
  const profiles: ShellProfile[] = [];
  const sysRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const pf = process.env.ProgramFiles ?? 'C:\\Program Files';
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA ?? '';

  // PowerShell 7+ (pwsh)
  const pwsh = firstExisting([
    path.join(pf, 'PowerShell', '7', 'pwsh.exe'),
    path.join(pf, 'PowerShell', '7-preview', 'pwsh.exe'),
    path.join(localAppData, 'Microsoft', 'WindowsApps', 'pwsh.exe'),
  ]);
  if (pwsh) profiles.push({ id: 'pwsh', label: 'PowerShell 7', path: pwsh, icon: 'PowerShell', args: ['-NoLogo'] });

  // Windows PowerShell 5.1
  const winPs = firstExisting([path.join(sysRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')]);
  if (winPs)
    profiles.push({
      id: 'powershell',
      label: 'Windows PowerShell',
      path: winPs,
      icon: 'PowerShell',
      args: ['-NoLogo'],
    });

  // Command Prompt
  const cmd = firstExisting([path.join(sysRoot, 'System32', 'cmd.exe'), process.env.COMSPEC ?? '']);
  if (cmd) profiles.push({ id: 'cmd', label: 'Command Prompt', path: cmd, icon: 'Terminal' });

  // Git Bash
  const gitBash = firstExisting([
    path.join(pf, 'Git', 'bin', 'bash.exe'),
    path.join(pf86, 'Git', 'bin', 'bash.exe'),
    path.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'),
  ]);
  if (gitBash)
    profiles.push({ id: 'git-bash', label: 'Git Bash', path: gitBash, icon: 'Git', args: ['--login', '-i'] });

  // WSL (default distro)
  const wsl = firstExisting([path.join(sysRoot, 'System32', 'wsl.exe')]);
  if (wsl) profiles.push({ id: 'wsl', label: 'WSL', path: wsl, icon: 'Terminal' });

  // Mark cmd (or first) as default.
  const defaultPath = (process.env.COMSPEC ?? '').toLowerCase();
  const def = profiles.find((p) => p.path.toLowerCase() === defaultPath) ?? profiles[0];
  if (def) def.isDefault = true;
  return profiles;
};

/** Read `/etc/shells` for installed POSIX shells (best-effort). */
const readEtcShells = (): string[] => {
  try {
    return fs
      .readFileSync('/etc/shells', 'utf-8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith('#'));
  } catch {
    return [];
  }
};

/** Discover POSIX shell profiles from `/etc/shells` + common locations. */
const discoverPosixProfiles = (): ShellProfile[] => {
  const known: Array<{ id: string; label: string; bases: string[]; icon?: string }> = [
    { id: 'bash', label: 'bash', bases: ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash'] },
    { id: 'zsh', label: 'zsh', bases: ['/bin/zsh', '/usr/bin/zsh', '/usr/local/bin/zsh'] },
    { id: 'fish', label: 'fish', bases: ['/usr/bin/fish', '/usr/local/bin/fish', '/opt/homebrew/bin/fish'] },
    { id: 'sh', label: 'sh', bases: ['/bin/sh', '/usr/bin/sh'] },
  ];
  const etc = readEtcShells();
  const profiles: ShellProfile[] = [];
  for (const k of known) {
    const found = firstExisting([...k.bases, ...etc.filter((s) => s.endsWith(`/${k.id}`))]);
    if (found) profiles.push({ id: k.id, label: k.label, path: found, icon: 'Terminal', args: ['-l'] });
  }
  const defaultShell = resolveDefaultShell();
  const def = profiles.find((p) => p.path === defaultShell) ?? profiles[0];
  if (def) def.isDefault = true;
  return profiles;
};

/**
 * Discover the shell profiles available on this machine. Always returns at least
 * one entry (the platform default) so the picker is never empty.
 */
export const discoverShellProfiles = (): ShellProfile[] => {
  try {
    const profiles = process.platform === 'win32' ? discoverWindowsProfiles() : discoverPosixProfiles();
    if (profiles.length > 0) return profiles;
  } catch (error) {
    console.warn('[shellProfiles] discovery failed; using default shell only:', error);
  }
  // Guaranteed fallback: the resolved default shell.
  const def = resolveDefaultShell();
  return [{ id: 'default', label: path.basename(def).replace(/\.exe$/i, ''), path: def, isDefault: true }];
};

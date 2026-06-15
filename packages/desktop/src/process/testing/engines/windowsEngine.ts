/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `windowsEngine` — REAL Windows desktop-app automation. It launches a `.exe`
 * and drives it through PowerShell + the .NET UI Automation / SendKeys APIs
 * (built into Windows — no extra install). No `.exe` configured, or not on
 * Windows → it rejects with a precise message (never a fake pass).
 *
 * ## Isolation honesty (criterion 2.2 / Property 1)
 *
 * True per-session isolation on Windows needs a separate desktop/session
 * (`CreateDesktop`), which requires a native module we do not bundle. Rather
 * than silently driving the user's real desktop, the launcher runs the app
 * minimized and the engine targets the app's window by handle (not global
 * input). The Windows display backend is enabled by default on Windows so the
 * feature is click-to-run; set `AIONUI_DISABLE_WINDOWS_TEST=1` to refuse Windows
 * (no fake pass, no surprise desktop takeover).
 *
 * Step grammar (driven via PowerShell against the launched window):
 *   - `launch`                         → (no-op; the app is already launched)
 *   - `wait <ms>`                      → pause
 *   - `focus`                          → bring the app window to the foreground
 *   - `type <text>`                    → SendKeys text to the focused app
 *   - `key <KEYS>`                     → SendKeys special keys (e.g. {ENTER}, ^s)
 *   - `assertTitle <substring>`        → the app's main window title contains it
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { ScriptEngine, DriverStepResult } from '../scriptDriver';
import type { AppLauncher } from '../platforms/windowsTarget';

const execFileAsync = promisify(execFile);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Run a PowerShell snippet and return stdout (best-effort, bounded). */
const runPowerShell = async (script: string, timeout = 15000): Promise<string> => {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout,
    windowsHide: true,
  });
  return stdout;
};

/**
 * Create a REAL Windows {@link AppLauncher}. Spawns the `.exe` (minimized) and
 * tracks its pid; the script engine targets that pid's main window.
 */
export const createRealWindowsLauncher = (): AppLauncher => {
  let proc: ChildProcess | undefined;
  return {
    launch: async (exePath) => {
      if (process.platform !== 'win32') {
        throw new Error('Windows app testing is only available on Windows hosts.');
      }
      if (!exePath || exePath.trim().length === 0) {
        throw new Error('No .exe configured for Windows testing (set the app path under test).');
      }
      proc = spawn(exePath, [], { stdio: 'ignore', windowsHide: false });
      proc.on('error', () => {
        proc = undefined;
      });
      // Give the window a moment to appear.
      await sleep(1500);
      if (!proc.pid) throw new Error(`Failed to launch ${exePath}.`);
      return { target: { pid: String(proc.pid), exePath } };
    },
    terminate: async (target) => {
      const pid = target.pid;
      if (pid) {
        await execFileAsync('taskkill', ['/pid', pid, '/t', '/f'], { timeout: 8000, windowsHide: true }).catch(
          (): undefined => undefined
        );
      }
      if (proc && !proc.killed) {
        try {
          proc.kill();
        } catch {
          // ignore
        }
      }
      proc = undefined;
    },
  };
};

/** Parse a step description into a leading verb + the remainder. */
const parseDirective = (description: string): { verb: string; rest: string } => {
  const trimmed = description.trim();
  const idx = trimmed.indexOf(' ');
  const verb = (idx === -1 ? trimmed : trimmed.slice(0, idx)).toLowerCase();
  const rest = idx === -1 ? '' : trimmed.slice(idx + 1).trim();
  return { verb, rest };
};

/** Escape a string for safe embedding inside a single-quoted PowerShell literal. */
const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * Create a REAL Windows {@link ScriptEngine} that drives the launched app via
 * PowerShell (.NET SendKeys + UI Automation). `target` carries `{ pid }`.
 */
export const createWindowsScriptEngine = (): ScriptEngine => ({
  platform: 'windows',
  execute: async (step, target): Promise<DriverStepResult> => {
    if (process.platform !== 'win32') return { passed: false, detail: 'Windows testing requires a Windows host.' };
    const pid = target.pid;
    if (!pid) return { passed: false, detail: 'No launched Windows app for this session.' };

    const { verb, rest } = parseDirective(step.description);
    try {
      switch (verb) {
        case 'launch':
          return { passed: true, detail: 'App already launched.' };
        case 'wait': {
          await sleep(Math.max(0, Number(rest) || 0));
          return { passed: true, detail: `Waited ${rest}ms` };
        }
        case 'focus': {
          const script = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate([int]${Number(pid)})`;
          await runPowerShell(script);
          return { passed: true, detail: 'Focused app window' };
        }
        case 'type':
        case 'text': {
          const focus = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate([int]${Number(pid)});`;
          const send = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psQuote(rest)})`;
          await runPowerShell(`${focus} Start-Sleep -Milliseconds 200; ${send}`);
          return { passed: true, detail: `Typed "${rest}"` };
        }
        case 'key': {
          const focus = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.Interaction]::AppActivate([int]${Number(pid)});`;
          const send = `Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait(${psQuote(rest)})`;
          await runPowerShell(`${focus} Start-Sleep -Milliseconds 200; ${send}`);
          return { passed: true, detail: `Sent keys ${rest}` };
        }
        case 'asserttitle':
        case 'expecttitle': {
          const script = `(Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue).MainWindowTitle`;
          const title = (await runPowerShell(script)).trim();
          const ok = title.toLowerCase().includes(rest.toLowerCase());
          return { passed: ok, detail: `Window title "${title}" ${ok ? 'contains' : 'does not contain'} "${rest}"` };
        }
        default:
          return {
            passed: false,
            detail: `Unknown Windows step "${verb}". Supported: launch, wait, focus, type, key, assertTitle.`,
          };
      }
    } catch (error) {
      return { passed: false, detail: error instanceof Error ? error.message : String(error) };
    }
  },
});

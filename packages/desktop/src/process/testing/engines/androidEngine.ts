/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `androidEngine` — REAL Android automation via the Android SDK (`emulator` +
 * `adb`). It boots an installed AVD, waits for `sys.boot_completed`, and drives
 * it with adb shell commands. No SDK on the host → it rejects with a precise
 * "install the Android SDK" message (never a fake pass).
 *
 * The emulator is its OWN isolated window/process (it does not take over the
 * user's mouse/keyboard), satisfying the isolation invariant for Android.
 *
 * Step grammar (mirrors the web engine's verb style), driven over adb:
 *   - `launch <package>` / `open <package>`  → am start the app's launcher
 *   - `tap <x> <y>`                          → input tap
 *   - `text <words>`                         → input text
 *   - `key <KEYCODE>`                        → input keyevent (e.g. KEYCODE_HOME, ENTER, BACK)
 *   - `wait <ms>`                            → pause
 *   - `assertText <substring>`               → uiautomator dump contains substring
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { ScriptEngine, DriverStepResult } from '../scriptDriver';
import type { EmulatorProvisioner } from '../platforms/androidTarget';
import { listAvds, resolveAdb, resolveEmulator } from './toolResolver';

const execFileAsync = promisify(execFile);

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/** Run `adb -s <serial> <args...>` and return stdout. */
const adb = async (adbPath: string, serial: string, args: string[], timeout = 20000): Promise<string> => {
  const { stdout } = await execFileAsync(adbPath, ['-s', serial, ...args], { timeout });
  return stdout;
};

/** Poll until `getprop sys.boot_completed` is `1`, or throw on timeout. */
const waitForBoot = async (adbPath: string, serial: string, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const out = await adb(adbPath, serial, ['shell', 'getprop', 'sys.boot_completed'], 8000);
      if (out.trim() === '1') return;
    } catch {
      // emulator still coming up
    }
    await sleep(2000);
  }
  throw new Error('Android emulator did not finish booting within the timeout.');
};

/** Resolve the first connected emulator serial (e.g. `emulator-5554`). */
const firstEmulatorSerial = async (adbPath: string): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync(adbPath, ['devices'], { timeout: 8000 });
    const line = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /^emulator-\d+\s+device$/.test(l));
    return line ? line.split(/\s+/)[0] : null;
  } catch {
    return null;
  }
};

/**
 * Create a REAL {@link EmulatorProvisioner}. Boots an installed AVD with the SDK
 * `emulator` binary and waits for boot via adb. Throws a clear message when the
 * SDK / an AVD is missing.
 */
export const createRealEmulatorProvisioner = (deps: { bootTimeoutMs?: number } = {}): EmulatorProvisioner => {
  const bootTimeoutMs = deps.bootTimeoutMs ?? 120000;
  let proc: ChildProcess | undefined;

  return {
    boot: async (avdName) => {
      const emu = resolveEmulator();
      const adbRes = resolveAdb();
      if (!emu.ok) throw new Error(emu.reason);
      if (!adbRes.ok) throw new Error(adbRes.reason);

      // Pick the requested AVD, or the first installed one if the placeholder is used.
      const avds = await listAvds(emu.path);
      if (avds.length === 0) {
        throw new Error('No Android AVD is installed. Create one in Android Studio (Device Manager) first.');
      }
      const targetAvd = avds.includes(avdName) ? avdName : avds[0];

      // Launch the emulator headless-ish (its own window/process — isolated from
      // the user's input). `-no-snapshot` for a clean, deterministic boot.
      proc = spawn(emu.path, ['-avd', targetAvd, '-no-snapshot', '-no-boot-anim'], {
        stdio: 'ignore',
        detached: false,
      });
      proc.on('error', () => {
        proc = undefined;
      });

      // Wait for a serial to appear, then for full boot.
      const deadline = Date.now() + bootTimeoutMs;
      let serial: string | null = null;
      while (!serial && Date.now() < deadline) {
        serial = await firstEmulatorSerial(adbRes.path);
        if (!serial) await sleep(2000);
      }
      if (!serial) throw new Error('Emulator process started but no adb device appeared.');
      await waitForBoot(adbRes.path, serial, deadline - Date.now());
      return { target: { serial, adbPath: adbRes.path } };
    },
    shutdown: async (target) => {
      const adbPath = target.adbPath;
      const serial = target.serial;
      if (adbPath && serial) {
        await execFileAsync(adbPath, ['-s', serial, 'emu', 'kill'], { timeout: 10000 }).catch(
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
    installApk: async (target, apkPath) => {
      const adbPath = target.adbPath;
      const serial = target.serial;
      if (!adbPath || !serial) throw new Error('Cannot install APK: no booted emulator.');
      // `-r` reinstalls keeping data; `-g` grants runtime permissions up front.
      await execFileAsync(adbPath, ['-s', serial, 'install', '-r', '-g', apkPath], { timeout: 120000 });
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

/**
 * Create a REAL Android {@link ScriptEngine} that drives the booted emulator via
 * adb. The `target` carries `{ serial, adbPath }` from the provisioner.
 */
export const createAndroidScriptEngine = (): ScriptEngine => ({
  platform: 'android',
  execute: async (step, target): Promise<DriverStepResult> => {
    const adbPath = target.adbPath;
    const serial = target.serial;
    if (!adbPath || !serial) return { passed: false, detail: 'No booted Android emulator for this session.' };

    const { verb, rest } = parseDirective(step.description);
    try {
      switch (verb) {
        case 'launch':
        case 'open': {
          // Start the app's monkey launcher intent. Use the step's package, or
          // fall back to the package threaded in from the scenario's app config.
          const pkg = rest || target.appPackage || '';
          if (!pkg) {
            return {
              passed: false,
              detail: 'launch needs a package: launch <com.example.app> (or set the app package).',
            };
          }
          await adb(adbPath, serial, ['shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1']);
          return { passed: true, detail: `Launched ${pkg}` };
        }
        case 'tap': {
          const [x, y] = rest.split(/\s+/);
          if (!x || !y) return { passed: false, detail: 'tap needs: tap <x> <y>' };
          await adb(adbPath, serial, ['shell', 'input', 'tap', x, y]);
          return { passed: true, detail: `Tapped ${x},${y}` };
        }
        case 'text':
        case 'type': {
          await adb(adbPath, serial, ['shell', 'input', 'text', rest.replace(/\s/g, '%s')]);
          return { passed: true, detail: `Typed "${rest}"` };
        }
        case 'key': {
          await adb(adbPath, serial, ['shell', 'input', 'keyevent', rest]);
          return { passed: true, detail: `Key ${rest}` };
        }
        case 'wait': {
          await sleep(Math.max(0, Number(rest) || 0));
          return { passed: true, detail: `Waited ${rest}ms` };
        }
        case 'asserttext':
        case 'expecttext': {
          // Dump the current UI hierarchy and search for the substring.
          await adb(adbPath, serial, ['shell', 'uiautomator', 'dump', '/sdcard/ui.xml']);
          const xml = await adb(adbPath, serial, ['shell', 'cat', '/sdcard/ui.xml']);
          const ok = xml.toLowerCase().includes(rest.toLowerCase());
          return { passed: ok, detail: ok ? `Found "${rest}" on screen` : `"${rest}" not found on screen` };
        }
        default:
          return {
            passed: false,
            detail: `Unknown Android step "${verb}". Supported: launch, tap, text, key, wait, assertText.`,
          };
      }
    } catch (error) {
      return { passed: false, detail: error instanceof Error ? error.message : String(error) };
    }
  },
});

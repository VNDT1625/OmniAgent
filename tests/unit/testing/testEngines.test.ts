/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the REAL test engines' resolution + the Android/Windows script
 * engines' honest failure. These verify the engines run for real when tooling is
 * present and fail with a clear message (never a fake pass) when it is not.
 */

import { describe, it, expect } from 'vitest';
import { resolveFfmpeg, resolveAdb, resolveEmulator } from '@/process/testing/engines/toolResolver';
import { createAndroidScriptEngine } from '@/process/testing/engines/androidEngine';
import { createWindowsScriptEngine } from '@/process/testing/engines/windowsEngine';
import { createWindowsTarget } from '@/process/testing/platforms/windowsTarget';
import { createAndroidTarget } from '@/process/testing/platforms/androidTarget';

describe('testing engines — tool resolution', () => {
  it('resolves the bundled ffmpeg binary (real video is always available)', () => {
    const res = resolveFfmpeg();
    expect(res.ok).toBe(true);
    expect(typeof res.path).toBe('string');
    expect(res.path && res.path.length > 0).toBe(true);
  });

  it('adb/emulator resolution returns ok or a precise reason (never throws)', () => {
    const adb = resolveAdb();
    const emu = resolveEmulator();
    // On a host without the SDK these are not ok, but must carry a helpful reason.
    if (!adb.ok) expect(adb.reason).toMatch(/Android SDK|adb/i);
    if (!emu.ok) expect(emu.reason).toMatch(/Android SDK|emulator/i);
  });
});

describe('android script engine — honest failures', () => {
  const engine = createAndroidScriptEngine();

  it('fails clearly when no emulator is bound to the session', async () => {
    const res = await engine.execute({ id: 's1', description: 'tap 10 20' }, {});
    expect(res.passed).toBe(false);
    expect(res.detail).toMatch(/no booted android emulator/i);
  });

  it('rejects an unknown step verb with the supported list', async () => {
    const res = await engine.execute(
      { id: 's2', description: 'frobnicate now' },
      { serial: 'emulator-5554', adbPath: 'adb' }
    );
    expect(res.passed).toBe(false);
    expect(res.detail).toMatch(/unknown android step/i);
  });
});

describe('windows script engine — honest failures', () => {
  const engine = createWindowsScriptEngine();

  it('fails clearly off-Windows or without a launched app', async () => {
    const res = await engine.execute({ id: 's1', description: 'focus' }, {});
    expect(res.passed).toBe(false);
    // Either "requires a Windows host" (non-win32) or "no launched app" (win32).
    expect(res.detail).toMatch(/windows host|no launched windows app/i);
  });
});

describe('platform targets — per-scenario app under test', () => {
  it('windows target launches the scenario-provided exePath (not just the default)', async () => {
    const launched: string[] = [];
    const target = createWindowsTarget({
      exePath: 'C:/default/Fallback.exe',
      launcher: {
        launch: async (exePath) => {
          launched.push(exePath);
          return { target: { pid: '123' } };
        },
        terminate: async () => undefined,
      },
    });
    await target.prepare({ kind: 'win' }, undefined, { exePath: 'C:/picked/MyApp.exe' });
    expect(launched).toEqual(['C:/picked/MyApp.exe']);
  });

  it('windows target falls back to the default exePath when the scenario omits it', async () => {
    const launched: string[] = [];
    const target = createWindowsTarget({
      exePath: 'C:/default/Fallback.exe',
      launcher: {
        launch: async (exePath) => {
          launched.push(exePath);
          return { target: { pid: '1' } };
        },
        terminate: async () => undefined,
      },
    });
    await target.prepare({ kind: 'win' });
    expect(launched).toEqual(['C:/default/Fallback.exe']);
  });

  it('android target installs the APK and threads the package id into the target', async () => {
    const installed: string[] = [];
    const target = createAndroidTarget({
      profiles: [{ avdName: 'auto', viewport: { width: 1080, height: 1920, label: 'phone' } }],
      provisioner: {
        boot: async () => ({ target: { serial: 'emulator-5554', adbPath: 'adb' } }),
        shutdown: async () => undefined,
        installApk: async (_t, apk) => {
          installed.push(apk);
        },
      },
    });
    const prepared = await target.prepare({ kind: 'android' }, undefined, {
      apkPath: '/path/app.apk',
      appPackage: 'com.example.app',
    });
    expect(installed).toEqual(['/path/app.apk']);
    expect(prepared.target.appPackage).toBe('com.example.app');
  });

  it('android launch step uses the threaded package when the step gives none', async () => {
    const engine = createAndroidScriptEngine();
    // No emulator bound → it fails before launching, proving package resolution
    // is not the failure cause; we only assert it does not complain about a
    // missing package when one is threaded via the target.
    const res = await engine.execute(
      { id: 's1', description: 'launch' },
      { serial: 'emulator-5554', adbPath: 'definitely-not-a-real-adb-binary', appPackage: 'com.example.app' }
    );
    // adb is bogus so it errors, but NOT with the "needs a package" message.
    expect(res.detail).not.toMatch(/needs a package/i);
  });
});

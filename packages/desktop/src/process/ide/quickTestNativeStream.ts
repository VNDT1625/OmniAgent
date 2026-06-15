/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `quickTestNativeStream` — the REAL {@link NativeStreamOpener} for the native
 * Quick Test tracer. It bridges the OS to the tracer's platform-agnostic
 * {@link NativeLogStream} contract:
 *
 *   - **android** — `adb -s <serial> logcat -v brief`. The serial comes from the
 *     argument, or the first connected emulator/device when empty. The buffer is
 *     cleared (`logcat -c`) first so only post-start lines are recorded. Needs
 *     the Android SDK (`adb`) on the host — reuses `toolResolver.resolveAdb`,
 *     the same honest resolution the testing engines use.
 *   - **windows** — launches the `.exe` at the given path and streams its
 *     stdout/stderr. (Attaching to an ALREADY-running pid's stdio is not
 *     possible without a debugger, so for the live "watch my app" flow we launch
 *     the exe ourselves, mirroring `windowsEngine`'s launcher.)
 *
 * Returns null (not a throw) when the tooling/target is unavailable, so the
 * tracer reports "native trace not available" rather than crashing.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import type { NativeLogStream, NativeStreamOpener } from './quickTestNativeTracer';
import type { TracePlatform } from './quickTestTracer';
import { resolveAdb } from '../testing/engines/toolResolver';

const execFileAsync = promisify(execFile);

/** Resolve the first connected android serial (`emulator-5554` or a device id). */
const firstAndroidSerial = async (adbPath: string): Promise<string | null> => {
  try {
    const { stdout } = await execFileAsync(adbPath, ['devices'], { timeout: 8000 });
    const line = stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => /^\S+\s+device$/.test(l) && !l.startsWith('List '));
    return line ? line.split(/\s+/)[0] : null;
  } catch {
    return null;
  }
};

/** Adapt a long-lived {@link ChildProcess} into a {@link NativeLogStream}. */
const streamFromProcess = (proc: ChildProcess): NativeLogStream => {
  let buffer = '';
  const lineListeners: Array<(line: string) => void> = [];
  const closeListeners: Array<(info: { code: number | null }) => void> = [];

  const emitLine = (line: string): void => {
    for (const listener of lineListeners) listener(line);
  };
  const onData = (chunk: Buffer | string): void => {
    buffer += chunk.toString();
    let idx = buffer.indexOf('\n');
    while (idx !== -1) {
      emitLine(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 1);
      idx = buffer.indexOf('\n');
    }
  };

  proc.stdout?.on('data', onData);
  proc.stderr?.on('data', onData);
  proc.on('close', (code) => {
    if (buffer.length > 0) {
      emitLine(buffer);
      buffer = '';
    }
    for (const listener of closeListeners) listener({ code });
  });

  return {
    onLine: (listener) => lineListeners.push(listener),
    onClose: (listener) => closeListeners.push(listener),
    close: () => {
      try {
        if (!proc.killed) proc.kill();
      } catch {
        /* already gone */
      }
    },
  };
};

/** Open an `adb logcat` stream for an android device/emulator. */
const openAndroidStream = async (target: string): Promise<NativeLogStream | null> => {
  const adb = resolveAdb();
  if (!adb.ok || !adb.path) return null;
  const serial = target.trim() || (await firstAndroidSerial(adb.path));
  if (!serial) return null;

  // Clear the existing buffer so only post-start lines are recorded.
  await execFileAsync(adb.path, ['-s', serial, 'logcat', '-c'], { timeout: 8000 }).catch((): undefined => undefined);

  const proc = spawn(adb.path, ['-s', serial, 'logcat', '-v', 'brief'], { stdio: ['ignore', 'pipe', 'pipe'] });
  if (!proc.pid) return null;
  return streamFromProcess(proc);
};

/** Launch a Windows `.exe` and stream its stdout/stderr. */
const openWindowsStream = async (target: string): Promise<NativeLogStream | null> => {
  if (process.platform !== 'win32') return null;
  const exePath = target.trim();
  if (!exePath) return null;
  const proc = spawn(exePath, [], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  // `spawn` reports launch failures asynchronously via the 'error' event; pid is
  // set synchronously when the OS accepted the spawn.
  if (!proc.pid) return null;
  return streamFromProcess(proc);
};

/**
 * The real {@link NativeStreamOpener} used by the wiring layer. Dispatches to
 * the per-platform opener; returns null for unsupported platforms.
 */
export const openNativeLogStream: NativeStreamOpener = async (platform: TracePlatform, target: string) => {
  if (platform === 'android') return openAndroidStream(target);
  if (platform === 'windows') return openWindowsStream(target);
  return null;
};

export default openNativeLogStream;

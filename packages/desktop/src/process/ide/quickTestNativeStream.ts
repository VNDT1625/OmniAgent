/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
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
    processId: proc.pid,
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

/** Attach a Windows UI Automation poller to a process-backed native stream. */
const attachWindowsAccessibilityProbe = (stream: NativeLogStream): void => {
  if (process.platform !== 'win32' || !stream.processId) return;
  let listener: ((event: Extract<import('./quickTestTracer').TraceEvent, { kind: 'click' | 'input' }>) => void) | null =
    null;
  let previous = '';
  let polling = false;
  const powershell = `
    Add-Type -AssemblyName UIAutomationClient;
    Add-Type -AssemblyName UIAutomationTypes;
    $e = [System.Windows.Automation.AutomationElement]::FocusedElement;
    if ($null -eq $e) { exit 0 }
    $c = $e.Current;
    if ($c.ProcessId -ne ${stream.processId}) { exit 0 }
    $value = '';
    try {
      $p = $e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern);
      $value = [string]$p.Current.Value;
    } catch {}
    [Console]::WriteLine((@{ processId=$c.ProcessId; name=$c.Name; automationId=$c.AutomationId; controlType=$c.ControlType.ProgrammaticName; value=$value } | ConvertTo-Json -Compress));
  `;
  const poll = async (): Promise<void> => {
    if (polling || !listener) return;
    polling = true;
    try {
      const { stdout } = await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', powershell],
        { timeout: 3000, windowsHide: true }
      );
      const line = stdout.trim().split(/\r?\n/).pop() ?? '';
      if (!line) return;
      const item = JSON.parse(line) as { name?: string; automationId?: string; controlType?: string; value?: string };
      const selector = item.automationId || item.name || item.controlType || 'windows.focused';
      const signature = `${selector}|${item.controlType ?? ''}|${item.value ?? ''}`;
      if (signature === previous) return;
      previous = signature;
      if (item.value && /edit|text|combo/i.test(item.controlType ?? '')) {
        listener({ kind: 'input', selector: `uia:${selector}`, value: item.value, at: Date.now() });
      } else {
        listener({ kind: 'click', selector: `uia:${selector}`, text: item.name ?? '', at: Date.now() });
      }
    } catch {
      // UI Automation is optional; runtime log tracing continues when it is unavailable.
    } finally {
      polling = false;
    }
  };
  stream.onInteraction = (next) => {
    listener = next;
  };
  const timer = setInterval(() => void poll(), 700);
  const close = stream.close;
  stream.close = () => {
    clearInterval(timer);
    close();
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
  const stream = streamFromProcess(proc);
  let interactionListener:
    | ((event: Extract<import('./quickTestTracer').TraceEvent, { kind: 'click' | 'input' }>) => void)
    | null = null;
  let previousFocused = '';
  let previousInput = '';
  let polling = false;
  const readUiSnapshot = async (): Promise<{
    focused: string;
    input: { selector: string; value: string } | null;
  } | null> => {
    try {
      const { stdout } = await execFileAsync(
        adb.path!,
        ['-s', serial!, 'exec-out', 'uiautomator', 'dump', '/dev/tty'],
        { timeout: 3500, maxBuffer: 2 * 1024 * 1024 }
      );
      const nodes = stdout.match(/<node\b[^>]*>/g) ?? [];
      let focused = '';
      let input: { selector: string; value: string } | null = null;
      for (const node of nodes) {
        const attr = (name: string): string => node.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? '';
        const selector = attr('resource-id') || attr('class') || attr('content-desc') || 'android.node';
        const text = attr('text');
        const focusedOrSelected = attr('focused') === 'true' || attr('selected') === 'true';
        if (focusedOrSelected) focused = `${selector}|${text}|${attr('bounds')}`;
        if (/edittext|textfield/i.test(attr('class')) && attr('focused') === 'true') input = { selector, value: text };
      }
      return { focused, input };
    } catch {
      return null;
    }
  };
  const poll = async (): Promise<void> => {
    if (polling) return;
    polling = true;
    const snapshot = await readUiSnapshot();
    polling = false;
    if (!snapshot || !interactionListener) return;
    if (snapshot.input && snapshot.input.value !== previousInput) {
      previousInput = snapshot.input.value;
      interactionListener({
        kind: 'input',
        selector: snapshot.input.selector,
        value: snapshot.input.value,
        at: Date.now(),
      });
      return;
    }
    if (snapshot.focused && snapshot.focused !== previousFocused) {
      previousFocused = snapshot.focused;
      const [selector, text] = snapshot.focused.split('|');
      interactionListener({ kind: 'click', selector, text, at: Date.now() });
    }
  };
  stream.onInteraction = (listener) => {
    interactionListener = listener;
  };
  const timer = setInterval(() => void poll(), 700);
  const close = stream.close;
  stream.close = () => {
    clearInterval(timer);
    close();
  };
  return stream;
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
  const stream = streamFromProcess(proc);
  attachWindowsAccessibilityProbe(stream);
  return stream;
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

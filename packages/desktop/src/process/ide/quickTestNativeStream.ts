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
import type {
  NativeAutomationAction,
  NativeLogStream,
  NativeStreamOpener,
  NativeTargetIdentity,
} from './quickTestNativeTracer';
import type { TracePlatform } from './quickTestTracer';
import { resolveAdb } from '../testing/engines/toolResolver';

const execFileAsync = promisify(execFile);

export type WindowsNativeTarget =
  | { kind: 'process'; processId: number }
  | { kind: 'executable'; executablePath: string };

/** Parse `pid:123`, a raw numeric PID, or an executable path. */
export const parseWindowsNativeTarget = (target: string): WindowsNativeTarget | null => {
  const value = target.trim();
  if (!value) return null;
  const pidMatch = value.match(/^(?:pid:)?(\d+)$/i);
  if (pidMatch) {
    const processId = Number(pidMatch[1]);
    return Number.isSafeInteger(processId) && processId > 0 ? { kind: 'process', processId } : null;
  }
  return { kind: 'executable', executablePath: value };
};

export type WindowsUiaSelector = { automationId?: string; name?: string; controlType?: string };

const selectorPart = (value: string): string => encodeURIComponent(value).replace(/%20/g, '+');

/** Build a stable, replayable selector without embedding the transient PID. */
export const buildWindowsUiaSelector = (item: WindowsUiaSelector): string => {
  const parts: string[] = [];
  if (item.automationId) parts.push(`id=${selectorPart(item.automationId)}`);
  if (item.name) parts.push(`name=${selectorPart(item.name)}`);
  if (item.controlType) parts.push(`type=${selectorPart(item.controlType.replace(/^ControlType\./, ''))}`);
  return `uia:${parts.join(';') || 'focused=true'}`;
};

/** Parse both structured selectors and the legacy `uia:<id-or-name>` form. */
export const parseWindowsUiaSelector = (selector: string): WindowsUiaSelector | null => {
  if (!selector.startsWith('uia:')) return null;
  const body = selector.slice(4);
  if (!body || body === 'focused=true') return {};
  if (!body.includes('=')) return { automationId: body };
  const result: WindowsUiaSelector = {};
  for (const segment of body.split(';')) {
    const equal = segment.indexOf('=');
    if (equal < 1) continue;
    const key = segment.slice(0, equal);
    const raw = segment.slice(equal + 1).replace(/\+/g, ' ');
    let value = '';
    try {
      value = decodeURIComponent(raw);
    } catch {
      return null;
    }
    if (key === 'id') result.automationId = value;
    else if (key === 'name') result.name = value;
    else if (key === 'type') result.controlType = value;
  }
  return Object.keys(result).length > 0 ? result : null;
};

const encodePowerShellValue = (value: string): string => Buffer.from(value, 'utf8').toString('base64');

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

const runPowerShell = async (script: string, timeout = 5000): Promise<string> => {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
  );
  return stdout.trim();
};

const resolveWindowsIdentity = async (processId: number, executable?: string): Promise<NativeTargetIdentity> => {
  const fallback: NativeTargetIdentity = { platform: 'windows', processId, executable };
  try {
    const stdout = await runPowerShell(
      `$p = Get-Process -Id ${processId} -ErrorAction Stop; [Console]::WriteLine((@{ title=$p.MainWindowTitle; handle=([string]$p.MainWindowHandle); path=$p.Path } | ConvertTo-Json -Compress))`
    );
    const item = JSON.parse(stdout.split(/\r?\n/).pop() ?? '{}') as {
      title?: string;
      handle?: string;
      path?: string;
    };
    return {
      ...fallback,
      executable: item.path || executable,
      windowHandle: item.handle && item.handle !== '0' ? item.handle : undefined,
      windowTitle: item.title || undefined,
    };
  } catch {
    return fallback;
  }
};

const captureWindowsTarget = async (processId: number): Promise<Buffer | null> => {
  try {
    const stdout = await runPowerShell(`
      Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes; Add-Type -AssemblyName System.Drawing;
      $condition = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${processId});
      $e = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children, $condition);
      if ($null -eq $e) { exit 0 }; $r = $e.Current.BoundingRectangle;
      if ($r.Width -le 0 -or $r.Height -le 0) { exit 0 };
      $bmp = New-Object System.Drawing.Bitmap([int]$r.Width, [int]$r.Height);
      $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen([int]$r.X, [int]$r.Y, 0, 0, $bmp.Size);
      $m = New-Object System.IO.MemoryStream; $bmp.Save($m, [System.Drawing.Imaging.ImageFormat]::Png);
      [Console]::Write([Convert]::ToBase64String($m.ToArray())); $g.Dispose(); $bmp.Dispose(); $m.Dispose();
    `);
    return stdout ? Buffer.from(stdout, 'base64') : null;
  } catch {
    return null;
  }
};

const performWindowsAction = async (processId: number, action: NativeAutomationAction): Promise<boolean> => {
  const selector = parseWindowsUiaSelector(action.selector);
  if (!selector) return false;
  const id = encodePowerShellValue(selector.automationId ?? '');
  const name = encodePowerShellValue(selector.name ?? '');
  const type = encodePowerShellValue(selector.controlType ?? '');
  const value = encodePowerShellValue(action.kind === 'input' ? action.value : '');
  const actionKind = action.kind;
  try {
    const stdout = await runPowerShell(`
      Add-Type -AssemblyName UIAutomationClient; Add-Type -AssemblyName UIAutomationTypes;
      function Decode([string]$v) { [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($v)) }
      $id=Decode('${id}'); $name=Decode('${name}'); $type=Decode('${type}'); $value=Decode('${value}');
      $pc=New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ProcessIdProperty, ${processId});
      $root=[System.Windows.Automation.AutomationElement]::RootElement.FindFirst([System.Windows.Automation.TreeScope]::Children,$pc);
      if ($null -eq $root) { [Console]::Write('false'); exit 0 }; $conditions=New-Object System.Collections.Generic.List[System.Windows.Automation.Condition];
      if ($id) { $conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::AutomationIdProperty,$id))) }
      if ($name) { $conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty,$name))) }
      if ($type) { $conditions.Add((New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::LocalizedControlTypeProperty,$type.ToLowerInvariant()))) }
      $condition=if($conditions.Count -eq 0){[System.Windows.Automation.Condition]::TrueCondition}elseif($conditions.Count -eq 1){$conditions[0]}else{New-Object System.Windows.Automation.AndCondition(,$conditions.ToArray())};
      $e=$root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,$condition); if($null -eq $e){[Console]::Write('false');exit 0};
      try { $e.SetFocus() } catch {};
      if ('${actionKind}' -eq 'input') { try { $p=$e.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern); $p.SetValue($value); [Console]::Write('true') } catch { [Console]::Write('false') } }
      else { try { $p=$e.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $p.Invoke(); [Console]::Write('true') } catch { try { $p=$e.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern); $p.Select(); [Console]::Write('true') } catch { [Console]::Write('false') } } }
    `);
    return stdout.endsWith('true');
  } catch {
    return false;
  }
};

const createAttachedWindowsStream = (processId: number): NativeLogStream => {
  const closeListeners: Array<(info: { code: number | null }) => void> = [];
  let closed = false;
  const timer = setInterval(() => {
    if (closed) return;
    try {
      process.kill(processId, 0);
    } catch {
      closed = true;
      clearInterval(timer);
      for (const listener of closeListeners) listener({ code: 0 });
    }
  }, 1000);
  return {
    processId,
    capabilities: { logs: false, interactions: true, screenshots: true, actions: true, attach: true },
    onLine: () => undefined,
    onClose: (listener) => closeListeners.push(listener),
    close: () => {
      closed = true;
      clearInterval(timer);
    },
  };
};

const installWindowsAutomation = async (stream: NativeLogStream, executable?: string): Promise<NativeLogStream> => {
  const processId = stream.processId;
  if (!processId) return stream;
  stream.identity = await resolveWindowsIdentity(processId, executable);
  stream.capabilities = {
    logs: stream.capabilities?.logs ?? true,
    interactions: true,
    screenshots: true,
    actions: true,
    attach: stream.capabilities?.attach ?? false,
  };
  stream.captureScreenshot = () => captureWindowsTarget(processId);
  stream.performAction = (action) => performWindowsAction(processId, action);
  attachWindowsAccessibilityProbe(stream);
  return stream;
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
  stream.target = serial;
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
  const parsed = parseWindowsNativeTarget(target);
  if (!parsed) return null;
  if (parsed.kind === 'process') {
    const stream = createAttachedWindowsStream(parsed.processId);
    stream.target = `pid:${parsed.processId}`;
    return installWindowsAutomation(stream);
  }
  const exePath = parsed.executablePath;
  const proc = spawn(exePath, [], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  // `spawn` reports launch failures asynchronously via the 'error' event; pid is
  // set synchronously when the OS accepted the spawn.
  if (!proc.pid) return null;
  const stream = streamFromProcess(proc);
  stream.target = exePath;
  return installWindowsAutomation(stream, exePath);
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

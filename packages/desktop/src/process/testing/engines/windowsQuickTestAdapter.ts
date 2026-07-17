import { spawn } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type WindowsQuickTestProcess = {
  processId: number;
  onLine: (listener: (line: string) => void) => void;
  close: () => void;
};

export type WindowsQuickTestAdapter = {
  identity: { processId: number; target: string; exePath?: string };
  capabilities: {
    uiAutomation: boolean;
    screenshot: boolean;
    logs: boolean;
    deepLink: boolean;
  };
  navigate: (url: string) => Promise<void>;
  click: (selector: string) => Promise<void>;
  input: (selector: string, value: string) => Promise<void>;
  screenshot: () => Promise<string>;
  collectEvidence: () => Promise<{
    consoleErrors: string[];
    networkFailures: string[];
    attachments: string[];
    relatedFiles: string[];
  }>;
  dispose: () => void;
};

export type CreateWindowsQuickTestAdapterOptions = {
  rootPath: string;
  runId: string;
  target: string;
  launch?: (exePath: string) => Promise<WindowsQuickTestProcess>;
  attach?: (processId: number) => Promise<WindowsQuickTestProcess>;
  runPowerShell?: (script: string) => Promise<string>;
};

export type WindowsQuickTestTarget =
  | { kind: 'process'; processId: number; target: string }
  | { kind: 'executable'; exePath: string; target: string };

/** Parse `pid:123`, a raw numeric PID, or an absolute/relative `.exe` path. */
export const parseWindowsQuickTestTarget = (target: string): WindowsQuickTestTarget | null => {
  const value = target.trim();
  if (!value) return null;
  const pidMatch = value.match(/^(?:pid:)?(\d+)$/i);
  if (pidMatch) {
    const processId = Number(pidMatch[1]);
    return Number.isSafeInteger(processId) && processId > 0
      ? { kind: 'process', processId, target: `pid:${processId}` }
      : null;
  }
  const exePath = path.resolve(value);
  return path.extname(exePath).toLowerCase() === '.exe' ? { kind: 'executable', exePath, target: exePath } : null;
};

const psQuote = (value: string): string => `'${value.replace(/'/g, "''")}'`;

const defaultPowerShell = async (script: string): Promise<string> => {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { timeout: 20_000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }
  );
  return stdout;
};

const defaultLaunch = async (exePath: string): Promise<WindowsQuickTestProcess> => {
  const processHandle = spawn(exePath, [], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  if (!processHandle.pid) throw new Error(`Failed to launch ${exePath}.`);
  const listeners: Array<(line: string) => void> = [];
  let buffer = '';
  const onData = (chunk: Buffer | string): void => {
    buffer += chunk.toString();
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const line = buffer.slice(0, newline).replace(/\r$/, '');
      buffer = buffer.slice(newline + 1);
      for (const listener of listeners) listener(line);
      newline = buffer.indexOf('\n');
    }
  };
  processHandle.stdout?.on('data', onData);
  processHandle.stderr?.on('data', onData);
  return {
    processId: processHandle.pid,
    onLine: (listener) => listeners.push(listener),
    close: () => {
      if (!processHandle.killed) processHandle.kill();
    },
  };
};

const defaultAttach = async (processId: number): Promise<WindowsQuickTestProcess> => ({
  processId,
  onLine: () => undefined,
  close: () => undefined,
});

const automationPrelude = (processId: number): string => `
Add-Type -AssemblyName UIAutomationClient;
Add-Type -AssemblyName UIAutomationTypes;
$root = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
  [System.Windows.Automation.TreeScope]::Children,
  (New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ProcessIdProperty,
    ${processId}
  ))
);
if ($null -eq $root) { throw 'Windows application window was not found.' }
`;

const selectorScript = (selector: string): string => {
  const normalized = selector.trim().replace(/^uia:/, '');
  if (!normalized) throw new Error('A Windows UI Automation selector is required.');
  return `
$expected = ${psQuote(normalized)};
$element = $root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition) |
  Where-Object {
    $_.Current.AutomationId -eq $expected -or
    $_.Current.Name -eq $expected -or
    $_.Current.ControlType.ProgrammaticName -eq $expected
  } | Select-Object -First 1;
if ($null -eq $element) { throw ('Windows element was not found: ' + $expected) }
`;
};

const uniqueLines = (items: readonly string[], limit = 100): string[] =>
  [...new Set(items.map((line) => line.trim()).filter(Boolean))].slice(-limit);

export const createWindowsQuickTestAdapter = async (
  options: CreateWindowsQuickTestAdapterOptions
): Promise<WindowsQuickTestAdapter> => {
  const target = parseWindowsQuickTestTarget(options.target);
  if (!target) throw new Error('A valid Windows .exe path or process id target is required.');
  if (process.platform !== 'win32' && !options.launch && !options.attach) {
    throw new Error('Windows desktop replay is only available on Windows.');
  }
  const ownsProcess = target.kind === 'executable';
  const launch = options.launch ?? defaultLaunch;
  const attach = options.attach ?? defaultAttach;
  const runPowerShell = options.runPowerShell ?? defaultPowerShell;
  const processHandle = target.kind === 'executable' ? await launch(target.exePath) : await attach(target.processId);
  const logs: string[] = [];
  processHandle.onLine((line) => logs.push(line.slice(0, 2_000)));

  const probe = await runPowerShell(
    automationPrelude(processHandle.processId) + '[Console]::WriteLine($root.Current.Name)'
  ).then(
    (): boolean => true,
    (): boolean => false
  );
  if (!probe) {
    if (ownsProcess) processHandle.close();
    throw new Error('The Windows app does not expose a UI Automation window.');
  }

  const evidenceDirectory = path.join(path.resolve(options.rootPath), '.omni', 'quick-test', 'runs', options.runId);
  const screenshot = async (): Promise<string> => {
    const filePath = path.join(evidenceDirectory, 'windows-final.png');
    await fsp.mkdir(evidenceDirectory, { recursive: true });
    await runPowerShell(
      automationPrelude(processHandle.processId) +
        `
Add-Type -AssemblyName System.Drawing;
$bounds = $root.Current.BoundingRectangle;
if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw 'Window bounds are unavailable.' }
$bitmap = New-Object System.Drawing.Bitmap([int]$bounds.Width, [int]$bounds.Height);
$graphics = [System.Drawing.Graphics]::FromImage($bitmap);
$graphics.CopyFromScreen([int]$bounds.X, [int]$bounds.Y, 0, 0, $bitmap.Size);
$bitmap.Save(${psQuote(filePath)}, [System.Drawing.Imaging.ImageFormat]::Png);
$graphics.Dispose();
$bitmap.Dispose();
`
    );
    return filePath;
  };

  let disposed = false;
  return {
    identity: {
      processId: processHandle.processId,
      target: target.target,
      ...(target.kind === 'executable' ? { exePath: target.exePath } : {}),
    },
    capabilities: { uiAutomation: true, screenshot: true, logs: ownsProcess, deepLink: true },
    navigate: async (url) => {
      const parsed = new URL(url);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Unsafe Windows replay URL.');
      await runPowerShell(`Start-Process ${psQuote(parsed.href)}`);
    },
    click: async (selector) => {
      await runPowerShell(
        automationPrelude(processHandle.processId) +
          selectorScript(selector) +
          `
$pattern = $null;
if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
  $pattern.Invoke();
} else {
  $element.SetFocus();
  Add-Type -AssemblyName System.Windows.Forms;
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}');
}
`
      );
    },
    input: async (selector, value) => {
      await runPowerShell(
        automationPrelude(processHandle.processId) +
          selectorScript(selector) +
          `
$pattern = $null;
if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
  $pattern.SetValue(${psQuote(value)});
} else {
  $element.SetFocus();
  Add-Type -AssemblyName System.Windows.Forms;
  [System.Windows.Forms.SendKeys]::SendWait('^a');
  [System.Windows.Forms.SendKeys]::SendWait(${psQuote(value)});
}
`
      );
    },
    screenshot,
    collectEvidence: async () => {
      if (disposed) return { consoleErrors: [], networkFailures: [], attachments: [], relatedFiles: [] };
      const consoleErrors = uniqueLines(logs.filter((line) => /error|exception|fail/i.test(line)));
      const relatedFiles = uniqueLines(
        logs.flatMap((line): string[] => line.match(/[\w./\\-]+\.(?:cs|cpp|c|h|js|tsx?|py):\d+/gi) ?? [])
      );
      const attachment = await screenshot().catch((): string => '');
      return {
        consoleErrors,
        networkFailures: [],
        attachments: attachment ? [attachment] : [],
        relatedFiles,
      };
    },
    dispose: () => {
      disposed = true;
      if (ownsProcess) processHandle.close();
    },
  };
};

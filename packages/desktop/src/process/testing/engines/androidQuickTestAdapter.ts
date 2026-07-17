import { execFile } from 'node:child_process';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { resolveAdb } from './toolResolver';

const execFileAsync = promisify(execFile);

export type AndroidDeviceIdentity = {
  serial: string;
  manufacturer: string;
  model: string;
  sdk: number | null;
  packageName: string | null;
  activity: string | null;
};

export type AndroidQuickTestCapabilities = {
  adb: true;
  hierarchy: boolean;
  screenshot: boolean;
  logs: boolean;
  deepLink: boolean;
  gestures: true;
};

export type AndroidAdbResult = { stdout: string | Buffer };
export type AndroidAdbExecutor = (
  args: string[],
  options?: { timeout?: number; encoding?: 'utf8' | 'buffer'; maxBuffer?: number }
) => Promise<AndroidAdbResult>;

export type AndroidQuickTestAdapter = {
  identity: AndroidDeviceIdentity;
  capabilities: AndroidQuickTestCapabilities;
  navigate: (url: string) => Promise<void>;
  click: (selector: string) => Promise<void>;
  input: (selector: string, value: string) => Promise<void>;
  tap: (x: number, y: number) => Promise<void>;
  typeText: (value: string) => Promise<void>;
  swipe: (fromX: number, fromY: number, toX: number, toY: number, durationMs?: number) => Promise<void>;
  back: () => Promise<void>;
  readHierarchy: () => Promise<string>;
  screenshot: () => Promise<string>;
  collectEvidence: () => Promise<{
    consoleErrors: string[];
    networkFailures: string[];
    attachments: string[];
    relatedFiles: string[];
  }>;
  dispose: () => void;
};

export type CreateAndroidQuickTestAdapterOptions = {
  rootPath: string;
  runId: string;
  serial?: string;
  adbPath?: string;
  execute?: AndroidAdbExecutor;
};

type UiNode = {
  resourceId: string;
  text: string;
  contentDescription: string;
  className: string;
  bounds: string;
};

const asText = (value: string | Buffer): string => (Buffer.isBuffer(value) ? value.toString('utf8') : value);

const decodeXml = (value: string): string =>
  value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const attr = (node: string, name: string): string =>
  decodeXml(node.match(new RegExp(`(?:^|\\s)${name}="([^"]*)"`))?.[1] ?? '');

export const parseAndroidHierarchy = (xml: string): UiNode[] =>
  (xml.match(/<node\b[^>]*>/g) ?? []).map((node) => ({
    resourceId: attr(node, 'resource-id'),
    text: attr(node, 'text'),
    contentDescription: attr(node, 'content-desc'),
    className: attr(node, 'class'),
    bounds: attr(node, 'bounds'),
  }));

const selectorParts = (selector: string): { kind: 'id' | 'text' | 'desc' | 'class' | 'auto'; value: string } => {
  const trimmed = selector.trim().replace(/^uia:/, '');
  const prefixed = trimmed.match(/^(id|text|desc|class):(.+)$/i);
  if (!prefixed) return { kind: 'auto', value: trimmed };
  return { kind: prefixed[1].toLowerCase() as 'id' | 'text' | 'desc' | 'class', value: prefixed[2] };
};

export const findAndroidNode = (xml: string, selector: string): UiNode | null => {
  const expected = selectorParts(selector);
  return (
    parseAndroidHierarchy(xml).find((node) => {
      if (expected.kind === 'id') return node.resourceId === expected.value;
      if (expected.kind === 'text') return node.text === expected.value;
      if (expected.kind === 'desc') return node.contentDescription === expected.value;
      if (expected.kind === 'class') return node.className === expected.value;
      return [node.resourceId, node.text, node.contentDescription, node.className].includes(expected.value);
    }) ?? null
  );
};

const centerOfBounds = (bounds: string): { x: number; y: number } | null => {
  const match = bounds.match(/^\[(\d+),(\d+)]\[(\d+),(\d+)]$/);
  if (!match) return null;
  return {
    x: Math.round((Number(match[1]) + Number(match[3])) / 2),
    y: Math.round((Number(match[2]) + Number(match[4])) / 2),
  };
};

const parseFocus = (value: string): { packageName: string | null; activity: string | null } => {
  const match = value.match(/(?:mCurrentFocus|mFocusedApp).*?\s([\w.]+)\/([\w.$]+)/);
  return match ? { packageName: match[1], activity: match[2] } : { packageName: null, activity: null };
};

const uniqueLines = (value: string, limit = 100): string[] =>
  [
    ...new Set(
      value
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    ),
  ].slice(-limit);

export const createAndroidQuickTestAdapter = async (
  options: CreateAndroidQuickTestAdapterOptions
): Promise<AndroidQuickTestAdapter> => {
  const resolution = options.adbPath ? { ok: true as const, path: options.adbPath } : resolveAdb();
  if (!resolution.ok || !resolution.path) throw new Error(resolution.reason || 'Android Debug Bridge is unavailable.');
  const adbPath = resolution.path;
  const rawExecute: AndroidAdbExecutor =
    options.execute ??
    (async (args, executionOptions = {}) => {
      const encoding = executionOptions.encoding === 'buffer' ? 'buffer' : 'utf8';
      const result = await execFileAsync(adbPath, args, {
        timeout: executionOptions.timeout ?? 20_000,
        maxBuffer: executionOptions.maxBuffer ?? 4 * 1024 * 1024,
        encoding,
      });
      return { stdout: result.stdout };
    });
  const run = (args: string[], executionOptions?: Parameters<AndroidAdbExecutor>[1]): Promise<AndroidAdbResult> =>
    rawExecute(args, executionOptions);

  let serial = options.serial?.trim() ?? '';
  if (!serial) {
    const devices = asText((await run(['devices'], { timeout: 8_000 })).stdout);
    serial =
      devices
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /^\S+\s+device$/.test(line))
        ?.split(/\s+/)[0] ?? '';
  }
  if (!serial) throw new Error('No authorized Android device or emulator is connected.');

  const shell = async (args: string[], timeout = 20_000): Promise<string> =>
    asText((await run(['-s', serial, 'shell', ...args], { timeout })).stdout).trim();
  const getProp = (name: string): Promise<string> => shell(['getprop', name], 8_000).catch((): string => '');
  const [manufacturer, model, sdkValue, focus] = await Promise.all([
    getProp('ro.product.manufacturer'),
    getProp('ro.product.model'),
    getProp('ro.build.version.sdk'),
    shell(['dumpsys', 'window', 'windows'], 10_000).catch((): string => ''),
  ]);
  const focused = parseFocus(focus);

  const readHierarchy = async (): Promise<string> => {
    const result = await run(['-s', serial, 'exec-out', 'uiautomator', 'dump', '/dev/tty'], {
      timeout: 8_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const xml = asText(result.stdout);
    if (!xml.includes('<hierarchy')) throw new Error('Android UI hierarchy is unavailable for the current app.');
    return xml.slice(xml.indexOf('<hierarchy'));
  };

  const hierarchyAvailable = await readHierarchy().then(
    (): boolean => true,
    (): boolean => false
  );
  const screenshotAvailable = await run(['-s', serial, 'exec-out', 'screencap', '-p'], {
    timeout: 8_000,
    encoding: 'buffer',
  }).then(
    (result): boolean => Buffer.byteLength(result.stdout) > 8,
    (): boolean => false
  );

  const tap = async (x: number, y: number): Promise<void> => {
    if (![x, y].every(Number.isFinite)) throw new Error('Android tap coordinates must be finite numbers.');
    await shell(['input', 'tap', String(Math.round(x)), String(Math.round(y))]);
  };
  const typeText = async (value: string): Promise<void> => {
    const encoded = value
      .replace(/%/g, '%25')
      .replace(/\s/g, '%s')
      .replace(/[&<>|;()$`\\"']/g, '\\$&');
    await shell(['input', 'text', encoded]);
  };
  const click = async (selector: string): Promise<void> => {
    if (!hierarchyAvailable) throw new Error('This Android target does not expose a UIAutomator hierarchy.');
    const node = findAndroidNode(await readHierarchy(), selector);
    const center = node ? centerOfBounds(node.bounds) : null;
    if (!node || !center) throw new Error(`Android element was not found: ${selector}`);
    await tap(center.x, center.y);
  };

  let disposed = false;
  const evidenceDirectory = path.join(path.resolve(options.rootPath), '.omni', 'quick-test', 'runs', options.runId);
  const screenshot = async (): Promise<string> => {
    if (!screenshotAvailable) throw new Error('Android screenshots are unavailable for this target.');
    const result = await run(['-s', serial, 'exec-out', 'screencap', '-p'], {
      timeout: 10_000,
      encoding: 'buffer',
      maxBuffer: 16 * 1024 * 1024,
    });
    const filePath = path.join(evidenceDirectory, 'android-final.png');
    await fsp.mkdir(evidenceDirectory, { recursive: true });
    await fsp.writeFile(
      filePath,
      Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout, 'binary')
    );
    return filePath;
  };

  return {
    identity: {
      serial,
      manufacturer,
      model,
      sdk: /^\d+$/.test(sdkValue) ? Number(sdkValue) : null,
      packageName: focused.packageName,
      activity: focused.activity,
    },
    capabilities: {
      adb: true,
      hierarchy: hierarchyAvailable,
      screenshot: screenshotAvailable,
      logs: true,
      deepLink: true,
      gestures: true,
    },
    navigate: async (url) => {
      await shell(['am', 'start', '-W', '-a', 'android.intent.action.VIEW', '-d', url], 30_000);
    },
    click,
    input: async (selector, value) => {
      await click(selector);
      await shell(['input', 'keyevent', 'KEYCODE_CLEAR']).catch((): string => '');
      await typeText(value);
    },
    tap,
    typeText,
    swipe: async (fromX, fromY, toX, toY, durationMs = 300) => {
      await shell([
        'input',
        'swipe',
        String(Math.round(fromX)),
        String(Math.round(fromY)),
        String(Math.round(toX)),
        String(Math.round(toY)),
        String(Math.max(1, Math.round(durationMs))),
      ]);
    },
    back: async () => {
      await shell(['input', 'keyevent', 'KEYCODE_BACK']);
    },
    readHierarchy,
    screenshot,
    collectEvidence: async () => {
      if (disposed) return { consoleErrors: [], networkFailures: [], attachments: [], relatedFiles: [] };
      const logs = await shell(['logcat', '-d', '-v', 'brief', '*:E'], 15_000).catch((): string => '');
      const consoleErrors = uniqueLines(logs);
      const attachments = screenshotAvailable ? [await screenshot().catch((): string => '')].filter(Boolean) : [];
      const relatedFiles = uniqueLines(
        logs
          .split(/\r?\n/)
          .flatMap((line): string[] => line.match(/[\w./\\-]+\.(?:kt|java|dart|js|tsx?):\d+/gi) ?? [])
          .join('\n')
      );
      return { consoleErrors, networkFailures: [], attachments, relatedFiles };
    },
    dispose: () => {
      disposed = true;
    },
  };
};

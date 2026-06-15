/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wires the multi-platform testing layer for the Main process (Yêu cầu 2b, Task
 * 15.1). It assembles ONE shared {@link ITestOrchestrator} singleton that BOTH
 * integration planes drive (the "two planes" principle, `design.md`):
 *
 *   - UI plane    → `testingBridge` (the Testing page submits + reads sessions).
 *   - Agent plane → the Testing MCP server (`testingServer.ts`, `test_run` etc).
 *
 * Because both planes share the same orchestrator instance, a session an agent
 * starts is the same session the user sees in the Testing page, and vice-versa
 * (single source of truth).
 *
 * ## What runs for real today
 *
 * - **web** — a genuine end-to-end path. Tests run in an embedded Chromium tab
 *   (`browserViewManager`) on a hidden surface. The tab is the isolation
 *   boundary: the run NEVER takes over the user's real mouse/keyboard/desktop
 *   (criterion 2.2 / Property 1), so the user keeps working while it runs. The
 *   script driver drives the tab via `executeJavaScript`, the recorder captures
 *   real milestone screenshots via `capturePage()` (criterion 2.4) AND encodes a
 *   real video with the bundled ffmpeg (`ffmpeg-static`, no system install), and
 *   the markdown report is written to disk (criterion 2.5).
 * - **android** — REAL via the Android SDK: `engines/androidEngine.ts` boots an
 *   installed AVD with the `emulator` binary, waits for `sys.boot_completed`, and
 *   drives it over `adb` (tap/text/key/assertText). The emulator is its own
 *   window/process (isolated from the user's input). Requires the SDK +
 *   ANDROID_HOME + an AVD; without them the display backend reports unsupported
 *   and the session ends with an honest error (no fake pass).
 * - **windows** — REAL via `engines/windowsEngine.ts`: launches the `.exe` and
 *   drives it through PowerShell (.NET SendKeys + UI Automation, built into
 *   Windows). True per-session isolation needs a native `CreateDesktop` module
 *   we do not bundle, so a Windows run drives the SHARED desktop (app launched
 *   minimized, targeted by window handle). Enabled by default on Windows so it
 *   is click-to-run; set `AIONUI_DISABLE_WINDOWS_TEST=1` to refuse Windows.
 *
 * Everything heavy is still injected into the orchestrator, so the unit tests in
 * `tests/unit/testing/` keep driving it with fakes. Process boundary:
 * Main-process (Node.js) module — no DOM APIs (the `executeJavaScript` snippets
 * are plain strings that run inside the page, never in Node).
 */

import { app } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createBrowserViewManager, type IBrowserViewManager } from '../browser/browserViewManager';
import { getResourceCoordinator } from '../resource/resourceCoordinator';
import { createAppLauncher } from './appLauncher';
import {
  createComputerUseDriver,
  type DisplayCapture,
  type DisplayInputSink,
  type VisionModel,
} from './computerUseDriver';
import { createAndroidTarget } from './platforms/androidTarget';
import { createWebTarget } from './platforms/webTarget';
import { createWindowsTarget } from './platforms/windowsTarget';
import type { IPlatformTarget } from './platforms/platformTarget';
import { createRecorder } from './recorder';
import { createScriptDriver, type ScriptEngine, type DriverStepResult } from './scriptDriver';
import { createTestOrchestrator, type ITestOrchestrator } from './testOrchestrator';
import { createVirtualDisplayManager, type DisplayBackend } from './virtualDisplayManager';
import type { Viewport } from './testingTypes';
import { createFfmpegVideoBackend } from './engines/ffmpegVideoBackend';
import { createAndroidScriptEngine, createRealEmulatorProvisioner } from './engines/androidEngine';
import { createWindowsScriptEngine, createRealWindowsLauncher } from './engines/windowsEngine';
import { listAvds, resolveEmulator } from './engines/toolResolver';

/** Services the testing bridge + MCP server share. */
export type TestingServices = {
  /** The shared orchestrator both planes drive. */
  orchestrator: ITestOrchestrator;
  /** Root directory under which all test artifacts (reports, screenshots, video) live. */
  artifactRoot: string;
};

/** Resolve the directory that holds test artifacts (reports, screenshots). */
const resolveTestingDir = (): string => path.join(app.getPath('userData'), 'testing');

/** Delay primitive shared by the web script engine + general pacing. */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

// ---------------------------------------------------------------------------
// web execution backends (real — embedded browser)
// ---------------------------------------------------------------------------

/** Read the rendered <body> text of the page (light, no lease). */
const readBodyText = async (contents: WebContents): Promise<string> => {
  const script = `(() => {
    const el = document.body;
    if (!el) return '';
    const text = el.innerText != null ? el.innerText : el.textContent;
    return text ? String(text) : '';
  })()`;
  const result: unknown = await contents.executeJavaScript(script);
  return typeof result === 'string' ? result : '';
};

/** Click the first element matching `selector` in the page; resolve whether it matched. */
const clickSelector = async (contents: WebContents, selector: string): Promise<boolean> => {
  const script = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' });
    el.click();
    return true;
  })()`;
  const result: unknown = await contents.executeJavaScript(script);
  return result === true;
};

/** Set the value of the first element matching `selector` and fire input/change. */
const typeInto = async (contents: WebContents, selector: string, value: string): Promise<boolean> => {
  const script = `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.focus();
    el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`;
  const result: unknown = await contents.executeJavaScript(script);
  return result === true;
};

/** Parse a step description into a leading verb + the remainder. */
const parseDirective = (description: string): { verb: string; rest: string } => {
  const trimmed = description.trim();
  const spaceIdx = trimmed.indexOf(' ');
  const verb = (spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx)).toLowerCase();
  const rest = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();
  return { verb, rest };
};

/**
 * The web {@link ScriptEngine} (criterion 2.8a). It interprets a small, explicit
 * step grammar and runs each step against the embedded tab — no hidden magic, so
 * an unknown directive fails honestly instead of silently passing:
 *
 *   - `goto <url>` / `open <url>`   — navigate the tab (https assumed if no scheme)
 *   - `wait <ms>`                   — pause
 *   - `assertText <substring>`      — pass if the page text contains the substring
 *   - `assertTitle <substring>`     — pass if the document title contains it
 *   - `click <css-selector>`        — click the first matching element
 *   - `type <css-selector> => text` — set a field's value and fire input/change
 */
const createWebScriptEngine = (viewManager: IBrowserViewManager): ScriptEngine => ({
  platform: 'web',
  execute: async (step, target): Promise<DriverStepResult> => {
    const tabId = target.tabId;
    if (!tabId) return { passed: false, detail: 'No test tab was provisioned for this web session.' };
    const contents = viewManager.getWebContents(tabId);
    if (!contents) return { passed: false, detail: 'The test tab has no live web contents.' };

    const { verb, rest } = parseDirective(step.description);
    try {
      switch (verb) {
        case 'goto':
        case 'open': {
          const url = /^[a-z][\w+.-]*:\/\//i.test(rest) ? rest : `https://${rest}`;
          try {
            await viewManager.loadURL(tabId, url);
            return { passed: true, detail: `Navigated to ${url}` };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            // Translate Chromium load errors into something actionable.
            if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION/i.test(msg)) {
              return {
                passed: false,
                detail: `Could not reach ${url} — nothing is running there. Start your app first, or set a start command in "App under test" so the test launches it.`,
              };
            }
            if (/ERR_NAME_NOT_RESOLVED|ERR_ADDRESS/i.test(msg)) {
              return { passed: false, detail: `Could not resolve ${url}. Check the URL is correct.` };
            }
            return { passed: false, detail: `Failed to open ${url}: ${msg}` };
          }
        }
        case 'wait': {
          const ms = Math.max(0, Number(rest) || 0);
          await sleep(ms);
          return { passed: true, detail: `Waited ${ms}ms` };
        }
        case 'asserttext':
        case 'expecttext': {
          const text = (await readBodyText(contents)).toLowerCase();
          const ok = text.includes(rest.toLowerCase());
          return { passed: ok, detail: ok ? `Found text: "${rest}"` : `Text not found: "${rest}"` };
        }
        case 'asserttitle':
        case 'expecttitle': {
          const title = contents.getTitle();
          const ok = title.toLowerCase().includes(rest.toLowerCase());
          return { passed: ok, detail: `Title "${title}" ${ok ? 'contains' : 'does not contain'} "${rest}"` };
        }
        case 'click': {
          const ok = await clickSelector(contents, rest);
          return { passed: ok, detail: ok ? `Clicked "${rest}"` : `No element matched "${rest}"` };
        }
        case 'type': {
          const arrow = rest.indexOf('=>');
          if (arrow === -1) return { passed: false, detail: 'A type step needs the form: type <selector> => <text>' };
          const selector = rest.slice(0, arrow).trim();
          const value = rest.slice(arrow + 2).trim();
          const ok = await typeInto(contents, selector, value);
          return { passed: ok, detail: ok ? `Typed into "${selector}"` : `No element matched "${selector}"` };
        }
        default:
          return {
            passed: false,
            detail: `Unknown step directive "${verb}". Supported: goto, wait, assertText, assertTitle, click, type.`,
          };
      }
    } catch (error) {
      return { passed: false, detail: error instanceof Error ? error.message : String(error) };
    }
  },
});

/** An OS-backend that exposes the embedded-browser surface as an isolated display. */
const embeddedDisplayBackend: DisplayBackend = {
  name: 'embedded-browser',
  isSupported: async () => true,
  create: async () => ({ target: { kind: 'embedded-browser' } }),
  destroy: async () => undefined,
};

/**
 * Android display backend: the emulator is its OWN window/process (isolated from
 * the user's input focus), so it counts as an isolated display. Supported only
 * when the SDK `emulator` resolves AND at least one AVD exists — otherwise the
 * virtual-display manager refuses Android (no fake pass).
 */
const androidDisplayBackend: DisplayBackend = {
  name: 'android-emulator',
  isSupported: async () => {
    const emu = resolveEmulator();
    if (!emu.ok) return false;
    const avds = await listAvds(emu.path);
    return avds.length > 0;
  },
  create: async () => ({ target: { kind: 'android-emulator' } }),
  destroy: async () => undefined,
};

/**
 * Windows display backend. True per-session isolation needs a native
 * `CreateDesktop` module we do not bundle, so a Windows run drives the SHARED
 * desktop: the app launches minimized and the engine targets it by window
 * handle (not global input), so it stays out of the user's way as much as
 * possible. This is enabled by default on Windows so the feature is
 * click-to-run; set `AIONUI_DISABLE_WINDOWS_TEST=1` to turn it off (then the
 * manager refuses Windows instead of touching the shared desktop).
 */
const windowsDisplayBackend: DisplayBackend = {
  name: 'windows-shared-desktop',
  isSupported: async () => process.platform === 'win32' && process.env.AIONUI_DISABLE_WINDOWS_TEST !== '1',
  create: async () => ({ target: { kind: 'windows-shared-desktop' } }),
  destroy: async () => undefined,
};

// ---------------------------------------------------------------------------
// singleton assembly
// ---------------------------------------------------------------------------

/** Lazily-built shared services. */
let services: TestingServices | undefined;
/** The dedicated view manager testing owns (separate from the user's browser tabs). */
let testingViewManager: IBrowserViewManager | undefined;

/**
 * Build (once) and return the Main-process testing services. Safe to call before
 * the window exists — the embedded view manager resolves the window lazily, only
 * when a web session actually provisions a tab.
 *
 * @param getWindow Accessor returning the main window to host the hidden test tabs.
 * @returns The shared testing services (the orchestrator both planes drive).
 */
export const getTestingServices = (getWindow: () => BrowserWindow | null | undefined): TestingServices => {
  if (services) return services;

  const coordinator = getResourceCoordinator();
  const outputDir = resolveTestingDir();

  // A dedicated browser view manager so test tabs never pollute the user's
  // browsing tabs. Its WebContentsViews are created hidden + off the user's flow.
  testingViewManager = createBrowserViewManager({ getWindow });
  const viewManager = testingViewManager;

  // --- platform targets ----------------------------------------------------
  const webTarget: IPlatformTarget = createWebTarget({
    provisioner: {
      open: async (_displayTarget, viewport: Viewport) => {
        const id = viewManager.createTab({
          visible: false,
          bounds: { x: 0, y: 0, width: viewport.width, height: viewport.height },
        });
        return { target: { tabId: id } };
      },
      close: async (target) => {
        if (target.tabId) viewManager.destroyTab(target.tabId);
      },
    },
  });

  const androidTarget: IPlatformTarget = createAndroidTarget({
    profiles: [{ avdName: 'auto', viewport: { width: 1080, height: 1920, label: 'phone' } }],
    provisioner: createRealEmulatorProvisioner(),
  });

  const windowsTarget: IPlatformTarget = createWindowsTarget({
    // The .exe under test is supplied per-scenario via `app.exePath` (picked in
    // the Testing UI). The env var is a fallback default for headless/agent runs.
    exePath: process.env.AIONUI_WINDOWS_TEST_EXE,
    launcher: createRealWindowsLauncher(),
  });

  // --- drivers -------------------------------------------------------------
  // Real per-platform script engines: web (embedded Chromium), android (adb),
  // windows (PowerShell UI automation). Each fails honestly when its tooling is
  // absent rather than faking a pass.
  const scriptDriver = createScriptDriver({
    engines: [createWebScriptEngine(viewManager), createAndroidScriptEngine(), createWindowsScriptEngine()],
  });

  // Computer-use fallback: vision is not configured, so it rejects honestly. It
  // is only reached when a run explicitly forces `preferComputerUse`.
  const captureForVision: DisplayCapture = {
    capture: async (target) => {
      const contents = target.tabId ? viewManager.getWebContents(target.tabId) : undefined;
      if (!contents) return '';
      const image = await contents.capturePage();
      return image.isEmpty() ? '' : image.toDataURL();
    },
  };
  const noInput: DisplayInputSink = {
    click: async () => undefined,
    type: async () => undefined,
  };
  const unavailableVision: VisionModel = {
    decide: async () => ({
      type: 'done',
      passed: false,
      detail: 'Computer-use vision is not configured; use the script driver (the default).',
    }),
  };
  const computerUseDriver = createComputerUseDriver({
    vision: unavailableVision,
    capture: captureForVision,
    input: noInput,
  });

  // --- recorder + display + report writer ----------------------------------
  // Real video: ffmpeg encodes the captured frames into an actual .mp4 (bundled
  // ffmpeg-static, no system install). Falls back to screenshots-only only if
  // the bundled binary is somehow missing.
  const recorder = createRecorder({
    backend: createFfmpegVideoBackend({ getWebContents: (id) => viewManager.getWebContents(id) }),
    outputDir,
  });
  const displayManager = createVirtualDisplayManager({
    backends: [embeddedDisplayBackend, androidDisplayBackend, windowsDisplayBackend],
  });

  const writeReport = async (sessionId: string, report: { markdown: string }): Promise<string> => {
    const dir = path.join(outputDir, sessionId);
    await fs.mkdir(dir, { recursive: true });
    const reportPath = path.join(dir, 'report.md');
    await fs.writeFile(reportPath, report.markdown, 'utf-8');
    return reportPath;
  };

  const orchestrator = createTestOrchestrator({
    displayManager,
    targets: [webTarget, androidTarget, windowsTarget],
    scriptDriver,
    computerUseDriver,
    recorder,
    coordinator,
    writeReport,
    appLauncher: createAppLauncher(),
  });

  services = { orchestrator, artifactRoot: outputDir };
  return services;
};

/**
 * Reset the lazily-built services + dispose test tabs. Useful for deterministic
 * teardown (tests / hot-reload).
 */
export const disposeTestingServices = (): void => {
  testingViewManager?.dispose();
  testingViewManager = undefined;
  services = undefined;
};

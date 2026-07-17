/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wires the agent-facing Browser-Control MCP server (Requirement 1 — Agent
 * plane) for the Main process. It assembles the {@link BrowserControlDeps} the
 * server needs from the real browser services and starts the in-process SSE
 * host, then registers it in the MCP catalog as an `sse` server so an agent
 * (Claude Code / ACP, aionrs, …) can connect and drive the live embedded
 * browser.
 *
 * ## Shared browser, two planes
 *
 * Per the design's "two planes" principle the Agent plane MUST drive the **same**
 * {@link IBrowserViewManager} as the UI plane (`browserBridge.getBrowserServices`).
 * We therefore reuse that singleton so a tab the agent opens is the same tab the
 * user can see (and that the in-conversation surfaces panel renders).
 *
 * ## Media pipeline
 *
 * `browser_summarize_video` needs an {@link IMediaPipeline}. The real pipeline
 * depends on heavy workers (ffmpeg / Whisper / TTS) that are not yet bundled, so
 * we inject a minimal stub that performs the **YouTube-or-fail** behaviour
 * honestly: the one tool that needs it degrades to a clear "not available yet"
 * message instead of crashing the whole server. Every other tool
 * (open/read/click/type/scroll/wait/screenshot) is fully real.
 *
 * Process boundary: Main-process (Node.js / Electron) module.
 */

import type { BrowserWindow } from 'electron';
import { NativeFileGateway } from '@process/resources/nativeFileGateway';
import { getResourceCoordinator } from '../resource/resourceCoordinator';
import { getBrowserServices } from './browserBridge';
import { createHumanLikeInput } from './humanLikeInput';
import { createPagePerception, type IPagePerception } from './pagePerception';
import type { IMediaPipeline, MediaSource } from './mediaPipeline';
import type { BrowserControlDeps } from '../resources/builtinMcp/browserControlServer';
import { startBrowserControlMcpHost, type BrowserControlMcpHost } from './browserControlMcpHost';
import { getEditorFrameStore } from '../editor/editorFrameStore';
import {
  createQuickTestLifecycleService,
  createTerminalQuickTestLauncher,
  type QuickTestLifecycleService,
} from '../services/quick-test/lifecycle';
import { getTerminalServices } from '../terminal/terminalWiring';
import { getRepoSecretStore } from '../ide/memory/repoSecretStore';

/**
 * Set a secret directly in a form control without ever returning its value to
 * the MCP client. The value deliberately exists only in this Main-process
 * closure and the target page's form control.
 */
const fillBrowserSecret = async (
  viewManager: ReturnType<typeof getBrowserServices>['viewManager'],
  request: { tabId: string; selector: string; repository: string; secretAlias: string }
): Promise<void> => {
  const contents = viewManager.getWebContents(request.tabId);
  if (!contents) throw new Error('The selected browser tab is no longer available.');

  const values = await getRepoSecretStore().resolveEnvironment(request.repository, [request.secretAlias]);
  const secret = values[request.secretAlias.trim().toUpperCase()];
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new Error(`Secret Context alias ${request.secretAlias.trim().toUpperCase()} has no stored value.`);
  }

  // The serialized value is sent only to the selected page. This script never
  // returns it, and its failures are converted to a fixed error below so an
  // Electron exception cannot echo a value back into the model/tool result.
  const script = `(() => {
    try {
      const element = document.querySelector(${JSON.stringify(request.selector)});
      if (!element) return false;
      const value = ${JSON.stringify(secret)};
      if (element instanceof HTMLInputElement) {
        if (element.type === 'file' || element.disabled || element.readOnly) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (!setter) return false;
        element.focus();
        setter.call(element, value);
      } else if (element instanceof HTMLTextAreaElement) {
        if (element.disabled || element.readOnly) return false;
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (!setter) return false;
        element.focus();
        setter.call(element, value);
      } else if (element instanceof HTMLElement && element.isContentEditable) {
        element.focus();
        element.textContent = value;
      } else {
        return false;
      }
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: null }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch {
      return false;
    }
  })()`;

  let filled = false;
  try {
    filled = (await contents.executeJavaScript(script)) === true;
  } catch {
    filled = false;
  }
  if (!filled) throw new Error('Could not fill the selected browser form control with the Secret Context alias.');
};

/**
 * Minimal {@link IMediaPipeline} for the Agent plane. Video summarisation needs
 * heavy workers that are not bundled yet, so every method rejects with a clear,
 * honest message rather than pretending to work. `browser_summarize_video`
 * surfaces this as a tool error; no other Browser-Control tool touches it.
 */
const createStubMediaPipeline = (): IMediaPipeline => {
  const notAvailable = (what: string): Promise<never> =>
    Promise.reject(new Error(`${what} is not available yet (media workers are not bundled).`));
  return {
    summarizeVideo: (source: MediaSource) =>
      notAvailable(`Summarising ${source.type === 'url' ? source.url : source.path}`),
    transcribe: () => notAvailable('Transcription'),
    generateSubtitles: () => notAvailable('Subtitle generation'),
    dub: () => notAvailable('Dubbing'),
    getJob: () => undefined,
    listJobs: () => [],
  };
};

/** Lazily-built deps so the host + register step share one assembly. */
let cachedDeps: BrowserControlDeps | undefined;
let quickTestLifecycle: QuickTestLifecycleService | undefined;

/** Resolve the shared agent Quick Test lifecycle bound to the browser and IDE terminal singletons. */
export const getQuickTestLifecycle = (getWindow: () => BrowserWindow | null | undefined): QuickTestLifecycleService => {
  if (quickTestLifecycle) return quickTestLifecycle;
  const browser = getBrowserServices(getWindow).viewManager;
  const terminal = getTerminalServices().manager;
  quickTestLifecycle = createQuickTestLifecycleService({
    viewManager: browser,
    launcher: createTerminalQuickTestLauncher(terminal),
  });
  return quickTestLifecycle;
};

/**
 * Build (once) the {@link BrowserControlDeps} from the shared browser services.
 *
 * @param getWindow Main-window accessor (shared with the UI-plane browser bridge).
 */
export const getBrowserControlDeps = (getWindow: () => BrowserWindow | null | undefined): BrowserControlDeps => {
  if (cachedDeps) return cachedDeps;

  const coordinator = getResourceCoordinator();
  // Reuse the UI-plane browser services so both planes share ONE view manager.
  const services = getBrowserServices(getWindow);
  const viewManager = services.viewManager;
  const mediaPipeline = createStubMediaPipeline();

  const pagePerception: IPagePerception = createPagePerception({
    getWebContents: (id) => viewManager.getWebContents(id),
    mediaPipeline,
    coordinator,
  });

  cachedDeps = {
    viewManager,
    createInput: (sink) => createHumanLikeInput({ sink }),
    pagePerception,
    mediaPipeline,
    coordinator,
    fillSecret: (request) => fillBrowserSecret(viewManager, request),
    quickTest: getQuickTestLifecycle(getWindow),
    // Editor capability (Super's Studio-editor plane): share ONE frame store
    // with the renderer bridge so a file the agent opens shows up as a frame.
    editorFrames: getEditorFrameStore(),
    editorIO: {
      read: async (filePath: string): Promise<string> => (await new NativeFileGateway().readText(filePath)) ?? '',
      write: async (filePath: string, content: string): Promise<void> => {
        await new NativeFileGateway().writeText(filePath, content);
      },
    },
  };
  return cachedDeps;
};

/**
 * Start the in-process Browser-Control MCP host bound to the shared browser
 * services.
 *
 * @param getWindow Main-window accessor (shared with the UI-plane browser bridge).
 * @returns The running host (url + port + close).
 */
export const startBrowserControl = (
  getWindow: () => BrowserWindow | null | undefined
): Promise<BrowserControlMcpHost> => startBrowserControlMcpHost(getBrowserControlDeps(getWindow));

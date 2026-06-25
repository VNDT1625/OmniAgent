/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
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
import { httpRequest } from '@/common/adapter/httpBridge';
import { getResourceCoordinator } from '../resource/resourceCoordinator';
import { getBrowserServices } from './browserBridge';
import { createHumanLikeInput } from './humanLikeInput';
import { createPagePerception, type IPagePerception } from './pagePerception';
import type { IMediaPipeline, MediaSource } from './mediaPipeline';
import type { BrowserControlDeps } from '../resources/builtinMcp/browserControlServer';
import { startBrowserControlMcpHost, type BrowserControlMcpHost } from './browserControlMcpHost';
import { getEditorFrameStore } from '../editor/editorFrameStore';

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
    // Editor capability (Super's Studio-editor plane): share ONE frame store
    // with the renderer bridge so a file the agent opens shows up as a frame.
    editorFrames: getEditorFrameStore(),
    editorIO: {
      read: async (filePath: string): Promise<string> => {
        const result = await httpRequest<string | null>('POST', '/api/fs/read', { path: filePath }).catch(
          (): string | null => null
        );
        return typeof result === 'string' ? result : '';
      },
      write: async (filePath: string, content: string): Promise<void> => {
        const ok = await httpRequest<boolean>('POST', '/api/fs/write', { path: filePath, data: content });
        if (!ok) throw new Error(`File could not be written: ${filePath}`);
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

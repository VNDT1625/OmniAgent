/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `quickTestService` — the **Agent plane** twin of the Quick Test surface.
 *
 * The UI Quick Test (`quickTestBridge` + `QuickTestPanel`) is interactive: the
 * user presses Start, drives the app by hand, presses Stop, and reads the
 * trace. An agent can't press buttons, so this service exposes the SAME engine
 * as a single one-shot call it can invoke as an MCP tool (`ide_quick_test`):
 *
 *   runSession({ platform, rootPath, target, durationMs })
 *     → start the right tracer (web = CDP on the focused tab; android/windows =
 *       native log stream)
 *     → observe for a bounded window, stopping early as soon as the first error
 *       appears (so a crashing app returns fast)
 *     → stop, map the trace to the repo's code graph, and return both
 *
 * It reuses the EXACT same tracer factories and {@link buildTraceContext} the UI
 * path uses, so the agent and the user get identical traces — there is no second
 * implementation to drift. Everything OS/Electron-touching is injected, so the
 * unit tests drive it with fakes.
 *
 * The agent is expected to exercise the app itself (navigate a page via the
 * browser-control tools, tap around an emulator, etc.) either before or during
 * the observation window; this service is the passive recorder + code mapper,
 * mirroring the "user tests, Omni watches" contract.
 *
 * Process boundary: Main-process (Node.js / Electron) module. No DOM APIs.
 */

import { createQuickTestTracer, type CdpWebContents, type RuntimeTrace, type TracePlatform } from './quickTestTracer';
import { createQuickTestNativeTracer, type NativeStreamOpener } from './quickTestNativeTracer';
import { buildTraceContext } from './traceContextBuilder';
import type { loadGraph } from './quickTestBridgeHelpers';
import type { ContextPack } from './understandTypes';

/** Default observation window (ms) when the caller does not specify one. */
const DEFAULT_DURATION_MS = 8000;
/** Hard cap on the observation window so an agent can never hang the host. */
const MAX_DURATION_MS = 60_000;
/** Poll interval (ms) while waiting for the first error / the deadline. */
const POLL_MS = 250;

/** Request for {@link QuickTestService.runSession}. */
export type QuickTestRunRequest = {
  /** Platform to observe. */
  platform: TracePlatform;
  /** Absolute repo root the trace is mapped against. */
  rootPath: string;
  /** Native target hint: android serial or Windows `.exe` path (ignored for web). */
  target?: string;
  /** Observation window in ms (clamped to {@link MAX_DURATION_MS}). */
  durationMs?: number;
};

/** Result of a one-shot Quick Test run. */
export type QuickTestRunResult = {
  /** The recorded runtime trace. */
  trace: RuntimeTrace;
  /** Context pack mapping the trace to suspected code files (null when no graph). */
  contextPack: ContextPack | null;
};

/** Injected collaborators for {@link createQuickTestService}. */
export type QuickTestServiceDeps = {
  /** Resolve the active browser WebContents for the web tracer (null when none). */
  getWebContents: () => CdpWebContents | null;
  /** Open a native log stream (android logcat / windows stdio). */
  openNativeStream: NativeStreamOpener;
  /** Load the persisted KG for a repo root (for trace→context mapping). */
  loadGraph: typeof loadGraph;
  /** Clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Sleep primitive. Defaults to a real `setTimeout` promise. */
  sleep?: (ms: number) => Promise<void>;
};

/** Public contract of the agent-facing Quick Test service. */
export type QuickTestService = {
  /** Run one bounded, observed Quick Test session and return the trace + context. */
  runSession: (req: QuickTestRunRequest) => Promise<QuickTestRunResult>;
};

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

/**
 * Create a {@link QuickTestService}. The returned `runSession` starts the right
 * tracer, observes for a bounded window (early-exiting on the first error), then
 * stops and maps the trace to the repo graph.
 */
export const createQuickTestService = (deps: QuickTestServiceDeps): QuickTestService => {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? defaultSleep;

  const runSession = async (req: QuickTestRunRequest): Promise<QuickTestRunResult> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath) throw new Error('A folder path is required.');
    const platform = req.platform;
    const duration = Math.min(Math.max(0, req.durationMs ?? DEFAULT_DURATION_MS), MAX_DURATION_MS);

    const tracer =
      platform === 'web'
        ? createQuickTestTracer({ getWebContents: deps.getWebContents, now })
        : createQuickTestNativeTracer({ openStream: deps.openNativeStream, now });

    const started =
      platform === 'web'
        ? await (tracer as ReturnType<typeof createQuickTestTracer>).start(rootPath)
        : await (tracer as ReturnType<typeof createQuickTestNativeTracer>).start(platform, rootPath, req.target ?? '');

    if (!started) {
      const reason =
        platform === 'web'
          ? 'No browser tab is open. Open the app in a browser tab first.'
          : platform === 'android'
            ? 'No Android device found. Boot an emulator/device (adb) first.'
            : 'Could not launch the app. Check the .exe path.';
      throw new Error(reason);
    }

    // Observe for the window, stopping early once a first error is recorded.
    // `hasError()` is an O(1) flag (both tracers expose it) — no buffer rescan.
    const deadline = now() + duration;
    while (now() < deadline) {
      // eslint-disable-next-line no-await-in-loop -- intentional sequential poll
      await sleep(POLL_MS);
      if (tracer.hasError()) break;
    }

    const trace = tracer.stop();
    let contextPack: ContextPack | null = null;
    if (trace.rootPath) {
      const graph = await deps.loadGraph(trace.rootPath).catch((): null => null);
      if (graph) contextPack = buildTraceContext(trace, graph);
    }
    return { trace, contextPack };
  };

  return { runSession };
};

export default createQuickTestService;

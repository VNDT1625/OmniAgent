/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Workspace IPC bridge — exposes the {@link IWorkspaceOrchestrator} to the
 * renderer Workspace page so a single chat turn can fan out into several
 * sub-agents, each on its own live surface (browser tab / editor file).
 *
 * Built with the same `@office-ai/platform` `bridge` helper as the sibling
 * `browserBridge` / `companyBridge`. Channels:
 *
 * - `workspace.run`     — start a run (list of surface specs). Long-lived: no
 *   timeout, progress observed via the emitter. Resolves with the final result.
 * - `workspace.cancel`  — cancel every surface of a run.
 * - `workspace.event`   — main → renderer push of per-surface lifecycle + tool
 *   narration (boxed in an envelope to keep the union non-distributive, the same
 *   pattern `browserBridge.agentEvent` uses).
 *
 * Browser surfaces are driven through the **same** {@link IBrowserViewManager}
 * the Browser page uses, so a workspace's tab is a real embedded tab the
 * renderer can position as an overlay frame. Editor surfaces read/write via the
 * fs HTTP API (`/api/fs/read` + `/api/fs/write`) — the same endpoints the
 * Universal Editor uses — so an edited file is what the Studio editor shows.
 *
 * The global bootstrap calls {@link registerWorkspaceBridge} once with the
 * main-window accessor; this module does not wire itself in.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import type { BrowserWindow } from 'electron';
import { httpRequest } from '@/common/adapter/httpBridge';
import { createBrowserViewManager, type IBrowserViewManager } from '@process/browser/browserViewManager';
import { createWebAgentRunner, type IWebAgentRunner } from '@process/browser/webAgentRunner';
import { createProviderChat } from '@process/browser/providerChat';
import { createHumanLikeInput } from '@process/browser/humanLikeInput';
import { getResourceCoordinator } from '@process/resource/resourceCoordinator';
import { createBrowserSurfaceRunner } from './browserSurfaceRunner';
import { createEditorAgentRunner } from './editorAgentRunner';
import { createWorkspaceOrchestrator, type IWorkspaceOrchestrator } from './workspaceOrchestrator';
import type { SurfaceKind, SurfaceSpec, WorkspaceEvent, WorkspaceRunResult } from './surfaceTypes';

// ---------------------------------------------------------------------------
// Channel names (renderer-safe contract)
// ---------------------------------------------------------------------------

/** IPC channel names for the workspace surface. Safe to import from the renderer. */
export const WORKSPACE_CHANNELS = {
  run: 'workspace.run',
  cancel: 'workspace.cancel',
  event: 'workspace.event',
} as const;

/** Request for {@link WORKSPACE_CHANNELS.run}. */
export type RunWorkspaceBridgeRequest = {
  /** Stable id for this run (renderer-generated). */
  runId: string;
  /** The sub-agent tasks to run concurrently. */
  surfaces: SurfaceSpec[];
};

/** Request addressing a run by id (cancel). */
export type WorkspaceRunIdRequest = {
  /** Stable id of the run to cancel. */
  runId: string;
};

/**
 * Envelope wrapping a streamed {@link WorkspaceEvent}. Boxing the union keeps the
 * platform `buildEmitter<Params>` conditional non-distributive (same reason as
 * `browserBridge.AgentEventEnvelope`).
 */
export type WorkspaceEventEnvelope = {
  /** The streamed per-surface lifecycle / narration event. */
  event: WorkspaceEvent;
};

/** Typed workspace channels. Exported for bootstrap registration wiring. */
export const workspaceChannels = {
  run: bridge.buildProvider<WorkspaceRunResult, RunWorkspaceBridgeRequest>(WORKSPACE_CHANNELS.run),
  cancel: bridge.buildProvider<void, WorkspaceRunIdRequest>(WORKSPACE_CHANNELS.cancel),
  event: bridge.buildEmitter<WorkspaceEventEnvelope>(WORKSPACE_CHANNELS.event),
};

// ---------------------------------------------------------------------------
// Shared services
// ---------------------------------------------------------------------------

/** Editor file IO backed by the aioncore fs HTTP API (Main-process side). */
const createHttpEditorIO = () => ({
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
});

/** The Main-process services the workspace bridge operates on. */
export type WorkspaceServices = {
  /** The orchestrator that runs surfaces concurrently. */
  orchestrator: IWorkspaceOrchestrator;
  /** The browser view manager backing browser surfaces (shared source of truth). */
  viewManager: IBrowserViewManager;
};

/** Lazily-built default services, shared across repeated registrations. */
let defaultServices: WorkspaceServices | undefined;

/**
 * Resolve the shared {@link WorkspaceServices}, constructing the production
 * implementation on first use: a browser view manager + web-agent runner for
 * browser surfaces, a provider-backed editor runner for editor surfaces, and the
 * orchestrator gating both via the ResourceCoordinator.
 *
 * @param getWindow Accessor returning the main window for browser-surface tabs.
 */
export const getWorkspaceServices = (getWindow: () => BrowserWindow | null | undefined): WorkspaceServices => {
  if (defaultServices) return defaultServices;

  const viewManager = createBrowserViewManager({ getWindow });

  // A light page-text reader (perception layer a — no lease) on a tab's
  // WebContents, mirroring browserBridge.getBrowserServices.
  const readText = async (tabId: string, selector?: string): Promise<string> => {
    const contents = viewManager.getWebContents(tabId);
    if (!contents) return '';
    const selectorLiteral = selector === undefined ? 'null' : JSON.stringify(selector);
    const script = `(() => {
      const sel = ${selectorLiteral};
      const el = sel ? document.querySelector(sel) : document.body;
      if (!el) return '';
      const text = el.innerText != null ? el.innerText : el.textContent;
      return text ? String(text).trim() : '';
    })()`;
    const result: unknown = await contents.executeJavaScript(script);
    return typeof result === 'string' ? result : '';
  };

  // A leased screenshot capture (perception layer b) — acquires a 'browser'
  // lease before the heavy capturePage and releases it in finally (criterion 1.9).
  const capture = async (tabId: string): Promise<string> => {
    const contents = viewManager.getWebContents(tabId);
    if (!contents) return '';
    const coordinator = getResourceCoordinator();
    const lease = await coordinator.requestLease({ kind: 'browser', estCostMB: 256 });
    try {
      const image = await contents.capturePage();
      if (image.isEmpty()) return '';
      return image.toDataURL();
    } finally {
      coordinator.releaseLease(lease.id);
    }
  };

  const chat = createProviderChat();
  const agentRunner: IWebAgentRunner = createWebAgentRunner({
    viewManager,
    readText,
    capture,
    createInput: (sink) => createHumanLikeInput({ sink }),
    chat,
  });

  const runners: Record<SurfaceKind, ReturnType<typeof createEditorAgentRunner>> = {
    browser: createBrowserSurfaceRunner({ viewManager, agentRunner }),
    editor: createEditorAgentRunner({ chat, io: createHttpEditorIO() }),
  };

  const orchestrator = createWorkspaceOrchestrator({ runners });
  defaultServices = { orchestrator, viewManager };
  return defaultServices;
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/** Options for {@link registerWorkspaceBridge}. */
export type RegisterWorkspaceBridgeOptions = {
  /** Override the shared services entirely (tests / advanced bootstrap). */
  services?: WorkspaceServices;
  /**
   * Main-window accessor for the lazily-built default services. Supplied by the
   * global bootstrap, which owns window creation.
   */
  getWindow?: () => BrowserWindow | null | undefined;
};

/** Resolve the {@link WorkspaceServices} to wire. */
const resolveServices = (options: RegisterWorkspaceBridgeOptions): WorkspaceServices => {
  if (options.services) return options.services;
  if (options.getWindow) return getWorkspaceServices(options.getWindow);
  throw new Error('[WorkspaceBridge] registerWorkspaceBridge requires one of: services or getWindow.');
};

/**
 * Register the workspace IPC handlers. Idempotent (re-registration replaces the
 * bound handlers). Intended to be invoked once during Main-process bootstrap.
 *
 * @param options Injected services and/or the main-window accessor.
 */
export function registerWorkspaceBridge(options: RegisterWorkspaceBridgeOptions = {}): void {
  const services = resolveServices(options);

  // Start a run. Long-lived: each surface streams progress through the emitter;
  // the resolved value is the final per-surface state.
  workspaceChannels.run.provider((request) =>
    services.orchestrator.run(request, (event) => {
      workspaceChannels.event.emit({ event });
    })
  );

  // Cancel every surface of a run (best-effort, cooperative).
  workspaceChannels.cancel.provider(({ runId }) => {
    services.orchestrator.cancel(runId);
    return Promise.resolve();
  });
}

/** Reset the lazily-built default services (deterministic teardown for tests). */
export function disposeWorkspaceBridge(): void {
  defaultServices?.viewManager.dispose();
  defaultServices = undefined;
}

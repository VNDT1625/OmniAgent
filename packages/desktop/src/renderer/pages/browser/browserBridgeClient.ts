/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-safe client for the browser IPC surface (Requirement 1, criteria
 * 1.1 and 1.2; Task 6.9).
 *
 * The Main-process bridge module (`process/browser/browserBridge.ts`) imports
 * Electron (`WebContentsView`, `BrowserWindow`), so it must NOT be imported into
 * the renderer at runtime. Instead this module mirrors the sibling
 * `companyBridgeClient.ts` approach:
 *
 * - it re-declares the channel-name strings (the renderer-safe contract — kept
 *   in sync with `BROWSER_CHANNELS` in the bridge), and
 * - rebuilds matching `bridge.buildProvider(...)` invokers from those names,
 *   exactly the way `ipcBridge.ts` declares the Electron-native `resource`
 *   namespace.
 *
 * Only **types** are borrowed from the Main-process modules via `import type`,
 * which is erased at compile time and therefore safe across the process
 * boundary.
 *
 * ## Graceful "not wired yet" handling
 *
 * The browser bridge is registered during Main-process bootstrap (Task 15.1).
 * Until then no provider answers these channels, and the platform bridge leaves
 * `invoke` pending forever. To keep the UI responsive against a missing backend,
 * every call here is wrapped with {@link invokeWithTimeout}, which rejects after
 * a short delay so the page can fall back to a friendly empty/error state.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { bridge } from '@office-ai/platform';
import type {
  AgentModeState,
  BrowserTabIdRequest,
  NavigateRequest,
  OpenTabRequest,
  OpenTabResult,
  RunAgentBridgeRequest,
  RunAgentBridgeResult,
  SetAgentModeRequest,
  SetBoundsRequest,
  SetZoomRequest,
  SetVisibleRequest,
  AgentEventEnvelope,
} from '@process/browser/browserBridge';
import type { AgentEvent } from '@process/browser/webAgentRunner';
import type { BrowserTabInfo, TabUpdate } from '@process/browser/browserViewManager';
import { BRIDGE_BOUNDS_TIMEOUT_MS, BRIDGE_TIMEOUT_MS } from './constants';

/**
 * Browser IPC channel names. These mirror `BROWSER_CHANNELS` exported from the
 * Main-process `browserBridge.ts`; they are duplicated here (rather than
 * imported) so the renderer never loads the Node-only bridge module.
 */
const BROWSER_CHANNELS = {
  openTab: 'browser.open-tab',
  navigate: 'browser.navigate',
  goBack: 'browser.go-back',
  goForward: 'browser.go-forward',
  setBounds: 'browser.set-bounds',
  setZoom: 'browser.set-zoom',
  show: 'browser.show',
  setVisible: 'browser.set-visible',
  hide: 'browser.hide',
  hideAll: 'browser.hide-all',
  listTabs: 'browser.list-tabs',
  destroyTab: 'browser.destroy-tab',
  getAgentMode: 'browser.get-agent-mode',
  setAgentMode: 'browser.set-agent-mode',
  runAgent: 'browser.run-agent',
  cancelAgent: 'browser.cancel-agent',
  agentEvent: 'browser.agent-event',
  tabUpdated: 'browser.tab-updated',
  getPersona: 'browser.get-persona',
  setPersona: 'browser.set-persona',
} as const;

/** Raw typed invokers — each `.invoke(req)` round-trips to the Main process. */
const channels = {
  openTab: bridge.buildProvider<OpenTabResult, OpenTabRequest>(BROWSER_CHANNELS.openTab),
  navigate: bridge.buildProvider<void, NavigateRequest>(BROWSER_CHANNELS.navigate),
  goBack: bridge.buildProvider<{ navigated: boolean }, BrowserTabIdRequest>(BROWSER_CHANNELS.goBack),
  goForward: bridge.buildProvider<{ navigated: boolean }, BrowserTabIdRequest>(BROWSER_CHANNELS.goForward),
  setBounds: bridge.buildProvider<void, SetBoundsRequest>(BROWSER_CHANNELS.setBounds),
  setZoom: bridge.buildProvider<void, SetZoomRequest>(BROWSER_CHANNELS.setZoom),
  show: bridge.buildProvider<void, BrowserTabIdRequest>(BROWSER_CHANNELS.show),
  setVisible: bridge.buildProvider<void, SetVisibleRequest>(BROWSER_CHANNELS.setVisible),
  hide: bridge.buildProvider<void, BrowserTabIdRequest>(BROWSER_CHANNELS.hide),
  hideAll: bridge.buildProvider<void, void>(BROWSER_CHANNELS.hideAll),
  listTabs: bridge.buildProvider<BrowserTabInfo[], void>(BROWSER_CHANNELS.listTabs),
  destroyTab: bridge.buildProvider<void, BrowserTabIdRequest>(BROWSER_CHANNELS.destroyTab),
  getAgentMode: bridge.buildProvider<AgentModeState, BrowserTabIdRequest>(BROWSER_CHANNELS.getAgentMode),
  setAgentMode: bridge.buildProvider<AgentModeState, SetAgentModeRequest>(BROWSER_CHANNELS.setAgentMode),
  runAgent: bridge.buildProvider<RunAgentBridgeResult, RunAgentBridgeRequest>(BROWSER_CHANNELS.runAgent),
  cancelAgent: bridge.buildProvider<void, BrowserTabIdRequest>(BROWSER_CHANNELS.cancelAgent),
  agentEvent: bridge.buildEmitter<AgentEventEnvelope>(BROWSER_CHANNELS.agentEvent),
  tabUpdated: bridge.buildEmitter<TabUpdate>(BROWSER_CHANNELS.tabUpdated),
  getPersona: bridge.buildProvider<string, void>(BROWSER_CHANNELS.getPersona),
  setPersona: bridge.buildProvider<void, { persona: string }>(BROWSER_CHANNELS.setPersona),
};

/** Error thrown when a browser IPC call does not reply within its budget. */
export class BrowserBridgeTimeoutError extends Error {
  constructor(channel: string) {
    super(`[BrowserBridgeClient] No reply on "${channel}" — the browser bridge may not be wired yet.`);
    this.name = 'BrowserBridgeTimeoutError';
  }
}

/**
 * Race an `invoke` against a timeout so an unregistered channel rejects instead
 * of hanging forever. The pending `invoke` promise is abandoned on timeout (the
 * platform bridge has no cancel), which is harmless for these idempotent reads
 * and toggles.
 */
const invokeWithTimeout = <T>(channel: string, call: () => Promise<T>, timeoutMs: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new BrowserBridgeTimeoutError(channel));
    }, timeoutMs);
    call().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });

/**
 * Timeout-guarded browser invokers for the renderer. Each method resolves with
 * the Main-process result or rejects (timeout / handler error) so the UI can
 * fall back to a friendly state.
 */
export const browserClient = {
  openTab: (request: OpenTabRequest = {}): Promise<OpenTabResult> =>
    invokeWithTimeout(BROWSER_CHANNELS.openTab, () => channels.openTab.invoke(request), BRIDGE_TIMEOUT_MS),
  navigate: (request: NavigateRequest): Promise<void> =>
    invokeWithTimeout(BROWSER_CHANNELS.navigate, () => channels.navigate.invoke(request), BRIDGE_TIMEOUT_MS),
  goBack: (request: BrowserTabIdRequest): Promise<{ navigated: boolean }> =>
    invokeWithTimeout(BROWSER_CHANNELS.goBack, () => channels.goBack.invoke(request), BRIDGE_TIMEOUT_MS),
  goForward: (request: BrowserTabIdRequest): Promise<{ navigated: boolean }> =>
    invokeWithTimeout(BROWSER_CHANNELS.goForward, () => channels.goForward.invoke(request), BRIDGE_TIMEOUT_MS),
  setBounds: (request: SetBoundsRequest): Promise<void> =>
    invokeWithTimeout(BROWSER_CHANNELS.setBounds, () => channels.setBounds.invoke(request), BRIDGE_BOUNDS_TIMEOUT_MS),
  setZoom: (request: SetZoomRequest): Promise<void> =>
    invokeWithTimeout(BROWSER_CHANNELS.setZoom, () => channels.setZoom.invoke(request), BRIDGE_TIMEOUT_MS),
  show: (request: BrowserTabIdRequest): Promise<void> =>
    invokeWithTimeout(BROWSER_CHANNELS.show, () => channels.show.invoke(request), BRIDGE_TIMEOUT_MS),
  /** Show/hide ONE tab without affecting others (multi-frame watch grid). */
  setVisible: (request: SetVisibleRequest): Promise<void> =>
    invokeWithTimeout(BROWSER_CHANNELS.setVisible, () => channels.setVisible.invoke(request), BRIDGE_TIMEOUT_MS),
  hide: (request: BrowserTabIdRequest): Promise<void> =>
    invokeWithTimeout(BROWSER_CHANNELS.hide, () => channels.hide.invoke(request), BRIDGE_TIMEOUT_MS),
  hideAll: (): Promise<void> =>
    invokeWithTimeout(BROWSER_CHANNELS.hideAll, () => channels.hideAll.invoke(), BRIDGE_TIMEOUT_MS),
  listTabs: (): Promise<BrowserTabInfo[]> =>
    invokeWithTimeout(BROWSER_CHANNELS.listTabs, () => channels.listTabs.invoke(), BRIDGE_TIMEOUT_MS),
  destroyTab: (request: BrowserTabIdRequest): Promise<void> =>
    invokeWithTimeout(BROWSER_CHANNELS.destroyTab, () => channels.destroyTab.invoke(request), BRIDGE_TIMEOUT_MS),
  getAgentMode: (request: BrowserTabIdRequest): Promise<AgentModeState> =>
    invokeWithTimeout(BROWSER_CHANNELS.getAgentMode, () => channels.getAgentMode.invoke(request), BRIDGE_TIMEOUT_MS),
  setAgentMode: (request: SetAgentModeRequest): Promise<AgentModeState> =>
    invokeWithTimeout(BROWSER_CHANNELS.setAgentMode, () => channels.setAgentMode.invoke(request), BRIDGE_TIMEOUT_MS),
  /**
   * Run one web-agent turn. No timeout wrapper: an agent turn legitimately runs
   * for many seconds (multiple model + page steps), and progress is observable
   * via {@link onAgentEvent}. Rejects on bridge/handler error.
   */
  runAgent: (request: RunAgentBridgeRequest): Promise<RunAgentBridgeResult> => channels.runAgent.invoke(request),
  /** Cancel the in-flight agent turn for a tab (best-effort). */
  cancelAgent: (request: BrowserTabIdRequest): Promise<void> =>
    invokeWithTimeout(BROWSER_CHANNELS.cancelAgent, () => channels.cancelAgent.invoke(request), BRIDGE_TIMEOUT_MS),
  /** Subscribe to live agent step events (main → renderer). Returns an unsubscribe fn. */
  onAgentEvent: (listener: (event: AgentEvent) => void): (() => void) =>
    channels.agentEvent.on((envelope) => listener(envelope.event)),
  /**
   * Subscribe to live tab URL/title changes (main → renderer), including in-page
   * SPA navigations like switching YouTube videos. Returns an unsubscribe fn.
   */
  onTabUpdated: (listener: (update: TabUpdate) => void): (() => void) => channels.tabUpdated.on(listener),
  /** Read the agent persona / standing instructions (empty when unset). */
  getPersona: (): Promise<string> =>
    invokeWithTimeout(BROWSER_CHANNELS.getPersona, () => channels.getPersona.invoke(), BRIDGE_TIMEOUT_MS),
  /** Replace the agent persona / standing instructions. */
  setPersona: (persona: string): Promise<void> =>
    invokeWithTimeout(BROWSER_CHANNELS.setPersona, () => channels.setPersona.invoke({ persona }), BRIDGE_TIMEOUT_MS),
};

/** Re-exported tab info type for convenience in the page module. */
export type { BrowserTabInfo, TabUpdate };
/** Re-exported agent event/result types for the chat panel. */
export type { AgentEvent, RunAgentBridgeResult };

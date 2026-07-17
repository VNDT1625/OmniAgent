/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Browser IPC bridge — exposes the Main-process embedded-browser services to the
 * renderer Browser UI (Requirement 1, criteria 1.1 and 1.2; Task 6.5).
 *
 * This is an Electron-native bridge (not an aioncore HTTP route), built with the
 * same `@office-ai/platform` `bridge` helper that backs `ipcBridge.ts` and the
 * sibling `companyBridge` / `resourceBridge`. Because `ipcBridge.ts` does not
 * (yet) carry a `browser` namespace and this task must not modify it, the typed
 * channels are declared **here** and exported so the renderer (future Browser
 * page) and the global bootstrap (Task 15.1) can reach them. The channel name
 * constants ({@link BROWSER_CHANNELS}) are the renderer-safe contract — the
 * renderer can build matching `bridge.buildProvider(...).invoke` handles from
 * those names without importing this Node-only module.
 *
 * ## Same service as the Agent plane
 *
 * The design's "hai mặt phẳng" principle (`design.md`, Yêu cầu 1) requires the
 * UI plane (this bridge) and the Agent plane (Browser-Control MCP, Task 6.6) to
 * drive the **same** {@link IBrowserViewManager}. The manager is the single
 * source of truth for browser tabs, so a tab opened by the user via this bridge
 * is the same tab the web agent later controls. This bridge owns only the UI
 * surface: open / navigate / position / show-hide / list / destroy a tab, plus
 * the per-tab **agent-mode** toggle (criterion 1.2) that marks a tab as a
 * controllable web agent.
 *
 * ## Agent mode (criterion 1.2)
 *
 * Turning a tab into a "web agent" — letting a chosen model drive clicks /
 * scrolls / typing — is wired by the Browser-Control MCP (Task 6.6). For Task
 * 6.5 the bridge only tracks a simple per-tab boolean flag in its shared
 * {@link BrowserServices} and exposes get/set for it, so the UI can render and
 * toggle the mode. The actual control loop reads this flag later.
 *
 * The global bootstrap (Task 15.1) is responsible for calling
 * {@link registerBrowserBridge} once during Main-process startup and supplying
 * the real main-window accessor; this module does not wire itself in (mirrors
 * `resourceBridge.ts` / `companyBridge.ts`).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import type { BrowserWindow } from 'electron';
import { session } from 'electron';
import { createBrowserViewManager } from './browserViewManager';
import type {
  BrowserTabId,
  BrowserTabInfo,
  CreateTabOptions,
  IBrowserViewManager,
  TabBounds,
  TabUpdate,
} from './browserViewManager';
import type { AgentEvent, AgentHistoryMessage, IWebAgentRunner } from './webAgentRunner';
import { createWebAgentRunner } from './webAgentRunner';
import { createProviderChat } from './providerChat';
import { withCliAgent } from '@process/services/agentChat/cliAgentChat';
import { createHumanLikeInput } from './humanLikeInput';
import { getResourceCoordinator } from '@process/resource/resourceCoordinator';
import { createBrowserMemory, type IBrowserMemory } from './browserMemory';
import { createSummarizer } from './research/summarizer';
import { createDeepResearch, type SearchHit } from './research/deepResearch';
import { extractReadable } from './research/readability';
import { createYoutubeTranscript } from './research/youtubeTranscript';
import { createContentExtractService } from '@process/services/contentExtract';
import { createYtDlpTranscript, writeYoutubeCookieFile } from '@process/services/contentExtract';

// ---------------------------------------------------------------------------
// Channel names (renderer-safe contract — the Browser UI builds invokers here)
// ---------------------------------------------------------------------------

/** IPC channel names for the browser surface. Safe to import from the renderer. */
export const BROWSER_CHANNELS = {
  openTab: 'browser.open-tab',
  navigate: 'browser.navigate',
  goBack: 'browser.go-back',
  goForward: 'browser.go-forward',

  reload: 'browser.reload',
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

// ---------------------------------------------------------------------------
// Request / response payloads
// ---------------------------------------------------------------------------

/**
 * Request for {@link BROWSER_CHANNELS.openTab}. Mirrors the view manager's
 * {@link CreateTabOptions} so the renderer can request an initial URL, bounds and
 * visibility in one call.
 */
export type OpenTabRequest = CreateTabOptions;

/** Result of {@link BROWSER_CHANNELS.openTab}: the stable id of the new tab. */
export type OpenTabResult = {
  /** Stable identifier of the freshly created tab. */
  id: BrowserTabId;
};

/** Request addressing a single tab by id (show / hide / destroy / get agent-mode). */
export type BrowserTabIdRequest = {
  /** Stable identifier of the target tab. */
  id: BrowserTabId;
};

/** Request for {@link BROWSER_CHANNELS.navigate}. */
export type NavigateRequest = {
  /** Stable identifier of the tab to navigate. */
  id: BrowserTabId;
  /** Absolute URL to load in the tab (criterion 1.1). */
  url: string;
};

/** Request for {@link BROWSER_CHANNELS.setBounds}. */
export type SetBoundsRequest = {
  /** Stable identifier of the tab to reposition/resize. */
  id: BrowserTabId;
  /** New on-screen rectangle, in the main window's content coordinates. */
  bounds: TabBounds;
};

/** Request for {@link BROWSER_CHANNELS.setZoom}. */
export type SetZoomRequest = {
  /** Stable identifier of the tab to zoom. */
  id: BrowserTabId;
  /** Zoom factor (1 = 100%). Clamped to [0.25, 5] by the manager. */
  factor: number;
};

/** Request for {@link BROWSER_CHANNELS.setVisible}: non-exclusive visibility. */
export type SetVisibleRequest = {
  /** Stable identifier of the tab to show/hide. */
  id: BrowserTabId;
  /** Whether the tab's view should paint. Other tabs are unaffected. */
  visible: boolean;
};

/** Request for {@link BROWSER_CHANNELS.runAgent}: run one web-agent turn on a tab. */
export type RunAgentBridgeRequest = {
  /** Tab the agent operates on. */
  id: BrowserTabId;
  /** Model id the user picked to drive the agent (criterion 1.2). */
  model: string;
  /** The user instruction for this turn. */
  instruction: string;
  /** Prior chat turns for context (most-recent last). */
  history?: AgentHistoryMessage[];
  /**
   * Whether the user granted the agent control of the VISIBLE tab this turn
   * (scroll/click/type/navigate…). Defaults to `false` — invisible mode.
   */
  interactive?: boolean;
};

/** Result of {@link BROWSER_CHANNELS.runAgent}. */
export type RunAgentBridgeResult = {
  /** The final assistant answer (empty when stopped/errored). */
  answer: string;
  /** How the turn ended. */
  status: 'done' | 'stopped' | 'error' | 'max-steps';
  /** Number of tool steps executed. */
  steps: number;
};

/**
 * Envelope wrapping a streamed {@link AgentEvent} for the `agentEvent` emitter.
 *
 * The platform `buildEmitter<Params>` types `emit` as a conditional over the
 * naked `Params`; passing a discriminated union directly makes that conditional
 * distribute and collapse the `emit` parameter to `never`. Boxing the union in a
 * single-property object keeps `Params` non-distributive so `emit`/`on` type
 * correctly.
 */
export type AgentEventEnvelope = {
  /** The streamed agent step/result event. */
  event: AgentEvent;
};

/** Request for {@link BROWSER_CHANNELS.setAgentMode}. */
export type SetAgentModeRequest = {
  /** Stable identifier of the tab to toggle. */
  id: BrowserTabId;
  /** `true` to turn the tab into a controllable web agent, `false` to turn it off (criterion 1.2). */
  enabled: boolean;
};

/** Current agent-mode state of a tab, returned by get/set agent-mode. */
export type AgentModeState = {
  /** Stable identifier of the tab. */
  id: BrowserTabId;
  /** Whether agent mode is currently on for this tab. */
  enabled: boolean;
};

// ---------------------------------------------------------------------------
// Typed channels (declared here because ipcBridge.ts has no browser namespace)
// ---------------------------------------------------------------------------

/** Typed browser IPC channels. Exported for Task 15.1 registration wiring. */
export const browserChannels = {
  openTab: bridge.buildProvider<OpenTabResult, OpenTabRequest>(BROWSER_CHANNELS.openTab),
  navigate: bridge.buildProvider<void, NavigateRequest>(BROWSER_CHANNELS.navigate),
  goBack: bridge.buildProvider<{ navigated: boolean }, BrowserTabIdRequest>(BROWSER_CHANNELS.goBack),
  goForward: bridge.buildProvider<{ navigated: boolean }, BrowserTabIdRequest>(BROWSER_CHANNELS.goForward),

  reload: bridge.buildProvider<void, BrowserTabIdRequest>(BROWSER_CHANNELS.reload),
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
  /** Main → renderer push of live agent steps (criterion 1.2 narration). */
  agentEvent: bridge.buildEmitter<AgentEventEnvelope>(BROWSER_CHANNELS.agentEvent),
  /** Main → renderer push of a tab's live URL/title change (incl. SPA navigation). */
  tabUpdated: bridge.buildEmitter<TabUpdate>(BROWSER_CHANNELS.tabUpdated),
  getPersona: bridge.buildProvider<string, void>(BROWSER_CHANNELS.getPersona),
  setPersona: bridge.buildProvider<void, { persona: string }>(BROWSER_CHANNELS.setPersona),
};

// ---------------------------------------------------------------------------
// Shared browser services (one instance for the whole Main process)
// ---------------------------------------------------------------------------

/**
 * The Main-process browser services the bridge operates on. Kept small and
 * injectable so tests (and Task 15.1) can supply alternatives; production uses
 * the lazily-constructed defaults from {@link getBrowserServices}.
 */
export type BrowserServices = {
  /** The single source of truth for browser tabs (shared with the Agent plane). */
  viewManager: IBrowserViewManager;
  /** Read whether agent mode is currently on for a tab (defaults to `false`). */
  isAgentMode: (id: BrowserTabId) => boolean;
  /** Turn agent mode on/off for a tab (criterion 1.2). */
  setAgentMode: (id: BrowserTabId, enabled: boolean) => void;
  /** Forget a tab's agent-mode flag (called when the tab is destroyed). */
  clearAgentMode: (id: BrowserTabId) => void;
  /**
   * The web-agent runner that drives a tab from a chat instruction (criterion
   * 1.2). Optional so tests / partial bootstraps can omit it; when absent the
   * `runAgent` channel rejects with a clear "agent not available" error.
   */
  agentRunner?: IWebAgentRunner;
  /**
   * Personal-agent memory (persona + per-site notes). Optional; when present the
   * persona get/set channels read/write it and the runner uses it for context.
   */
  memory?: IBrowserMemory;
};

/**
 * Build the in-memory per-tab agent-mode flag store. A tab is "on" only while an
 * explicit `true` is set; clearing/turning off removes the entry so the map does
 * not leak ids for destroyed tabs.
 */
const createAgentModeStore = (): Pick<BrowserServices, 'isAgentMode' | 'setAgentMode' | 'clearAgentMode'> => {
  const modes = new Map<BrowserTabId, boolean>();
  return {
    isAgentMode: (id) => modes.get(id) === true,
    setAgentMode: (id, enabled) => {
      if (enabled) modes.set(id, true);
      else modes.delete(id);
    },
    clearAgentMode: (id) => {
      modes.delete(id);
    },
  };
};

/** Lazily-built default services, shared across repeated registrations. */
let defaultServices: BrowserServices | undefined;

/**
 * Resolve the shared {@link BrowserServices}, constructing the default
 * implementation (a real {@link IBrowserViewManager} plus a fresh agent-mode
 * store) on first use.
 *
 * The default view manager needs a main-window accessor, which is owned by the
 * bootstrap/window-creation code (Task 15.1) rather than imported here — so it
 * is passed in via `getWindow`.
 *
 * @param getWindow Accessor returning the main window to attach tab views to.
 */
export const getBrowserServices = (getWindow: () => BrowserWindow | null | undefined): BrowserServices => {
  if (defaultServices) return defaultServices;
  const viewManager = createBrowserViewManager({
    getWindow,
    // Push live URL/title changes (including in-page SPA navigation) to the
    // renderer so the address bar tracks the page without polling.
    onTabUpdate: (update) => browserChannels.tabUpdated.emit(update),
  });
  const sharedMemory = createBrowserMemory();

  // A light page-text reader (perception layer a — no lease) built directly on
  // the tab's WebContents, so the agent runner does not depend on the
  // not-yet-implemented media pipeline. The snippet runs *in the page*.
  const readText = async (tabId: BrowserTabId, selector?: string): Promise<string> => {
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

  // A leased screenshot capture (perception layer b — medium). Acquires a
  // 'browser' lease via the ResourceCoordinator before the heavy capturePage()
  // and releases it in a finally (criterion 1.9). Returns a PNG data-URL the
  // vision step feeds to the model; empty string when the capture is empty.
  const capture = async (tabId: BrowserTabId): Promise<string> => {
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

  // Extract the MAIN readable article body of a tab (readability), used by the
  // `summarize` tool so nav/ads/footers never pollute the summary.
  const readMainContent = async (tabId: BrowserTabId): Promise<{ title: string; text: string }> => {
    const contents = viewManager.getWebContents(tabId);
    if (!contents) return { title: '', text: '' };
    const content = await extractReadable(contents);
    return { title: content.title, text: content.text };
  };

  // Wrap the provider-backed chat so a `cli:<agentId>` model id drives a CLI
  // agent (Claude Code, Codex, Gemini CLI…) instead of an API-key provider —
  // letting the web agent run on an OAuth/subscription CLI. Normal model ids
  // delegate to the provider chat unchanged.
  const chat = withCliAgent(createProviderChat(), undefined, { surface: 'browser', permissionMode: 'read-only' });

  // Map-reduce summariser over the same provider chat — long pages/transcripts
  // are summarised in full instead of being truncated at 4000 chars. A large
  // chunk window means a typical video transcript is ONE model call (Comet-fast),
  // only falling back to map-reduce for very long sources.
  const summarizer = createSummarizer({ chat, chunkChars: 48000 });

  // Server-side YouTube transcript fetcher (Main-process HTTP, anonymous clean
  // session — the Comet/yt-dlp approach). Fast + reliable primary path for
  // video_transcript: no tab to open, not gated by the logged-in PO-token wall.
  const youtubeTranscript = createYoutubeTranscript();

  // Tiered transcript pipeline (Requirement: more reliable YouTube transcripts).
  // yt-dlp (primary — gold-standard, residential IP) → the anonymous in-app
  // fetcher above (fallback). Centralised in the shared content-extract service
  // so Browser, Manager, Studio… all share the same extraction quality.
  //
  // The yt-dlp primary is built HERE (not via the service default) so it can
  // authenticate with the embedded browser's REAL YouTube session: we export
  // the user's youtube.com/google.com cookies into yt-dlp's per-fetch temp dir
  // and pass them with `--cookies`. A signed-in request is the most reliable way
  // past YouTube's anonymous HTTP 429 wall (instead of waiting for it to cool
  // down) and also clears the PO-token caption gate. Best-effort: if the user is
  // not signed in, the exporter returns null and yt-dlp just runs anonymously.
  const ytDlp = createYtDlpTranscript({
    getCookieFile: (dir) => writeYoutubeCookieFile(session.defaultSession.cookies, dir),
  });
  const contentExtract = createContentExtractService({ ytDlp, ytFallback: youtubeTranscript });

  // In-page snippet that scrapes organic result links from a Google results page.
  const SERP_LINKS_SCRIPT = `(() => {
    try {
      var out = [];
      var seen = {};
      var anchors = document.querySelectorAll('a[href]');
      for (var i = 0; i < anchors.length; i++) {
        var a = anchors[i];
        var href = a.href || '';
        // Keep only external http(s) results; drop Google's own chrome/links.
        if (!/^https?:\\/\\//.test(href)) continue;
        if (/google\\.|gstatic\\.|googleusercontent\\.|youtube\\.com\\/redirect|\\/search\\?|webcache\\./.test(href)) continue;
        var h3 = a.querySelector ? a.querySelector('h3') : null;
        var title = h3 ? (h3.innerText || h3.textContent || '') : (a.innerText || a.textContent || '');
        title = (title || '').replace(/\\s+/g, ' ').trim();
        if (!title) continue;
        if (seen[href]) continue;
        seen[href] = true;
        out.push({ url: href, title: title });
        if (out.length >= 20) break;
      }
      return out;
    } catch (e) { return []; }
  })()`;

  // Hidden-tab browser surface for deep research: search + read main content,
  // always off-screen so the user's visible tab is never disturbed.
  const researchBrowser = {
    search: async (query: string, limit: number): Promise<SearchHit[]> => {
      let hiddenId: BrowserTabId | undefined;
      try {
        hiddenId = viewManager.createTab({ visible: false });
        await viewManager.loadURL(hiddenId, `https://www.google.com/search?q=${encodeURIComponent(query)}`);
        await new Promise((resolve) => setTimeout(resolve, 1200));
        const contents = viewManager.getWebContents(hiddenId);
        if (!contents) return [];
        const raw: unknown = await contents.executeJavaScript(SERP_LINKS_SCRIPT);
        const hits = Array.isArray(raw)
          ? raw
              .filter(
                (h): h is { url: string; title: string } =>
                  Boolean(h) && typeof (h as { url?: unknown }).url === 'string'
              )
              .map((h) => ({ url: h.url, title: typeof h.title === 'string' ? h.title : '' }))
          : [];
        return hits.slice(0, Math.max(1, limit));
      } catch {
        return [];
      } finally {
        if (hiddenId) viewManager.destroyTab(hiddenId);
      }
    },
    readSource: async (url: string): Promise<{ title: string; text: string }> => {
      let hiddenId: BrowserTabId | undefined;
      try {
        hiddenId = viewManager.createTab({ visible: false });
        await viewManager.loadURL(hiddenId, url);
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const contents = viewManager.getWebContents(hiddenId);
        if (!contents) return { title: '', text: '' };
        const content = await extractReadable(contents);
        return { title: content.title, text: content.text };
      } catch {
        return { title: '', text: '' };
      } finally {
        if (hiddenId) viewManager.destroyTab(hiddenId);
      }
    },
  };

  // Deep, multi-source research: plan → fan-out searches/reads in hidden tabs
  // (gated by the ResourceCoordinator) → synthesise a cited answer.
  const deepResearch = createDeepResearch({
    browser: researchBrowser,
    chat,
    coordinator: getResourceCoordinator(),
  });

  const agentRunner = createWebAgentRunner({
    viewManager,
    readText,
    capture,
    createInput: (sink) => createHumanLikeInput({ sink }),
    chat,
    memory: sharedMemory,
    summarizer,
    deepResearch,
    readMainContent,
    fetchTranscript: (urlOrId) => contentExtract.extract({ kind: 'youtube', urlOrId }),
  });

  defaultServices = {
    viewManager,
    ...createAgentModeStore(),
    agentRunner,
    memory: sharedMemory,
  };
  return defaultServices;
};

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/**
 * Options for {@link registerBrowserBridge}. Exactly one source of the browser
 * view manager must be resolvable:
 *
 * - `services` — fully pre-built services (tests / advanced bootstrap), or
 * - `viewManager` — an injected manager the bridge wraps with a fresh
 *   agent-mode store, or
 * - `getWindow` — a main-window accessor used to lazily build the default
 *   services (this is what bootstrap/Task 15.1 supplies in production).
 */
export type RegisterBrowserBridgeOptions = {
  /** Override the shared browser services entirely (tests / bootstrap). */
  services?: BrowserServices;
  /** Inject a view manager directly; the bridge adds its own agent-mode store. */
  viewManager?: IBrowserViewManager;
  /**
   * Main-window accessor for the lazily-built default services. Supplied by the
   * global bootstrap (Task 15.1), which owns window creation. Ignored when
   * `services` or `viewManager` is provided.
   */
  getWindow?: () => BrowserWindow | null | undefined;
};

/**
 * Resolve the {@link BrowserServices} to wire, honouring the precedence
 * documented on {@link RegisterBrowserBridgeOptions}.
 *
 * @throws if none of `services`, `viewManager`, or `getWindow` is provided.
 */
const resolveServices = (options: RegisterBrowserBridgeOptions): BrowserServices => {
  if (options.services) return options.services;
  if (options.viewManager) {
    return { viewManager: options.viewManager, ...createAgentModeStore() };
  }
  if (options.getWindow) return getBrowserServices(options.getWindow);
  throw new Error('[BrowserBridge] registerBrowserBridge requires one of: services, viewManager, or getWindow.');
};

/**
 * Register the browser IPC handlers.
 *
 * Idempotent: calling it again re-registers the providers (the underlying
 * `bridge` replaces the handler bound to each channel). Intended to be invoked
 * once during Main-process bootstrap (Task 15.1) with the real main-window
 * accessor.
 *
 * @param options Injected services and/or the main-window accessor (see
 *   {@link RegisterBrowserBridgeOptions}).
 */
export function registerBrowserBridge(options: RegisterBrowserBridgeOptions = {}): void {
  const services = resolveServices(options);
  const { viewManager } = services;

  // Open a new embedded browser tab and return its stable id (criterion 1.1).
  browserChannels.openTab.provider((request) => Promise.resolve({ id: viewManager.createTab(request) }));

  // Navigate an existing tab to a URL (criterion 1.1).
  browserChannels.navigate.provider(({ id, url }) => viewManager.loadURL(id, url));

  // Browser-style back / forward in a tab's history.
  browserChannels.goBack.provider(({ id }) => Promise.resolve({ navigated: viewManager.goBack(id) }));
  browserChannels.goForward.provider(({ id }) => Promise.resolve({ navigated: viewManager.goForward(id) }));

  browserChannels.reload.provider(({ id }) => {
    viewManager.reload(id);
    return Promise.resolve();
  });

  // Reposition/resize a tab to the renderer's viewport rectangle.
  browserChannels.setBounds.provider(({ id, bounds }) => {
    viewManager.setBounds(id, bounds);
    return Promise.resolve();
  });

  // Zoom a tab's web content to fit a narrow viewport (criterion 1.1 — fit-to-frame).
  browserChannels.setZoom.provider(({ id, factor }) => {
    viewManager.setZoom(id, factor);
    return Promise.resolve();
  });

  // Show / hide a tab without destroying it.
  browserChannels.show.provider(({ id }) => {
    viewManager.show(id);
    return Promise.resolve();
  });
  // Non-exclusive visibility: show/hide ONE tab without touching the others, so
  // the in-chat multi-frame watch grid can paint several agent tabs at once.
  browserChannels.setVisible.provider(({ id, visible }) => {
    viewManager.setVisible(id, visible);
    return Promise.resolve();
  });
  browserChannels.hide.provider(({ id }) => {
    viewManager.hide(id);
    return Promise.resolve();
  });

  // Hide every tab — used when the renderer leaves the Browser page so the
  // native WebContentsView stops painting over other screens.
  browserChannels.hideAll.provider(() => {
    viewManager.hideAll();
    return Promise.resolve();
  });

  // List every managed tab with its live url/title and last-known bounds.
  browserChannels.listTabs.provider(() => Promise.resolve(viewManager.listTabs()));

  // Destroy a tab and forget its agent-mode flag.
  browserChannels.destroyTab.provider(({ id }) => {
    viewManager.destroyTab(id);
    services.clearAgentMode(id);
    return Promise.resolve();
  });

  // Read the current agent-mode flag for a tab (criterion 1.2).
  browserChannels.getAgentMode.provider(({ id }) => Promise.resolve({ id, enabled: services.isAgentMode(id) }));

  // Toggle a tab into / out of controllable web-agent mode (criterion 1.2). The
  // actual control loop is wired by the Browser-Control MCP (Task 6.6); here we
  // only track the flag. Enabling requires the tab to still exist.
  browserChannels.setAgentMode.provider(({ id, enabled }) => {
    if (enabled && !viewManager.getWebContents(id)) {
      throw new Error(`[BrowserBridge] Cannot enable agent mode for unknown or destroyed tab: ${id}`);
    }
    services.setAgentMode(id, enabled);
    return Promise.resolve({ id, enabled: services.isAgentMode(id) });
  });

  // Run one web-agent turn on a tab (criterion 1.2). Streams live steps via the
  // `agentEvent` emitter and resolves with the final result. Model/network
  // errors are surfaced as `error` events by the runner and a non-`done` status
  // here, so the renderer chat never hangs.
  browserChannels.runAgent.provider(async ({ id, model, instruction, history, interactive }) => {
    const runner = services.agentRunner;
    if (!runner) {
      throw new Error('[BrowserBridge] Web agent is not available (no runner wired).');
    }
    return runner.run({ tabId: id, model, instruction, history, interactive }, (event) => {
      browserChannels.agentEvent.emit({ event });
    });
  });

  // Cancel the in-flight agent turn for a tab (best-effort, cooperative).
  browserChannels.cancelAgent.provider(({ id }) => {
    services.agentRunner?.cancel(id);
    return Promise.resolve();
  });

  // Personal-agent persona: read/write the standing instructions the agent
  // follows every turn. Degrade gracefully when no memory store is wired.
  browserChannels.getPersona.provider(() => services.memory?.getPersona() ?? Promise.resolve(''));
  browserChannels.setPersona.provider(async ({ persona }) => {
    await services.memory?.setPersona(persona);
  });
}

/**
 * Reset the lazily-built default services. Useful for deterministic teardown
 * (tests, hot-reload); registered providers remain bound to their channels.
 */
export function disposeBrowserBridge(): void {
  defaultServices?.viewManager.dispose();
  defaultServices = undefined;
}

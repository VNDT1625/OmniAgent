/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Embedded-browser tab lifecycle manager (Requirement 1 — browser integration +
 * web agent, criteria 1.1 and 1.3).
 *
 * This Main-process service owns one Electron {@link WebContentsView} per
 * browser-tab region. Each view is attached to the main window's `contentView`
 * and positioned by the renderer's tab viewport rectangle. It is the single
 * source of truth for browser tabs and is driven by both integration planes
 * described in `design.md`:
 *
 * - **UI plane** — the future `browserBridge` (Task 6.5) calls this service when
 *   the user opens / moves / closes a tab.
 * - **Agent plane** — the future Browser-Control MCP server (Task 6.6) and
 *   `pagePerception` (Task 6.3) obtain the underlying `WebContents` via
 *   {@link IBrowserViewManager.getWebContents} to navigate, read, click and
 *   capture the page.
 *
 * ## Why `WebContentsView` (not `BrowserView`)
 *
 * `BrowserView` is deprecated. `WebContentsView` (Electron 30+) is the supported
 * replacement: it composes into the window's view tree via `contentView`, gives
 * full `WebContents` access (navigation, `executeJavaScript`, `capturePage`,
 * input injection) needed by later perception/control tasks, and renders the
 * real Chromium core the requirements call for.
 *
 * ## Session choice (criterion 1.3 — real user login session)
 *
 * By default the manager does **not** set a `partition`. Omitting `partition`
 * makes each tab use Electron's default persistent session — the same session
 * the main window uses — so the web agent operates inside the user's **real
 * login session** (their existing cookies / logins), as required. An explicit
 * `partition` is accepted in {@link CreateTabOptions} only for advanced,
 * opt-in isolation; nothing here creates an incognito/isolated partition on its
 * own.
 *
 * Web-content `webPreferences` are locked down by default (`contextIsolation:
 * true`, `nodeIntegration: false`, `sandbox: true`) so remote pages cannot reach
 * Node or Electron internals.
 *
 * ## Testability
 *
 * The two Electron touch-points are injected via {@link BrowserViewManagerDeps}:
 * the parent-window accessor (`getWindow`) and the view factory (`createView`).
 * Tests supply lightweight doubles for both, so the tab lifecycle can be
 * verified without a live Electron window. The DI style mirrors
 * `resourceCoordinator.ts`.
 *
 * This file only manages the **view lifecycle** (create / position / navigate /
 * show-hide / list / destroy). Heavy perception actions (screenshots, vision,
 * transcription) live in later tasks and must acquire a ResourceCoordinator
 * lease before running — see the `TODO(lease)` markers.
 */

import { WebContentsView } from 'electron';
import type { BrowserWindow, WebContents, WebContentsViewConstructorOptions, WebPreferences } from 'electron';

/** Stable identifier for a single browser tab / {@link WebContentsView}. */
export type BrowserTabId = string;

/**
 * The on-screen rectangle (in the main window's content coordinates) where a
 * tab's web content is painted. The renderer computes this from its browser-tab
 * region and pushes it down via {@link IBrowserViewManager.setBounds}.
 */
export type TabBounds = {
  /** X offset from the window content's top-left, in device-independent pixels. */
  x: number;
  /** Y offset from the window content's top-left, in device-independent pixels. */
  y: number;
  /** Width of the tab viewport, in device-independent pixels. */
  width: number;
  /** Height of the tab viewport, in device-independent pixels. */
  height: number;
};

/** Serializable description of a managed tab, returned by {@link IBrowserViewManager.listTabs}. */
export type BrowserTabInfo = {
  /** Stable tab identifier. */
  id: BrowserTabId;
  /** The URL currently loaded in the tab (empty string before first navigation). */
  url: string;
  /** The page title currently reported by the tab. */
  title: string;
  /** Whether the tab is currently visible (attached and painting). */
  visible: boolean;
  /** The most recent bounds applied to the tab. */
  bounds: TabBounds;
};

/** Options accepted when creating a new tab. All fields are optional. */
export type CreateTabOptions = {
  /**
   * Explicit tab id. When omitted a unique id is generated. Supplying an id that
   * already exists throws, so ids stay unique.
   */
  id?: BrowserTabId;
  /** URL to navigate to immediately after the tab is created. */
  url?: string;
  /** Initial bounds; defaults to a zero rectangle until the renderer sets them. */
  bounds?: TabBounds;
  /** Whether the tab starts visible. Defaults to `true`. */
  visible?: boolean;
  /**
   * Advanced, opt-in session partition. Leave unset (the default) to run in the
   * user's **real login session** (criterion 1.3). Setting this isolates the tab
   * into a separate session — only use it when isolation is explicitly wanted.
   */
  partition?: string;
  /**
   * Whether this is an off-screen **background** tab (research / transcript /
   * scraping) that must NEVER play audio, as opposed to a real **user** tab the
   * person is watching.
   *
   * Defaults to `options.visible === false`, which matches how the codebase
   * creates tabs today: research/scrape tabs are created hidden, user tabs are
   * created visible. The distinction drives the audio policy — a user tab keeps
   * its sound even when hidden (so a YouTube tab keeps playing while the user is
   * on another app screen), while a background tab stays muted regardless.
   * Pass it explicitly to override the heuristic.
   */
  background?: boolean;
};

/**
 * Injectable dependencies for {@link createBrowserViewManager}. The two Electron
 * touch-points are injected so the manager can be unit-tested without a live
 * window; only `getWindow` is required.
 */
export type BrowserViewManagerDeps = {
  /**
   * Accessor returning the main window to attach tab views to. Injected (rather
   * than imported) so window ownership stays in the bootstrap/window-creation
   * code and this service does not reach into it directly. May return `null`
   * before the window exists or after it is destroyed.
   */
  getWindow: () => BrowserWindow | null | undefined;
  /**
   * Factory creating a {@link WebContentsView}. Defaults to the real Electron
   * constructor; tests inject a double.
   */
  createView?: (options: WebContentsViewConstructorOptions) => WebContentsView;
  /** Unique tab-id generator. Defaults to `crypto.randomUUID`. */
  generateId?: () => string;
  /**
   * Optional callback fired when a tab's URL or title changes on its own (e.g.
   * an in-page SPA navigation like switching YouTube videos, or a redirect).
   * Lets the bridge push live updates to the renderer so the address bar stays
   * in sync without polling. Best-effort: never throws back into Electron.
   */
  onTabUpdate?: (update: TabUpdate) => void;
};

/** A live URL/title change for a managed tab, pushed via {@link BrowserViewManagerDeps.onTabUpdate}. */
export type TabUpdate = {
  /** The tab whose URL/title changed. */
  id: BrowserTabId;
  /** The tab's current URL. */
  url: string;
  /** The tab's current title. */
  title: string;
};

/**
 * Public contract of the browser view manager. Both the UI bridge and the
 * agent-facing MCP server call these methods so the user and the agent always
 * observe the same set of tabs.
 */
export type IBrowserViewManager = {
  /**
   * Create a tab backed by a new {@link WebContentsView}, attach it to the main
   * window and return its stable id.
   *
   * @throws if the main window is unavailable, or if `options.id` is already in use.
   */
  createTab: (options?: CreateTabOptions) => BrowserTabId;
  /** Destroy a tab: detach its view, free its `WebContents`, and forget it. No-op for unknown ids. */
  destroyTab: (id: BrowserTabId) => void;
  /** Reposition/resize a tab to the renderer's viewport rectangle. No-op for unknown ids. */
  setBounds: (id: BrowserTabId, bounds: TabBounds) => void;
  /** Navigate a tab to `url`. Rejects if the tab is unknown or already destroyed. */
  loadURL: (id: BrowserTabId, url: string) => Promise<void>;
  /** Go back in a tab's history. Resolves to `true` if it navigated, `false` if it couldn't. */
  goBack: (id: BrowserTabId) => boolean;
  /** Go forward in a tab's history. Resolves to `true` if it navigated, `false` if it couldn't. */
  goForward: (id: BrowserTabId) => boolean;
  /** Reload a tab. No-op for unknown ids. */
  reload: (id: BrowserTabId) => void;
  /**
   * Set the zoom factor of a tab's web content (e.g. `1` = 100%, `1.5` = 150%).
   * Lets a page fit a narrow viewport without resizing the window. No-op for
   * unknown ids. The factor is clamped to a sane `[0.25, 5]` range.
   */
  setZoom: (id: BrowserTabId, factor: number) => void;
  /** Show a tab (make its view visible). No-op for unknown ids. */
  show: (id: BrowserTabId) => void;
  /**
   * Set a single tab's visibility WITHOUT touching other tabs (non-exclusive).
   * Unlike {@link show} (which hides every other tab so only one paints), this
   * lets several tabs render at once — used by the in-chat multi-frame watch
   * grid where each agent tab gets its own live frame side by side. No-op for
   * unknown ids.
   */
  setVisible: (id: BrowserTabId, visible: boolean) => void;
  /** Hide a tab (keep it alive but stop painting it). No-op for unknown ids. */
  hide: (id: BrowserTabId) => void;
  /** Hide every managed tab (used when the Browser page is not on screen). */
  hideAll: () => void;
  /** List all currently managed tabs with their live url/title and last-known bounds. */
  listTabs: () => BrowserTabInfo[];
  /**
   * Expose the underlying {@link WebContents} so later tasks (pagePerception
   * 6.3, Browser-Control MCP 6.6) can drive it. Returns `undefined` for unknown
   * or already-destroyed tabs.
   */
  getWebContents: (id: BrowserTabId) => WebContents | undefined;
  /** Destroy every tab and release all resources. */
  dispose: () => void;
};

/** Default, locked-down web-content preferences for embedded tabs. */
const DEFAULT_WEB_PREFERENCES: WebPreferences = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
};

/** Bounds used when a tab is created without an explicit rectangle. */
const ZERO_BOUNDS: TabBounds = { x: 0, y: 0, width: 0, height: 0 };

/**
 * Detect Electron's benign "navigation superseded" rejection. `loadURL` rejects
 * with an `ERR_ABORTED` (errno -3) error whenever the requested navigation is
 * replaced by a redirect or a newer navigation before it commits — the page
 * still loads, so this must NOT be treated as a load failure. Electron surfaces
 * this either as an error whose `code` is `'ERR_ABORTED'` or whose `errno` is
 * `-3`; older builds only set the message, so we also match it textually.
 */
const isAbortedNavigation = (error: unknown): boolean => {
  if (error === null || typeof error !== 'object') return false;
  const e = error as { code?: unknown; errno?: unknown; message?: unknown };
  if (e.code === 'ERR_ABORTED') return true;
  if (e.errno === -3) return true;
  return typeof e.message === 'string' && e.message.includes('ERR_ABORTED');
};

/** Internal bookkeeping for one managed tab. */
type TabRecord = {
  readonly id: BrowserTabId;
  readonly view: WebContentsView;
  bounds: TabBounds;
  visible: boolean;
  /**
   * Off-screen background tab (research / scraping). Such tabs are always muted;
   * real user tabs keep their audio even when hidden so a video keeps playing in
   * the background.
   */
  readonly background: boolean;
};

/**
 * Concrete manager. Not exported directly — callers use
 * {@link createBrowserViewManager} so the dependency object stays the single
 * construction entry point.
 */
class BrowserViewManagerImpl implements IBrowserViewManager {
  private readonly getWindow: () => BrowserWindow | null | undefined;
  private readonly createView: (options: WebContentsViewConstructorOptions) => WebContentsView;
  private readonly generateId: () => string;
  private readonly onTabUpdate?: (update: TabUpdate) => void;
  private readonly tabs = new Map<BrowserTabId, TabRecord>();

  constructor(deps: BrowserViewManagerDeps) {
    this.getWindow = deps.getWindow;
    this.createView = deps.createView ?? ((options) => new WebContentsView(options));
    this.generateId = deps.generateId ?? (() => crypto.randomUUID());
    this.onTabUpdate = deps.onTabUpdate;
  }

  createTab(options: CreateTabOptions = {}): BrowserTabId {
    const window = this.requireWindow();

    const id = options.id ?? this.generateId();
    if (this.tabs.has(id)) {
      throw new Error(`[BrowserViewManager] Tab id already exists: ${id}`);
    }

    // TODO(lease): before creating a live WebContentsView (a heavy, RAM-hungry
    // resource), acquire a ResourceCoordinator lease of TaskKind 'browser' and
    // release it in destroyTab, per criterion 1.9 / Requirement 5.9.
    //
    // backgroundThrottling:false applies to ALL embedded tabs by design.
    // Two reasons it must stay off even for hidden USER tabs:
    //   1. BACKGROUND research/transcript tabs: Chromium otherwise throttles
    //      timers/rAF/JS in non-visible WebContents, so an off-screen page never
    //      finishes running its own scripts (e.g. YouTube's player/ytcfg init) —
    //      which broke hidden-tab transcript extraction.
    //   2. USER tabs: keeping them un-throttled lets a video/song the user
    //      started keep playing smoothly while they switch to another in-app
    //      screen. This is a deliberate, useful trade-off — the embedded browser
    //      is an intentional exception to background power saving, and the user
    //      can always close a tab if it costs too much.
    const webPreferences: WebPreferences = { ...DEFAULT_WEB_PREFERENCES, backgroundThrottling: false };
    if (options.partition !== undefined) {
      webPreferences.partition = options.partition;
    }
    const view = this.createView({ webPreferences });

    const bounds = options.bounds ?? ZERO_BOUNDS;
    const visible = options.visible ?? true;
    // A tab is "background" (research / scraping) when explicitly flagged, or by
    // default when it is created hidden — which is how every off-screen
    // research/transcript tab in the codebase is created. User tabs are created
    // visible, so they are NOT background and keep audio even when later hidden.
    const background = options.background ?? visible === false;
    view.setBounds(bounds);
    view.setVisible(visible);
    // Mute policy: a BACKGROUND tab (off-screen scraping) must never make noise.
    // A real USER tab keeps its audio even when hidden, so a YouTube video the
    // user started keeps playing while they are on another app screen. So only
    // mute up-front for background tabs.
    if (background) {
      try {
        view.webContents.setAudioMuted(true);
      } catch {
        // Best-effort: never block tab creation on a mute failure.
      }
    }

    window.contentView.addChildView(view);
    this.tabs.set(id, { id, view, bounds: { ...bounds }, visible, background });

    // Keep popups INSIDE the embedded browser. Without this, any link the page
    // opens in a new window (`target="_blank"`, `window.open`, a "new tab" link)
    // makes Electron spawn a SEPARATE native popup window (its own menu bar) —
    // which is exactly the "the link opened in its own window, not in our
    // browser" problem. Deny the new window and load the URL in THIS tab instead
    // (and push the URL change so the address bar follows). Foreground tabs only;
    // hidden research tabs should not navigate themselves on a popup.
    try {
      view.webContents.setWindowOpenHandler(({ url }) => {
        if (/^https?:\/\//i.test(url)) {
          void view.webContents.loadURL(url).catch(() => {});
        }
        return { action: 'deny' };
      });
    } catch {
      // Best-effort: never block tab creation on a handler failure.
    }

    // Push live URL/title changes so the renderer address bar stays in sync —
    // including in-page SPA navigations (e.g. switching YouTube videos), which
    // fire `did-navigate-in-page` rather than a full `did-navigate`. Hidden tabs
    // (visible:false, used for background research) skip notification: they are
    // not on screen and would only churn the UI.
    if (this.onTabUpdate && visible) {
      const notify = (): void => {
        const record = this.tabs.get(id);
        if (!record || record.view.webContents.isDestroyed()) return;
        try {
          this.onTabUpdate?.({ id, url: record.view.webContents.getURL(), title: record.view.webContents.getTitle() });
        } catch {
          // Never let a renderer-push failure bubble back into Electron events.
        }
      };
      const wc = view.webContents;
      wc.on('did-navigate', notify);
      wc.on('did-navigate-in-page', notify);
      wc.on('page-title-updated', notify);
    }

    if (options.url !== undefined) {
      // Fire-and-forget initial navigation; callers wanting to await should use loadURL.
      void view.webContents.loadURL(options.url).catch((error: unknown) => {
        console.error(`[BrowserViewManager] Initial loadURL failed for tab ${id}:`, error);
      });
    }

    return id;
  }

  destroyTab(id: BrowserTabId): void {
    const record = this.tabs.get(id);
    if (!record) return;
    this.tabs.delete(id);

    // Detach from the window first so it stops painting, then free the WebContents.
    const window = this.getWindow();
    if (window && !window.isDestroyed()) {
      window.contentView.removeChildView(record.view);
    }
    // TODO(lease): release the 'browser' lease acquired in createTab here.
    if (!record.view.webContents.isDestroyed()) {
      record.view.webContents.close();
    }
  }

  setBounds(id: BrowserTabId, bounds: TabBounds): void {
    const record = this.tabs.get(id);
    if (!record) return;
    record.bounds = { ...bounds };
    record.view.setBounds(bounds);
  }

  async loadURL(id: BrowserTabId, url: string): Promise<void> {
    const record = this.tabs.get(id);
    if (!record) {
      throw new Error(`[BrowserViewManager] Cannot load URL for unknown tab: ${id}`);
    }
    if (record.view.webContents.isDestroyed()) {
      throw new Error(`[BrowserViewManager] Cannot load URL for destroyed tab: ${id}`);
    }
    try {
      await record.view.webContents.loadURL(url);
    } catch (error) {
      // Electron rejects `loadURL` with ERR_ABORTED (-3) whenever the initial
      // navigation is *superseded* — i.e. the site issues a redirect
      // (youtube.com → www.youtube.com, facebook.com → its consent/login URL) or
      // a follow-up navigation starts before the first one commits. In every one
      // of those cases the page actually DOES load; only the original promise is
      // aborted. Treating that abort as a failure is exactly why `browser_open`
      // reported an error and the watch frame showed blank. Swallow the benign
      // abort and let the tab settle on its redirected URL; rethrow anything else
      // (DNS failures, refused connections, …) so real errors still surface.
      if (!isAbortedNavigation(error)) throw error;
    }
  }

  goBack(id: BrowserTabId): boolean {
    const record = this.tabs.get(id);
    if (!record || record.view.webContents.isDestroyed()) return false;
    const nav = record.view.webContents.navigationHistory;
    if (nav && !nav.canGoBack()) return false;
    record.view.webContents.navigationHistory.goBack();
    return true;
  }

  goForward(id: BrowserTabId): boolean {
    const record = this.tabs.get(id);
    if (!record || record.view.webContents.isDestroyed()) return false;
    const nav = record.view.webContents.navigationHistory;
    if (nav && !nav.canGoForward()) return false;
    record.view.webContents.navigationHistory.goForward();
    return true;
  }

  reload(id: BrowserTabId): void {
    const record = this.tabs.get(id);
    if (!record || record.view.webContents.isDestroyed()) return;
    record.view.webContents.reload();
  }

  setZoom(id: BrowserTabId, factor: number): void {
    const record = this.tabs.get(id);
    if (!record || record.view.webContents.isDestroyed()) return;
    // Clamp to Chromium's practical zoom range so a bad value can't break rendering.
    const clamped = Math.min(5, Math.max(0.25, Number.isFinite(factor) ? factor : 1));
    record.view.webContents.setZoomFactor(clamped);
  }

  show(id: BrowserTabId): void {
    if (!this.tabs.has(id)) return;
    // Exclusive: only the requested tab paints; hide every other tab so stale
    // views don't bleed through (e.g. an old tab over the active one).
    for (const tabId of this.tabs.keys()) {
      this.setVisibility(tabId, tabId === id);
    }
  }

  hide(id: BrowserTabId): void {
    this.setVisibility(id, false);
  }

  setVisible(id: BrowserTabId, visible: boolean): void {
    // Non-exclusive: only the requested tab's visibility changes; others keep
    // their current state. Enables several frames to paint at once (the in-chat
    // multi-frame watch grid).
    this.setVisibility(id, visible);
  }

  hideAll(): void {
    for (const id of this.tabs.keys()) {
      this.setVisibility(id, false);
    }
  }

  listTabs(): BrowserTabInfo[] {
    const infos: BrowserTabInfo[] = [];
    for (const record of this.tabs.values()) {
      const destroyed = record.view.webContents.isDestroyed();
      infos.push({
        id: record.id,
        url: destroyed ? '' : record.view.webContents.getURL(),
        title: destroyed ? '' : record.view.webContents.getTitle(),
        visible: record.visible,
        bounds: { ...record.bounds },
      });
    }
    return infos;
  }

  getWebContents(id: BrowserTabId): WebContents | undefined {
    const record = this.tabs.get(id);
    if (!record || record.view.webContents.isDestroyed()) return undefined;
    return record.view.webContents;
  }

  dispose(): void {
    // Snapshot the ids first: destroyTab() deletes from `this.tabs` as we go, so
    // iterating a live view would mutate the collection mid-iteration.
    for (const id of Array.from(this.tabs.keys())) {
      this.destroyTab(id);
    }
  }

  /** Apply a visibility change to a known tab, tracking the flag for `listTabs`. */
  private setVisibility(id: BrowserTabId, visible: boolean): void {
    const record = this.tabs.get(id);
    if (!record) return;
    record.visible = visible;
    record.view.setVisible(visible);
    // Audio policy: a BACKGROUND tab stays muted no matter what. A real USER tab
    // is NEVER muted by visibility — that is the whole point of background
    // playback: hiding the Browser page (hideAll) must not silence a YouTube
    // video the user is listening to. So we only (re)assert mute for background
    // tabs and otherwise leave the user's own mute choice untouched.
    if (record.background && !record.view.webContents.isDestroyed()) {
      try {
        record.view.webContents.setAudioMuted(true);
      } catch {
        // ignore
      }
    }
  }

  /** Resolve the live main window or throw a descriptive error. */
  private requireWindow(): BrowserWindow {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) {
      throw new Error('[BrowserViewManager] Main window is unavailable; cannot create a browser tab.');
    }
    return window;
  }
}

/**
 * Create a {@link IBrowserViewManager}.
 *
 * @param deps - Injected dependencies; only `getWindow` is required.
 * @returns A fresh browser view manager.
 */
export const createBrowserViewManager = (deps: BrowserViewManagerDeps): IBrowserViewManager =>
  new BrowserViewManagerImpl(deps);

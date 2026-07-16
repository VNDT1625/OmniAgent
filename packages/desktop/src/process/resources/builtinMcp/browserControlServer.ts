/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in Browser-Control MCP server (Requirement 1 — "Tích hợp trình duyệt và
 * tác nhân duyệt web", criteria 1.2, 1.3, 1.9 — Agent plane).
 *
 * This is the **agent-facing** half of the embedded-browser integration: it
 * exposes a small set of tools that let an AI agent drive a real Chromium tab —
 * navigate, read, click, type, scroll, wait, screenshot and summarise video —
 * turning the browser tab into a *web agent* (criterion 1.2). It is built on top
 * of (and only on top of) the four browser services:
 *
 *  - {@link IBrowserViewManager} — tab lifecycle + the tab's `WebContents`.
 *  - {@link IHumanLikeInput}     — human-like pointer/keyboard emission.
 *  - {@link IPagePerception}     — read text / capture a screenshot.
 *  - {@link IMediaPipeline}      — summarise a video.
 *
 * ## Tool-name convention (snake_case, not dotted)
 *
 * `design.md` lists these capabilities with dotted names (`browser.open`,
 * `browser.readText`, …). Like the existing built-in servers
 * (`aionui_image_generation`, `company_create`, `resource_status`) we expose
 * them in **snake_case** (`browser_open`, `browser_read_text`, …): MCP tools are
 * surfaced to the model as function-calling tools, whose names must match
 * `^[a-zA-Z0-9_-]+$`, so a dot separator would break OpenAI/Gemini function
 * calling. The set and intent match the design exactly.
 *
 * ## Criterion 1.3 — isolated, human-like input (Property 1)
 *
 * EVERY pointer/keyboard interaction (click, type) is routed through
 * {@link IHumanLikeInput}, which emits via an {@link InputSink} adapter built
 * here over the tab's `webContents.sendInputEvent(...)`. The agent therefore
 * runs inside the user's real login session and stays **isolated to the tab** —
 * it NEVER uses OS-level / global input. Scrolling has no `humanLikeInput`
 * primitive, so it is sent as incremental `mouseWheel` events through the same
 * tab-scoped `webContents.sendInputEvent` (still tab-isolated, never OS-level)
 * after a human-like pointer move to the scroll anchor.
 *
 * ## Criterion 1.9 — heavy ops go through the ResourceCoordinator
 *
 * The two heavy tools delegate to collaborators that **already lease
 * internally**: `browser_screenshot` → {@link IPagePerception.capture} (acquires
 * a `'browser'` lease) and `browser_summarize_video` →
 * {@link IMediaPipeline.summarizeVideo} (leases each heavy step). This server
 * therefore MUST NOT double-lease those operations. The {@link LeaseCoordinator}
 * is still injected as the explicit lease authority for any future heavy work
 * this server performs *directly* (there is none today).
 *
 * ## Process boundary & wiring
 *
 * Main-process (Node.js / Electron) module — **no DOM APIs at module scope**.
 * The DOM-reading snippets are plain *strings* handed to
 * `WebContents.executeJavaScript`; that code runs *inside the page*, never in
 * Node. Unlike the standalone stdio servers (`imageGenServer`, `resourceServer`,
 * `companyServer`), this server cannot run in a separate `node` process because
 * it drives **live** `WebContentsView` instances that only exist in the Main
 * process. It is therefore exposed as a {@link createBrowserControlServer}
 * factory that returns a ready {@link McpServer}; Task 15.1 injects the real
 * collaborators and connects it to a transport in-process.
 *
 * Every collaborator is injected via {@link BrowserControlDeps} so the server is
 * unit-testable without a live Electron window (DI style mirrors
 * `pagePerception.ts` / `mediaPipeline.ts`).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { BrowserTabId, IBrowserViewManager } from '@process/browser/browserViewManager';
import type { IHumanLikeInput, InputSink, MouseButton, Point } from '@process/browser/humanLikeInput';
import type { IPagePerception, LeaseCoordinator } from '@process/browser/pagePerception';
import type { IMediaPipeline, MediaSource } from '@process/browser/mediaPipeline';
import type { IEditorFrameStore } from '@process/editor/editorFrameStore';
import type { ExtractSource, ExtractOutcome } from '@process/services/contentExtract';

/** Stable identifier of the built-in Browser-Control MCP server (consumed by Task 15.1). */
export const BUILTIN_BROWSER_CONTROL_ID = 'builtin-browser-control';

/** Canonical name of the built-in Browser-Control MCP server (consumed by Task 15.1). */
export const BUILTIN_BROWSER_CONTROL_NAME = 'aionui-browser-control';

/**
 * The live `WebContents` of a managed tab, derived structurally from
 * {@link IBrowserViewManager.getWebContents} so this module needs no direct
 * Electron value import. Only two members are used: `executeJavaScript` (to read
 * the page / resolve element coordinates) and `sendInputEvent` (to inject
 * human-like pointer/keyboard/wheel events scoped to the tab).
 */
type PageContents = NonNullable<ReturnType<IBrowserViewManager['getWebContents']>>;

/**
 * Factory that builds an {@link IHumanLikeInput} bound to a per-tab
 * {@link InputSink}. Production wiring (Task 15.1) passes
 * `(sink) => createHumanLikeInput({ sink })`; tests pass a spy. A fresh emitter
 * is created per interaction because the sink is tab-specific.
 */
export type CreateHumanLikeInput = (sink: InputSink) => IHumanLikeInput;

/**
 * Injected collaborators and tunables for {@link createBrowserControlServer}.
 * Only the four browser services plus the lease authority are required; the rest
 * are optional testability/UX hooks with production defaults.
 */
export type BrowserControlDeps = {
  /** Tab lifecycle + `WebContents` access (open / navigate / list / drive). */
  viewManager: IBrowserViewManager;
  /** Builds a human-like input emitter over a tab's {@link InputSink} (criterion 1.3). */
  createInput: CreateHumanLikeInput;
  /** Page perception: `readText` (light) and `capture` (leases internally). */
  pagePerception: IPagePerception;
  /** Media pipeline backing `browser_summarize_video` (leases internally). */
  mediaPipeline: IMediaPipeline;
  /**
   * The explicit lease authority for heavy work (criterion 1.9). NOTE: the only
   * heavy tools (`browser_screenshot`, `browser_summarize_video`) delegate to
   * collaborators that already lease internally, so this server must not
   * double-lease them; this is retained as the lease owner for any future heavy
   * operation performed directly here.
   */
  coordinator: LeaseCoordinator;
  /**
   * Resolve the user's currently active/visible tab when a tool omits `tabId`.
   * When absent, a tool falls back to the single open tab, or errors if the
   * choice is ambiguous.
   */
  getActiveTabId?: () => BrowserTabId | undefined;
  /** Delay primitive for scroll pacing and `browser_wait_for` polling. Defaults to `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Wall-clock source (Unix ms) used by `browser_wait_for` timeouts. Defaults to `Date.now`. */
  now?: () => number;
  /**
   * Editor capability (Super's "Studio editor" plane). When provided, the server
   * also exposes `editor_*` tools so the agent can open a file as a live editor
   * frame in the chat and read/write it. The store tracks open frames (the
   * renderer renders one {@link UniversalEditor} per entry); `editorIO`
   * reads/writes the file via the same fs API the Universal Editor uses. Omit
   * both to run a browser-only server (tests / minimal wiring).
   */
  editorFrames?: IEditorFrameStore;
  /** File read/write for the `editor_*` tools (the fs HTTP API in production). */
  editorIO?: {
    read: (filePath: string) => Promise<string>;
    write: (filePath: string, content: string) => Promise<void>;
  };
  /**
   * Shared content-extraction service backing `extract_content` — turns a
   * YouTube URL, a local file path, or raw HTML into clean Markdown/text
   * (yt-dlp → fallback for transcripts; markitdown → Node for files). Optional:
   * when omitted the server lazily uses the process-wide default service.
   */
  extractContent?: { extract: (source: ExtractSource) => Promise<ExtractOutcome> };
};

/** Default ceiling for {@link IPagePerception} `browser_wait_for` polling. */
const DEFAULT_WAIT_TIMEOUT_MS = 10_000;

/** Default poll interval for `browser_wait_for`. */
const DEFAULT_WAIT_INTERVAL_MS = 250;

/** Number of incremental wheel events one scroll request is broken into (human-like pacing). */
const SCROLL_STEPS = 6;

/** Delay (ms) between successive wheel increments during a scroll. */
const SCROLL_STEP_DELAY_MS = 24;

/** Cursor start point assumed for a tab before its first pointer interaction. */
const ORIGIN: Point = { x: 0, y: 0 };

/** Standard MCP text payload, optionally flagged as an error. */
type ToolTextResult = { content: Array<{ type: 'text'; text: string }>; isError?: boolean };

/** Build a standard MCP text payload, optionally flagged as an error. */
const textResult = (text: string, isError = false): ToolTextResult => ({
  content: [{ type: 'text' as const, text }],
  ...(isError ? { isError: true } : {}),
});

/** Stringify any caught error for an MCP text payload. */
const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Narrow an `executeJavaScript` result to a {@link Point}, or `null` when it is not one. */
const asPoint = (value: unknown): Point | null => {
  if (value !== null && typeof value === 'object' && 'x' in value && 'y' in value) {
    const candidate = value as { x: unknown; y: unknown };
    if (typeof candidate.x === 'number' && typeof candidate.y === 'number') {
      return { x: candidate.x, y: candidate.y };
    }
  }
  return null;
};

/**
 * Build the in-page snippet that resolves the click target's centre. The element
 * is scrolled into view first (so off-screen targets become clickable), then its
 * bounding-box centre is returned. The selector is embedded via `JSON.stringify`
 * so it is safely escaped. Returns `{ x, y }` or `null` when nothing matched.
 */
const buildSelectorPointScript = (selector: string): string => `(() => {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return null;
  if (typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center', inline: 'center' });
  const rect = el.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
})()`;

/** In-page snippet returning the current viewport centre — the scroll anchor. */
const VIEWPORT_CENTER_SCRIPT = `(() => ({ x: Math.floor(window.innerWidth / 2), y: Math.floor(window.innerHeight / 2) }))()`;

/**
 * Build the in-page snippet that evaluates an agent-supplied boolean condition.
 * The condition is a JS expression run *inside the page* (e.g.
 * `document.querySelector('#done') !== null`); any thrown error is swallowed and
 * treated as "not yet true" so polling continues until the timeout.
 */
const buildConditionScript = (condition: string): string => `(() => {
  try { return Boolean(${condition}); } catch (error) { return false; }
})()`;

/**
 * Create a Browser-Control {@link McpServer} bound to the injected collaborators.
 *
 * @param deps Browser services, the human-like-input factory, the lease
 *   authority and optional testability/UX hooks. See {@link BrowserControlDeps}.
 * @returns A configured MCP server; the caller (Task 15.1) connects a transport.
 *
 * @example
 * ```ts
 * const server = createBrowserControlServer({
 *   viewManager,
 *   createInput: (sink) => createHumanLikeInput({ sink }),
 *   pagePerception,
 *   mediaPipeline,
 *   coordinator: resourceCoordinator,
 *   getActiveTabId: () => activeTabId,
 * });
 * await server.connect(transport);
 * ```
 */
export const createBrowserControlServer = (deps: BrowserControlDeps): McpServer => {
  const { viewManager, pagePerception, mediaPipeline, createInput } = deps;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms))));
  const now = deps.now ?? (() => Date.now());

  const server = new McpServer({ name: BUILTIN_BROWSER_CONTROL_NAME, version: '1.0.0' });

  /** Last-known cursor position per tab, so pointer moves start where they left off. */
  const cursors = new Map<BrowserTabId, Point>();

  /**
   * Resolve which tab a tool operates on: an explicit `tabId`, else the injected
   * active tab, else the single open tab. Throws a descriptive error otherwise.
   */
  const resolveTabId = (tabId?: BrowserTabId): BrowserTabId => {
    if (tabId) return tabId;
    const active = deps.getActiveTabId?.();
    if (active) return active;
    const tabs = viewManager.listTabs();
    if (tabs.length === 1) return tabs[0].id;
    if (tabs.length === 0) throw new Error('No browser tab is open. Call browser_open first.');
    throw new Error('Multiple tabs are open; pass an explicit tabId.');
  };

  /** Resolve a tab's live {@link PageContents}, or throw when unavailable. */
  const requireContents = (tabId: BrowserTabId): PageContents => {
    const contents = viewManager.getWebContents(tabId);
    if (!contents) throw new Error(`No live web contents for tab: ${tabId}`);
    return contents;
  };

  /**
   * Adapt a tab's `WebContents` into an {@link InputSink} (criterion 1.3). Every
   * call maps onto `webContents.sendInputEvent(...)`, keeping all input scoped to
   * the tab — never OS-level.
   */
  const buildInputSink = (contents: PageContents): InputSink => ({
    sendMouseMove: (x, y) => {
      contents.sendInputEvent({ type: 'mouseMove', x, y });
    },
    sendMouseDown: (x, y, button) => {
      contents.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount: 1 });
    },
    sendMouseUp: (x, y, button) => {
      contents.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount: 1 });
    },
    sendKeyChar: (ch) => {
      contents.sendInputEvent({ type: 'char', keyCode: ch });
    },
  });

  /** Evaluate `code` in the page and return its result as `unknown` (no `any` leak). */
  const evaluate = async (contents: PageContents, code: string): Promise<unknown> => {
    const result: unknown = await contents.executeJavaScript(code);
    return result;
  };

  // --- browser_open --------------------------------------------------------
  server.tool(
    'browser_open',
    `Open a URL in an embedded browser tab (criterion 1.2). Creates a new tab when no tabId is
given, or navigates an existing tab. URLs without a scheme are assumed https.

You can open MULTIPLE tabs by calling this several times (omit tabId each time) — for example to
run two things "in parallel" (one tab playing a video, another reading a site). You do NOT need to
spawn sub-agents for that: open the tabs yourself and drive each by passing its tabId to the other
tools. The user watches every open tab live in the in-chat browser popup.

Input:
- url: the page to open (required)
- tabId: navigate this existing tab instead of creating one (optional)

Returns the tab id plus the final URL and title.`,
    {
      url: z.string().describe('The URL to open. A missing scheme defaults to https://.'),
      tabId: z.string().optional().describe('Existing tab to navigate; omit to open a new tab.'),
    },
    async ({ url, tabId }) => {
      try {
        const normalized = /^[a-zA-Z][\w+.-]*:\/\//.test(url) ? url : `https://${url}`;
        // Reuse the supplied tab ONLY when it still exists. A model frequently
        // passes a tabId it invented (or one whose tab was already closed),
        // because the Super rules encourage multi-tab work; treating that as a
        // navigate-existing request makes loadURL throw "unknown tab" and the
        // watch frame stays blank — the exact failure the user hit. `browser_open`
        // must ALWAYS succeed in showing the page, so an unknown tabId falls back
        // to opening a fresh tab.
        // Create the tab at zero bounds so it cannot flash full-window before the
        // in-chat watch frame measures + positions it. The frame then shows it via
        // setVisible once it has pushed real bounds (criterion: never paint stale).
        const known = tabId !== undefined && viewManager.listTabs().some((tab) => tab.id === tabId);
        const id = known
          ? (tabId as BrowserTabId)
          : viewManager.createTab({ visible: true, bounds: { x: 0, y: 0, width: 0, height: 0 } });
        await viewManager.loadURL(id, normalized);
        const info = viewManager.listTabs().find((tab) => tab.id === id);
        const detail = info ? `${info.url} (title: ${info.title})` : normalized;
        return textResult(
          `Opened ${detail} in tab ${id}.\n${JSON.stringify({ tabId: id, url: info?.url ?? normalized, title: info?.title ?? '' })}`
        );
      } catch (error) {
        return textResult(`Error opening URL: ${describeError(error)}`, true);
      }
    }
  );

  // --- browser_read_text (perception layer a — light, no lease) ------------
  server.tool(
    'browser_read_text',
    `Read the rendered text of the page, optionally scoped to the first element matching a CSS
selector (perception layer a — light, default; no resource lease).

Input:
- selector: CSS selector to scope the read; omit to read the whole <body> (optional)
- tabId: which tab to read; omit to use the active/only tab (optional)

Returns the element's visible text.`,
    {
      selector: z.string().optional().describe('CSS selector to scope the read; omit for the whole page.'),
      tabId: z.string().optional().describe('Tab to read; defaults to the active/only tab.'),
    },
    async ({ selector, tabId }) => {
      try {
        const id = resolveTabId(tabId);
        const text = await pagePerception.readText(id, selector);
        return textResult(text);
      } catch (error) {
        return textResult(`Error reading text: ${describeError(error)}`, true);
      }
    }
  );

  // --- browser_click (routed through humanLikeInput — criterion 1.3) -------
  server.tool(
    'browser_click',
    `Click an element by CSS selector, or at explicit page coordinates. The click is performed
with human-like mouse movement and press/release timing, isolated to the tab (criterion 1.3).

Input (provide either selector OR x+y):
- selector: CSS selector of the element to click (optional)
- x, y: page coordinates to click (optional; both required if used)
- button: 'left' | 'middle' | 'right' (optional, default 'left')
- tabId: which tab to act on; omit to use the active/only tab (optional)`,
    {
      selector: z.string().optional().describe('CSS selector of the element to click.'),
      x: z.number().optional().describe('Page X coordinate to click (used with y).'),
      y: z.number().optional().describe('Page Y coordinate to click (used with x).'),
      button: z.enum(['left', 'middle', 'right']).optional().describe("Mouse button. Defaults to 'left'."),
      tabId: z.string().optional().describe('Tab to act on; defaults to the active/only tab.'),
    },
    async ({ selector, x, y, button, tabId }) => {
      try {
        const id = resolveTabId(tabId);
        const contents = requireContents(id);

        let target: Point | null;
        if (typeof x === 'number' && typeof y === 'number') {
          target = { x, y };
        } else if (selector) {
          target = asPoint(await evaluate(contents, buildSelectorPointScript(selector)));
        } else {
          return textResult('Provide either a selector or both x and y coordinates to click.', true);
        }
        if (!target) {
          return textResult(`Could not locate a clickable element for selector: ${String(selector)}`, true);
        }

        const input = createInput(buildInputSink(contents));
        const from = cursors.get(id) ?? ORIGIN;
        const buttonChoice: MouseButton = button ?? 'left';
        await input.moveAndClick(from, target, { button: buttonChoice });
        cursors.set(id, target);
        return textResult(
          `Clicked at (${Math.round(target.x)}, ${Math.round(target.y)}) with ${buttonChoice} button in tab ${id}.`
        );
      } catch (error) {
        return textResult(`Error clicking: ${describeError(error)}`, true);
      }
    }
  );

  // --- browser_type (focus via human-like click, then human-rhythm typing) -
  server.tool(
    'browser_type',
    `Type text into the element matching a CSS selector. The element is focused with a human-like
click first, then the text is typed with human-rhythm keystrokes, isolated to the tab (criterion 1.3).

Input:
- selector: CSS selector of the field to type into (required)
- text: the text to type (required)
- tabId: which tab to act on; omit to use the active/only tab (optional)`,
    {
      selector: z.string().describe('CSS selector of the input/textarea to type into.'),
      text: z.string().describe('The text to type.'),
      tabId: z.string().optional().describe('Tab to act on; defaults to the active/only tab.'),
    },
    async ({ selector, text, tabId }) => {
      try {
        const id = resolveTabId(tabId);
        const contents = requireContents(id);

        const target = asPoint(await evaluate(contents, buildSelectorPointScript(selector)));
        if (!target) {
          return textResult(`Could not locate an element to type into for selector: ${selector}`, true);
        }

        const input = createInput(buildInputSink(contents));
        const from = cursors.get(id) ?? ORIGIN;
        await input.moveAndClick(from, target);
        cursors.set(id, target);
        await input.typeText(text);
        return textResult(`Typed ${text.length} character(s) into ${selector} in tab ${id}.`);
      } catch (error) {
        return textResult(`Error typing: ${describeError(error)}`, true);
      }
    }
  );

  // --- browser_scroll (incremental wheel events, tab-isolated) -------------
  server.tool(
    'browser_scroll',
    `Scroll the page in a direction by an amount in pixels. Performed as incremental mouse-wheel
events through the tab's input channel (tab-isolated, never OS-level), after a human-like move to
the scroll anchor.

Input:
- direction: 'up' | 'down' | 'left' | 'right' (required)
- amount: total scroll distance in pixels (required, > 0)
- tabId: which tab to act on; omit to use the active/only tab (optional)`,
    {
      direction: z.enum(['up', 'down', 'left', 'right']).describe('Scroll direction.'),
      amount: z.number().describe('Total scroll distance in pixels (> 0).'),
      tabId: z.string().optional().describe('Tab to act on; defaults to the active/only tab.'),
    },
    async ({ direction, amount, tabId }) => {
      try {
        const id = resolveTabId(tabId);
        const contents = requireContents(id);
        const magnitude = Math.abs(amount);
        if (magnitude === 0) return textResult('Scroll amount must be greater than zero.', true);

        // Human-like move to the viewport centre (the scroll anchor) via humanLikeInput.
        const anchor = asPoint(await evaluate(contents, VIEWPORT_CENTER_SCRIPT)) ?? ORIGIN;
        const input = createInput(buildInputSink(contents));
        await input.moveMouse(cursors.get(id) ?? ORIGIN, anchor);
        cursors.set(id, anchor);

        // Electron wheel convention: positive delta scrolls toward the top/left,
        // so 'down'/'right' use a negative delta. Sent in small steps for realism.
        const step = magnitude / SCROLL_STEPS;
        const perStepX = direction === 'left' ? step : direction === 'right' ? -step : 0;
        const perStepY = direction === 'up' ? step : direction === 'down' ? -step : 0;
        for (let i = 0; i < SCROLL_STEPS; i++) {
          contents.sendInputEvent({ type: 'mouseWheel', x: anchor.x, y: anchor.y, deltaX: perStepX, deltaY: perStepY });
          if (i < SCROLL_STEPS - 1) await sleep(SCROLL_STEP_DELAY_MS);
        }
        return textResult(`Scrolled ${direction} by ${magnitude}px in tab ${id}.`);
      } catch (error) {
        return textResult(`Error scrolling: ${describeError(error)}`, true);
      }
    }
  );

  // --- browser_wait_for (poll a page condition with a timeout) -------------
  server.tool(
    'browser_wait_for',
    `Wait until a JavaScript condition becomes true in the page, polling until a timeout. Useful
for waiting on navigation, an element to appear, or content to load.

Input:
- condition: a JS boolean expression evaluated in the page, e.g. "document.querySelector('#done') !== null" (required)
- timeoutMs: maximum time to wait in milliseconds (optional, default 10000)
- intervalMs: poll interval in milliseconds (optional, default 250)
- tabId: which tab to act on; omit to use the active/only tab (optional)

Returns when the condition is met, or an error result on timeout.`,
    {
      condition: z.string().describe('JS boolean expression evaluated in the page.'),
      timeoutMs: z.number().optional().describe('Maximum wait in ms. Defaults to 10000.'),
      intervalMs: z.number().optional().describe('Poll interval in ms. Defaults to 250.'),
      tabId: z.string().optional().describe('Tab to act on; defaults to the active/only tab.'),
    },
    async ({ condition, timeoutMs, intervalMs, tabId }) => {
      try {
        const id = resolveTabId(tabId);
        const contents = requireContents(id);
        const timeout = timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
        const interval = intervalMs ?? DEFAULT_WAIT_INTERVAL_MS;
        const script = buildConditionScript(condition);
        const deadline = now() + timeout;

        for (;;) {
          if ((await evaluate(contents, script)) === true) {
            return textResult(`Condition became true in tab ${id}.`);
          }
          if (now() >= deadline) {
            return textResult(`Condition did not become true within ${timeout}ms in tab ${id}.`, true);
          }
          await sleep(interval);
        }
      } catch (error) {
        return textResult(`Error waiting for condition: ${describeError(error)}`, true);
      }
    }
  );

  // --- browser_screenshot (perception layer b — leases inside pagePerception) ---
  server.tool(
    'browser_screenshot',
    `Capture a screenshot of the tab for visual/vision evaluation (perception layer b). This is a
medium-weight operation; the underlying capture acquires a resource lease internally (criterion 1.9),
so no extra lease is taken here.

Input:
- tabId: which tab to capture; omit to use the active/only tab (optional)

Returns a PNG image plus its dimensions.`,
    {
      tabId: z.string().optional().describe('Tab to capture; defaults to the active/only tab.'),
    },
    async ({ tabId }) => {
      try {
        const id = resolveTabId(tabId);
        const result = await pagePerception.capture(id);
        const commaIndex = result.dataUrl.indexOf(',');
        const base64 = commaIndex >= 0 ? result.dataUrl.slice(commaIndex + 1) : result.dataUrl;
        return {
          content: [
            { type: 'image' as const, data: base64, mimeType: 'image/png' },
            { type: 'text' as const, text: `Captured ${result.width}x${result.height} screenshot of tab ${id}.` },
          ],
        };
      } catch (error) {
        return textResult(`Error capturing screenshot: ${describeError(error)}`, true);
      }
    }
  );

  // --- browser_summarize_video (delegates to mediaPipeline — leases inside) ---
  server.tool(
    'browser_summarize_video',
    `Summarise a video by URL (criterion 1.5). YouTube URLs use the model's built-in video
summariser (no download); other URLs are processed conservatively (extract audio → transcribe →
summarise). The pipeline leases each heavy step internally (criterion 1.9), so no extra lease is
taken here.

Input:
- url: the video URL to summarise (required)

Returns the summary text and which path produced it.`,
    {
      url: z.string().describe('The video URL to summarise.'),
    },
    async ({ url }) => {
      try {
        const source: MediaSource = { type: 'url', url };
        const summary = await mediaPipeline.summarizeVideo(source);
        return textResult(`Summary (via ${summary.via}):\n\n${summary.summary}`);
      } catch (error) {
        return textResult(`Error summarizing video: ${describeError(error)}`, true);
      }
    }
  );

  // --- browser_research (HIDDEN background search — never disturbs a frame) ---
  server.tool(
    'browser_research',
    `Look something up in the background WITHOUT opening a visible frame the user is watching.
Opens a HIDDEN tab, loads the page (or a Google search for your query), reads its text, and closes
the tab. Use this FIRST to find the right link/answer, THEN open the resolved URL with browser_open
if you actually need to show it.

Input:
- query: what to search for (a Google search is run). Optional if url is given.
- url: a specific page to read instead of searching (optional).

Returns the page's readable text (truncated).`,
    {
      query: z.string().optional().describe('Search query (runs a Google search in a hidden tab).'),
      url: z.string().optional().describe('Specific URL to read in a hidden tab instead of searching.'),
    },
    async ({ query, url }) => {
      const target = url
        ? /^[a-zA-Z][\w+.-]*:\/\//.test(url)
          ? url
          : `https://${url}`
        : query
          ? `https://www.google.com/search?q=${encodeURIComponent(query)}`
          : '';
      if (!target) return textResult('Provide a query or url to research.', true);
      let hiddenId: BrowserTabId | undefined;
      try {
        // Off-screen size so lazy SPAs still render content while never painting on screen.
        hiddenId = viewManager.createTab({ visible: false, bounds: { x: -10000, y: 0, width: 1280, height: 900 } });
        await viewManager.loadURL(hiddenId, target);
        await sleep(1200); // let the page settle
        const contents = requireContents(hiddenId);
        const text = await evaluate(
          contents,
          `(() => { const el = document.body; const t = el && (el.innerText != null ? el.innerText : el.textContent); return t ? String(t).trim() : ''; })()`
        );
        const out = typeof text === 'string' ? text : '';
        const clipped = out.length > 6000 ? `${out.slice(0, 6000)}\n…(truncated)` : out;
        return textResult(`Researched ${target} (hidden):\n${clipped}`);
      } catch (error) {
        return textResult(`Background research failed: ${describeError(error)}`, true);
      } finally {
        if (hiddenId) viewManager.destroyTab(hiddenId);
      }
    }
  );

  // --- browser_list_tabs (enumerate open tabs for multi-tab workflows) -----
  server.tool(
    'browser_list_tabs',
    `List every embedded browser tab currently open, so you can manage several tabs at once (e.g.
one playing a video while another browses). Use the returned tab ids with the other tools' tabId
parameter to drive a specific tab.

Returns a JSON array of { tabId, url, title, visible }.`,
    {},
    () => {
      try {
        const payload = viewManager.listTabs().map((tab) => ({
          tabId: tab.id,
          url: tab.url,
          title: tab.title,
          visible: tab.visible,
        }));
        return textResult(JSON.stringify(payload, null, 2));
      } catch (error) {
        return textResult(`Error listing tabs: ${describeError(error)}`, true);
      }
    }
  );

  // --- extract_content (shared content-extraction: transcript / file / html) ---
  server.tool(
    'extract_content',
    `Extract clean Markdown/text from a source, for accurate summarisation/analysis. Handles:
- a YouTube video URL/id → its transcript (yt-dlp primary, robust fallbacks);
- a local file path (PDF, Word, PowerPoint, Excel, HTML, CSV/JSON/XML…) → Markdown (markitdown);
- a raw HTML string → Markdown.

Prefer this over reading raw page text when you need the full, structured content of a document or
video. Returns the extracted text, or an error describing why extraction failed.`,
    {
      source: z.string().describe('A YouTube URL/id, a local file path, or a raw HTML string. Auto-detected.'),
      kind: z
        .enum(['auto', 'youtube', 'file', 'html'])
        .optional()
        .describe('Force a source kind. Default "auto" sniffs the input.'),
    },
    async ({ source, kind }) => {
      try {
        const extractor =
          deps.extractContent ?? (await import('@process/services/contentExtract')).getContentExtractService();
        const req: ExtractSource =
          kind === 'youtube'
            ? { kind: 'youtube', urlOrId: source }
            : kind === 'file'
              ? { kind: 'file', path: source }
              : kind === 'html'
                ? { kind: 'html', html: source }
                : { kind: 'auto', input: source };
        const out = await extractor.extract(req);
        if (out.ok) {
          const header = [
            out.title ? `Title: ${out.title}` : '',
            out.lang ? `Lang: ${out.lang}` : '',
            `Via: ${out.via}`,
          ]
            .filter(Boolean)
            .join(' | ');
          return textResult(`${header}\n\n${out.text}`);
        }
        return textResult(`Could not extract content: ${(out as { reason?: string }).reason ?? 'unknown'}`, true);
      } catch (error) {
        return textResult(`Error extracting content: ${describeError(error)}`, true);
      }
    }
  );

  // --- editor_* (Super's Studio-editor plane — live editable frames in chat) ---
  // Only registered when the editor capability is wired (editorFrames + editorIO).
  if (deps.editorFrames && deps.editorIO) {
    const editorFrames = deps.editorFrames;
    const editorIO = deps.editorIO;

    server.tool(
      'editor_open',
      `Open a file as a LIVE EDITOR FRAME inside the chat (the Studio editor). The user sees the file
render next to any browser frames, and your edits appear there in near real-time. Use this to show
and work on a document/code/spreadsheet the user should see — not just read it silently.

Input:
- filePath: the file to open in an editor frame (required).

Returns the file's current content.`,
      {
        filePath: z.string().describe('Path of the file to open as an editor frame.'),
      },
      async ({ filePath }) => {
        try {
          editorFrames.open(filePath);
          const content = await editorIO.read(filePath);
          return textResult(`Opened editor frame for ${filePath}.\nCurrent content:\n${content}`);
        } catch (error) {
          return textResult(`Error opening editor: ${describeError(error)}`, true);
        }
      }
    );

    server.tool(
      'editor_read',
      `Read a file's current text WITHOUT opening a visible frame (silent read).

Input:
- filePath: the file to read (required).

Returns the file's text.`,
      {
        filePath: z.string().describe('Path of the file to read.'),
      },
      async ({ filePath }) => {
        try {
          const content = await editorIO.read(filePath);
          return textResult(content);
        } catch (error) {
          return textResult(`Error reading file: ${describeError(error)}`, true);
        }
      }
    );

    server.tool(
      'editor_write',
      `Replace a file's ENTIRE content. Writes are reflected live in the open editor frame for this
file (call editor_open first if you want the user to watch). Always pass the COMPLETE new file
content, not a diff.

Input:
- filePath: the file to write (required).
- content: the complete new file content (required).

Returns a confirmation with the byte count saved.`,
      {
        filePath: z.string().describe('Path of the file to write.'),
        content: z.string().describe('The COMPLETE new file content (not a diff).'),
      },
      async ({ filePath, content }) => {
        try {
          await editorIO.write(filePath, content);
          // Ensure a frame exists + bump its version so the renderer reloads it.
          editorFrames.open(filePath);
          editorFrames.touch(filePath);
          return textResult(`Saved ${content.length} chars to ${filePath}.`);
        } catch (error) {
          return textResult(`Error writing file: ${describeError(error)}`, true);
        }
      }
    );

    server.tool(
      'editor_close',
      `Close an open editor frame (the file is left on disk; only the in-chat frame is removed).

Input:
- filePath: the file whose frame to close (required).`,
      {
        filePath: z.string().describe('Path of the editor frame to close.'),
      },
      ({ filePath }) => {
        editorFrames.close(filePath);
        return textResult(`Closed editor frame for ${filePath}.`);
      }
    );

    server.tool(
      'editor_list',
      `List the editor frames currently open in the chat.

Returns a JSON array of { filePath, title }.`,
      {},
      () => {
        const payload = editorFrames.list().map((f) => ({ filePath: f.filePath, title: f.title }));
        return textResult(JSON.stringify(payload, null, 2));
      }
    );
  }

  return server;
};

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * On-demand page perception for the embedded browser agent (Requirement 1 —
 * "Tích hợp trình duyệt và tác nhân duyệt web", criteria 1.4 and 1.9).
 *
 * The browsing agent does not need the same depth of information for every step,
 * so perception is split into **three layers that are paid for only when used**
 * (criterion 1.4). They map one-to-one onto the table in `design.md`:
 *
 * | Layer            | How                                                        | Cost                         | Lease?                       |
 * | ---------------- | ---------------------------------------------------------- | ---------------------------- | ---------------------------- |
 * | a) Text / DOM    | `executeJavaScript` → page text + a lightweight a11y tree  | Light — the **default**      | No (cheap, read-only DOM)    |
 * | b) Screenshot    | `capturePage()` → PNG / data-URL for a vision model        | Medium                       | **Yes** — `kind: 'browser'`  |
 * | c) Audio / Video | delegate to {@link IMediaPipeline} (summarise / transcribe)| Heavy                        | Yes — owned by `mediaPipeline` |
 *
 * Because layers (b) and (c) are heavy, they MUST go through the
 * ResourceCoordinator (criterion 1.9). Screenshot/vision capture acquires a
 * `'browser'` lease here and releases it in a `try/finally`; the media layer's
 * leases are acquired *inside* {@link IMediaPipeline} (it wraps every ffmpeg /
 * transcribe / summarise step), so this module simply delegates to it.
 *
 * ## Process boundary
 *
 * This is a **Main-process (Node.js / Electron) module — no DOM APIs at module
 * scope.** The DOM-reading snippets are plain **strings** handed to
 * {@link PageDriver.executeJavaScript}; that code runs *inside the page* (where
 * `document` exists), never in Node. Nothing here touches `document` directly.
 *
 * ## Testability (no Electron required)
 *
 * Every collaborator is injected via {@link PagePerceptionDeps}:
 *  - {@link PageDriver} is a **structural subset** of Electron's `WebContents`
 *    (just `executeJavaScript` + `capturePage`), so the real
 *    `browserViewManager.getWebContents(tabId)` satisfies it directly while unit
 *    tests pass a tiny fake;
 *  - {@link LeaseCoordinator} is the same minimal `{ requestLease, releaseLease }`
 *    surface the real `ResourceCoordinator` satisfies structurally;
 *  - {@link IMediaPipeline} is injected for the audio/video layer.
 *
 * The DI style mirrors `mediaPipeline.ts` and `browserViewManager.ts`.
 */

import type { BrowserTabId } from './browserViewManager';
import type { IMediaPipeline, MediaSource, MediaSummary, TranscribeOptions, TranscriptResult } from './mediaPipeline';
import type { Lease, LeaseRequest, TaskKind } from '../resource/leaseTypes';

// ---------------------------------------------------------------------------
// Injected collaborators (interfaces only — no Electron dependency)
// ---------------------------------------------------------------------------

/**
 * The size of a captured image, in device pixels. Mirrors Electron's `Size`
 * (`NativeImage.getSize()`) so a real `NativeImage` satisfies {@link CapturedImage}.
 */
export type ImageSize = {
  /** Image width in device pixels. */
  width: number;
  /** Image height in device pixels. */
  height: number;
};

/**
 * Minimal structural subset of Electron's `NativeImage` that the screenshot
 * layer consumes. A real `NativeImage` satisfies this (it has all these methods
 * plus more), and tests can supply a tiny fake. PNG bytes are typed as
 * `Uint8Array` (which `Buffer` extends) to avoid depending on Node's `Buffer`.
 */
export type CapturedImage = {
  /** Encode the image as a `data:image/png;base64,...` URL (vision-model ready). */
  toDataURL(): string;
  /** Encode the image as raw PNG bytes. */
  toPNG(): Uint8Array;
  /** Image dimensions in device pixels. */
  getSize(): ImageSize;
  /** Whether the image is empty (e.g. capture failed). */
  isEmpty(): boolean;
};

/**
 * Minimal structural subset of Electron's `WebContents` needed to perceive a
 * page. Declared locally (rather than importing `WebContents`) so this module
 * has **no** Electron dependency and stays unit-testable. The real
 * `WebContents` is assignable to this because it exposes both methods with
 * compatible signatures.
 */
export type PageDriver = {
  /**
   * Evaluate `code` in the page's main world and resolve with its result. The
   * `code` is a string that runs *in the page* (where `document` exists).
   */
  executeJavaScript(code: string): Promise<unknown>;
  /** Capture the current page as an image for the vision layer. */
  capturePage(): Promise<CapturedImage>;
};

/**
 * Minimal subset of the ResourceCoordinator used by the screenshot layer. The
 * real `IResourceCoordinator` satisfies this structurally, so it can be passed
 * directly; tests inject a lightweight fake. Mirrors `mediaPipeline.ts`.
 */
export type LeaseCoordinator = {
  /** Request a lease for a heavy task; resolves when the budget allows. */
  requestLease: (req: LeaseRequest) => Promise<Lease>;
  /** Release a previously granted lease by id. */
  releaseLease: (id: string) => void;
};

// ---------------------------------------------------------------------------
// Public data models
// ---------------------------------------------------------------------------

/**
 * A node in the lightweight accessibility tree produced by the text/DOM layer.
 * This is **not** Chromium's full accessibility tree (which is not reachable via
 * `executeJavaScript`); it is a compact, JSON-serialisable approximation built
 * from ARIA roles and accessible names — enough for the agent to locate and
 * reason about interactive elements cheaply.
 */
export type AccessibilityNode = {
  /** ARIA role (explicit `role` attribute, else the lowercased tag name). */
  role: string;
  /** Accessible name: `aria-label`, `alt`, `title`, or trimmed text content. */
  name: string;
  /** Form value for inputs/selects/textareas, when present. */
  value?: string;
  /** Child nodes, in document order (bounded by depth/breadth limits). */
  children: AccessibilityNode[];
};

/** Result of the screenshot/vision layer ({@link IPagePerception.capture}). */
export type CaptureResult = {
  /** `data:image/png;base64,...` URL, directly consumable by a vision model. */
  dataUrl: string;
  /** Raw PNG bytes, for callers that prefer a binary payload. */
  png: Uint8Array;
  /** Captured image width in device pixels. */
  width: number;
  /** Captured image height in device pixels. */
  height: number;
};

/**
 * What the audio/video layer should do with a {@link MediaSource}. Discriminated
 * by `action` so {@link IPagePerception.perceiveMedia} stays type-safe while
 * delegating to the matching {@link IMediaPipeline} method.
 */
export type MediaPerceptionRequest =
  | {
      /** Summarise the media (YouTube fast path or transcript fallback). */
      action: 'summarize';
      /** The media to perceive. */
      source: MediaSource;
      /** Optional transcription options forwarded to the pipeline. */
      options?: TranscribeOptions;
    }
  | {
      /** Transcribe the media into timestamped segments. */
      action: 'transcribe';
      /** The media to perceive. */
      source: MediaSource;
      /** Optional transcription options forwarded to the pipeline. */
      options?: TranscribeOptions;
    };

/** Result of {@link IPagePerception.perceiveMedia}, discriminated by `action`. */
export type MediaPerceptionResult =
  | {
      /** Matches a `'summarize'` request. */
      action: 'summarize';
      /** The summary produced by the pipeline. */
      summary: MediaSummary;
    }
  | {
      /** Matches a `'transcribe'` request. */
      action: 'transcribe';
      /** The transcript produced by the pipeline. */
      transcript: TranscriptResult;
    };

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * The three on-demand perception layers for one embedded browser. Each method
 * resolves the target tab's {@link PageDriver} via the injected accessor, so an
 * unknown/destroyed tab fails fast with a descriptive error.
 */
export type IPagePerception = {
  /**
   * **Layer (a) — light, default.** Read visible text from the page, optionally
   * scoped to the first element matching `selector`. No lease (cheap DOM read).
   *
   * @param tabId    The tab to read.
   * @param selector Optional CSS selector; when omitted, the whole `<body>`.
   * @returns The element's rendered text (empty string if nothing matched).
   * @throws if the tab is unknown or already destroyed.
   */
  readText(tabId: BrowserTabId, selector?: string): Promise<string>;

  /**
   * **Layer (a) — light, default.** Build a compact accessibility tree (role /
   * name / value) from the page's DOM. No lease (cheap DOM read).
   *
   * @param tabId The tab to inspect.
   * @returns The root {@link AccessibilityNode} of the page.
   * @throws if the tab is unknown or already destroyed.
   */
  readAccessibilityTree(tabId: BrowserTabId): Promise<AccessibilityNode>;

  /**
   * **Layer (b) — medium, vision.** Capture the page as an image for a vision
   * model. Heavy, so it is wrapped in a `'browser'` {@link Lease} that is always
   * released in a `try/finally` (criteria 1.4b and 1.9).
   *
   * @param tabId The tab to capture.
   * @returns The captured image as a data-URL + PNG bytes + size.
   * @throws if the tab is unknown/destroyed, or if the capture is empty.
   */
  capture(tabId: BrowserTabId): Promise<CaptureResult>;

  /**
   * **Layer (c) — heavy, audio/video.** Delegate media perception to the injected
   * {@link IMediaPipeline}. The pipeline owns its own ResourceCoordinator leases
   * (criterion 1.9), so this method does not acquire one itself.
   *
   * @param request What to do and the media source.
   * @returns The pipeline result, discriminated by the request `action`.
   */
  perceiveMedia(request: MediaPerceptionRequest): Promise<MediaPerceptionResult>;
};

// ---------------------------------------------------------------------------
// Dependencies + defaults
// ---------------------------------------------------------------------------

/** Injected dependencies and tunables for {@link createPagePerception}. */
export type PagePerceptionDeps = {
  /**
   * Resolve the {@link PageDriver} for a tab. In production this is
   * `browserViewManager.getWebContents` (a `WebContents` satisfies
   * {@link PageDriver}); returns `undefined` for unknown/destroyed tabs.
   */
  getWebContents: (tabId: BrowserTabId) => PageDriver | undefined;
  /** The media pipeline backing the audio/video layer. */
  mediaPipeline: IMediaPipeline;
  /** Lease gate for the screenshot/vision layer (criterion 1.9). */
  coordinator: LeaseCoordinator;
  /** Estimated RAM cost (MB) charged while a screenshot capture runs. */
  captureCostMB?: number;
  /** Lease kind for screenshot/vision capture. Defaults to `'browser'`. */
  captureLeaseKind?: TaskKind;
  /** Max recursion depth for {@link IPagePerception.readAccessibilityTree}. */
  accessibilityMaxDepth?: number;
};

/** Default estimated RAM cost (MB) for one screenshot capture (medium weight). */
const DEFAULT_CAPTURE_COST_MB = 256;

/** Default lease kind for screenshot/vision capture (criterion 1.9). */
const DEFAULT_CAPTURE_LEASE_KIND: TaskKind = 'browser';

/** Default maximum depth walked when building the accessibility tree. */
const DEFAULT_ACCESSIBILITY_MAX_DEPTH = 24;

// ---------------------------------------------------------------------------
// In-page snippets (run in the page via executeJavaScript — NOT in Node)
// ---------------------------------------------------------------------------

/**
 * Build the in-page snippet that reads rendered text, optionally scoped to a
 * selector. The selector is embedded via `JSON.stringify` so it is safely
 * escaped and cannot break out of the string literal.
 *
 * @param selector Optional CSS selector; when omitted, reads `<body>`.
 * @returns A self-invoking expression string for `executeJavaScript`.
 */
const buildReadTextScript = (selector?: string): string => {
  const selectorLiteral = selector === undefined ? 'null' : JSON.stringify(selector);
  return `(() => {
  const selector = ${selectorLiteral};
  const el = selector ? document.querySelector(selector) : document.body;
  if (!el) return '';
  const text = el.innerText !== undefined && el.innerText !== null ? el.innerText : el.textContent;
  return text ? String(text).trim() : '';
})()`;
};

/**
 * Build the in-page snippet that produces a compact accessibility tree. The
 * walk is bounded by `maxDepth` (and skips invisible / script / style nodes) so
 * the serialised payload stays small even on large pages.
 *
 * @param maxDepth Maximum recursion depth.
 * @returns A self-invoking expression string for `executeJavaScript`.
 */
const buildAccessibilityScript = (maxDepth: number): string => `(() => {
  const MAX_DEPTH = ${maxDepth};
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK']);
  const isHidden = (el) => {
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden') return true;
    return el.getAttribute('aria-hidden') === 'true';
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const alt = el.getAttribute('alt');
    if (alt) return alt.trim();
    const title = el.getAttribute('title');
    if (title) return title.trim();
    const own = Array.from(el.childNodes)
      .filter((n) => n.nodeType === 3)
      .map((n) => (n.textContent || '').trim())
      .join(' ')
      .trim();
    return own;
  };
  const valueOf = (el) => {
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      return el.value || undefined;
    }
    return undefined;
  };
  const build = (el, depth) => {
    const node = {
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      name: nameOf(el),
      children: [],
    };
    const value = valueOf(el);
    if (value !== undefined) node.value = value;
    if (depth < MAX_DEPTH) {
      for (const child of Array.from(el.children)) {
        if (SKIP.has(child.tagName) || isHidden(child)) continue;
        node.children.push(build(child, depth + 1));
      }
    }
    return node;
  };
  const root = document.body || document.documentElement;
  return build(root, 0);
})()`;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an {@link IPagePerception} from injected collaborators.
 *
 * @param deps Page-driver accessor, media pipeline, lease coordinator and tunables.
 * @returns A ready-to-use three-layer page perceiver.
 *
 * @example
 * ```ts
 * const perception = createPagePerception({
 *   getWebContents: (id) => browserViewManager.getWebContents(id),
 *   mediaPipeline,
 *   coordinator: resourceCoordinator,
 * });
 * const text = await perception.readText(tabId);          // layer (a), no lease
 * const shot = await perception.capture(tabId);           // layer (b), 'browser' lease
 * ```
 */
export const createPagePerception = (deps: PagePerceptionDeps): IPagePerception => {
  const { getWebContents, mediaPipeline, coordinator } = deps;
  const captureCostMB = deps.captureCostMB ?? DEFAULT_CAPTURE_COST_MB;
  const captureLeaseKind = deps.captureLeaseKind ?? DEFAULT_CAPTURE_LEASE_KIND;
  const accessibilityMaxDepth = deps.accessibilityMaxDepth ?? DEFAULT_ACCESSIBILITY_MAX_DEPTH;

  /** Resolve a live {@link PageDriver} or throw a descriptive error. */
  const requireDriver = (tabId: BrowserTabId): PageDriver => {
    const driver = getWebContents(tabId);
    if (!driver) {
      throw new Error(`[PagePerception] No web contents for tab: ${tabId}`);
    }
    return driver;
  };

  const readText = async (tabId: BrowserTabId, selector?: string): Promise<string> => {
    // Layer (a): light DOM read — no lease required (criterion 1.4a).
    const driver = requireDriver(tabId);
    const result = await driver.executeJavaScript(buildReadTextScript(selector));
    return typeof result === 'string' ? result : '';
  };

  const readAccessibilityTree = async (tabId: BrowserTabId): Promise<AccessibilityNode> => {
    // Layer (a): light DOM read — no lease required (criterion 1.4a).
    const driver = requireDriver(tabId);
    const result = await driver.executeJavaScript(buildAccessibilityScript(accessibilityMaxDepth));
    return result as AccessibilityNode;
  };

  const capture = async (tabId: BrowserTabId): Promise<CaptureResult> => {
    // Layer (b): heavy vision capture — resolve the tab first (cheap, avoids
    // wasting a lease on an impossible request), then gate the capture behind a
    // 'browser' lease that is ALWAYS released in finally (criteria 1.4b, 1.9).
    const driver = requireDriver(tabId);
    const lease = await coordinator.requestLease({ kind: captureLeaseKind, estCostMB: captureCostMB });
    try {
      const image = await driver.capturePage();
      if (image.isEmpty()) {
        throw new Error(`[PagePerception] Captured an empty image for tab: ${tabId}`);
      }
      const size = image.getSize();
      return { dataUrl: image.toDataURL(), png: image.toPNG(), width: size.width, height: size.height };
    } finally {
      coordinator.releaseLease(lease.id);
    }
  };

  const perceiveMedia = async (request: MediaPerceptionRequest): Promise<MediaPerceptionResult> => {
    // Layer (c): delegate to the media pipeline, which owns its own heavy-step
    // leases (criterion 1.9), so no lease is acquired here.
    switch (request.action) {
      case 'summarize': {
        const summary = await mediaPipeline.summarizeVideo(request.source, request.options);
        return { action: 'summarize', summary };
      }
      case 'transcribe': {
        const transcript = await mediaPipeline.transcribe(request.source, request.options);
        return { action: 'transcribe', transcript };
      }
    }
  };

  return { readText, readAccessibilityTree, capture, perceiveMedia };
};

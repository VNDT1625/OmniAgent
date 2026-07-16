/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Readability-style main-content extraction for the embedded browser's research
 * flows. Reading `document.body.innerText` wholesale drags in navigation, ads,
 * menus, footers and cookie banners, which pollutes downstream summaries. This
 * module instead applies a lightweight Readability-style heuristic to isolate
 * the **article body** before the agent summarises it.
 *
 * ## Process boundary
 *
 * This is a **Main-process (Node.js / Electron) module — no DOM APIs at module
 * scope.** The DOM-reading logic lives entirely inside {@link READABILITY_SCRIPT},
 * a plain **string** handed to {@link ReadabilityDriver.executeJavaScript}; that
 * code runs *inside the page* (where `document` exists), never in Node. Nothing
 * here touches `document` directly. The pattern mirrors `pagePerception.ts`.
 *
 * ## Testability (no Electron required)
 *
 * The only collaborator is injected via {@link ReadabilityDriver}, a structural
 * subset of Electron's `WebContents` (just `executeJavaScript`). The real
 * `WebContents` satisfies it directly, while unit tests can pass a tiny fake
 * that returns canned values.
 */

// ---------------------------------------------------------------------------
// Public data models
// ---------------------------------------------------------------------------

/**
 * The extracted main content of a page. Every field is JSON-serialisable so it
 * survives the `executeJavaScript` boundary unchanged.
 */
export type ReadableContent = {
  /** Page/article title (`og:title`, else `document.title`, else first `<h1>`). */
  title: string;
  /** The main readable body text, whitespace-collapsed and capped in length. */
  text: string;
  /** Author/byline when detectable (meta author or a `.byline`/`.author` node). */
  byline: string;
  /** A short summary/description (`meta description`, else the text head). */
  excerpt: string;
  /** Character length of {@link ReadableContent.text}. */
  length: number;
};

/**
 * Minimal structural subset of Electron's `WebContents` needed to extract
 * readable content. Declared locally (rather than importing `WebContents`) so
 * this module has **no** Electron dependency and stays unit-testable. The real
 * `WebContents` is assignable to this because it exposes `executeJavaScript`
 * with a compatible signature.
 */
export type ReadabilityDriver = {
  /**
   * Evaluate `code` in the page's main world and resolve with its result. The
   * `code` is a string that runs *in the page* (where `document` exists).
   */
  executeJavaScript(code: string): Promise<unknown>;
};

// ---------------------------------------------------------------------------
// In-page snippet (runs in the page via executeJavaScript — NOT in Node)
// ---------------------------------------------------------------------------

/**
 * Self-invoking expression that runs **inside the page** and returns a
 * JSON-serialisable {@link ReadableContent}. The whole thing is wrapped in
 * `try/catch` so it NEVER throws across the `executeJavaScript` boundary — on
 * any failure it returns `{ title: '', text: '', byline: '', excerpt: '', length: 0 }`.
 *
 * Heuristic (Readability-style):
 *  - prefer `<article>`, else `<main>`, else the highest text-density candidate
 *    among `p`, `article`, `section`, `div`;
 *  - density score = total paragraph text length minus a penalty for
 *    link-heavy nodes and nodes with many descendants;
 *  - work on a **clone** of the body so the live page is never mutated, stripping
 *    `script,style,nav,header,footer,aside,form,[role=navigation],[aria-hidden=true]`
 *    plus any element whose class/id matches the junk pattern
 *    (`nav|menu|footer|header|sidebar|ad|promo|cookie|banner|comment|share|related|social`);
 *  - title from `og:title`, else `document.title`, else the first `<h1>`;
 *  - text uses `innerText` (which, on the detached clone, yields `textContent`
 *    semantics per the HTML spec), whitespace-collapsed and capped at 50000 chars.
 *
 * NOTE: this is authored as a template literal, so it must contain **no**
 * backticks and **no** `${...}` interpolation. Regex backslashes are doubled
 * (e.g. `\\s+`) so the literal yields the intended `\s+` in-page.
 */
export const READABILITY_SCRIPT: string = `(() => {
  try {
    var MAX_TEXT = 50000;
    var JUNK_RE = /nav|menu|footer|header|sidebar|ad|promo|cookie|banner|comment|share|related|social/i;
    var STRIP_SELECTOR = 'script,style,nav,header,footer,aside,form,[role=navigation],[aria-hidden=true]';

    var collapse = function (value) {
      if (value === undefined || value === null) return '';
      return String(value).replace(/\\s+/g, ' ').trim();
    };

    var textOf = function (el) {
      if (!el) return '';
      var raw = (el.innerText !== undefined && el.innerText !== null) ? el.innerText : el.textContent;
      return collapse(raw);
    };

    var attrContent = function (selector) {
      var node = document.querySelector(selector);
      if (!node) return '';
      var content = node.getAttribute('content');
      return content ? collapse(content) : '';
    };

    var getTitle = function () {
      var og = attrContent('meta[property="og:title"]');
      if (og) return og;
      if (document.title) return collapse(document.title);
      var h1 = document.querySelector('h1');
      return h1 ? textOf(h1) : '';
    };

    var getByline = function () {
      var metaAuthor = attrContent('meta[name="author"]') || attrContent('meta[property="article:author"]');
      if (metaAuthor) return metaAuthor;
      var node = document.querySelector('[rel=author]') || document.querySelector('.byline') || document.querySelector('.author');
      return node ? textOf(node) : '';
    };

    var getExcerpt = function (fallbackText) {
      var desc = attrContent('meta[name="description"]') || attrContent('meta[property="og:description"]');
      if (desc) return desc;
      return fallbackText ? fallbackText.slice(0, 280) : '';
    };

    var classAndId = function (el) {
      var cls = (el.className && typeof el.className === 'string') ? el.className : '';
      var id = (el.id && typeof el.id === 'string') ? el.id : '';
      return cls + ' ' + id;
    };

    var isJunk = function (el) {
      return JUNK_RE.test(classAndId(el));
    };

    var scoreOf = function (el) {
      var paragraphs = el.querySelectorAll('p');
      var textLength = 0;
      for (var p = 0; p < paragraphs.length; p++) {
        textLength += collapse(paragraphs[p].textContent).length;
      }
      if (textLength === 0) textLength = collapse(el.textContent).length;
      var links = el.querySelectorAll('a');
      var linkLength = 0;
      for (var a = 0; a < links.length; a++) {
        linkLength += collapse(links[a].textContent).length;
      }
      var descendants = el.getElementsByTagName('*').length;
      var penalty = (linkLength * 2) + descendants;
      return textLength - penalty;
    };

    var root = document.body || document.documentElement;
    if (!root) return { title: '', text: '', byline: '', excerpt: '', length: 0 };

    var clone = root.cloneNode(true);

    var stripped = clone.querySelectorAll(STRIP_SELECTOR);
    for (var s = 0; s < stripped.length; s++) {
      var dead = stripped[s];
      if (dead && dead.parentNode) dead.parentNode.removeChild(dead);
    }

    var everything = clone.querySelectorAll('*');
    for (var e = 0; e < everything.length; e++) {
      var node = everything[e];
      if (node && node.parentNode && isJunk(node)) node.parentNode.removeChild(node);
    }

    var chosen = clone.querySelector('article') || clone.querySelector('main');
    if (!chosen) {
      var candidates = clone.querySelectorAll('p, article, section, div');
      var best = null;
      var bestScore = -Infinity;
      for (var c = 0; c < candidates.length; c++) {
        var candidate = candidates[c];
        var score = scoreOf(candidate);
        if (score > bestScore) {
          bestScore = score;
          best = candidate;
        }
      }
      chosen = best || clone;
    }

    var text = textOf(chosen);
    if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT);

    return {
      title: getTitle(),
      text: text,
      byline: getByline(),
      excerpt: getExcerpt(text),
      length: text.length,
    };
  } catch (err) {
    return { title: '', text: '', byline: '', excerpt: '', length: 0 };
  }
})()`;

// ---------------------------------------------------------------------------
// Coercion helpers (Node side — validate the untrusted in-page result)
// ---------------------------------------------------------------------------

/** Canonical empty result, returned whenever extraction yields nothing usable. */
const EMPTY_CONTENT: ReadableContent = { title: '', text: '', byline: '', excerpt: '', length: 0 };

/** Coerce an unknown field into a safe string (empty string when not a string). */
const toStringField = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * Coerce the untrusted result of {@link READABILITY_SCRIPT} into a
 * {@link ReadableContent}, validating every field and defaulting to empty/0.
 *
 * @param value The raw value returned across the `executeJavaScript` boundary.
 * @returns A fully-typed, safe {@link ReadableContent}.
 */
const coerceReadable = (value: unknown): ReadableContent => {
  if (typeof value !== 'object' || value === null) {
    return { ...EMPTY_CONTENT };
  }
  const record = value as Record<string, unknown>;
  const length = typeof record.length === 'number' && Number.isFinite(record.length) ? record.length : 0;
  return {
    title: toStringField(record.title),
    text: toStringField(record.text),
    byline: toStringField(record.byline),
    excerpt: toStringField(record.excerpt),
    length,
  };
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract the main readable content of the page currently loaded in `driver`.
 *
 * Runs {@link READABILITY_SCRIPT} in the page and safely coerces the result. The
 * in-page script never throws; this function additionally guards the
 * `executeJavaScript` call itself, so it always resolves with a valid
 * {@link ReadableContent} (empty/0 on any failure).
 *
 * @param driver A page driver (a real Electron `WebContents` satisfies it).
 * @returns The extracted {@link ReadableContent}, never rejecting.
 *
 * @example
 * ```ts
 * const content = await extractReadable(webContents);
 * console.log(content.title, content.length);
 * ```
 */
export const extractReadable = async (driver: ReadabilityDriver): Promise<ReadableContent> => {
  try {
    const result = await driver.executeJavaScript(READABILITY_SCRIPT);
    return coerceReadable(result);
  } catch {
    return { ...EMPTY_CONTENT };
  }
};

/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `onlyOfficeConnector` — a thin, promise-based wrapper over the ONLYOFFICE
 * editor's **Automation API connector** (`docEditor.createConnector()`), plus a
 * per-file registry so the Studio AI panel can drive the *live* editor.
 *
 * Why a registry: `OnlyOfficeEditor` mounts the editor deep inside an adapter,
 * while the AI panel lives in `StudioEditorView`. Rather than prop-drilling the
 * connector up, the editor registers its connector keyed by `filePath`, and the
 * AI agent looks it up. When the editor unmounts it unregisters.
 *
 * The connector runs commands *inside the open editor* (locally), so each tool
 * call applies in well under a second and the document keeps its full
 * formatting — this is what makes "AI edits the doc with fast tools" real (vs.
 * round-tripping the whole binary through the Document Server).
 *
 * Design note — reliability over cleverness: WRITES go through `executeMethod`
 * with plain-data arguments (JSON-serializable, no closure capture). READS use
 * `callCommand` whose function body references ONLY the editor-global `Api` (no
 * external data), which is the safe case for the isolated command realm. We
 * deliberately avoid the `Asc.scope` closure trick, which is brittle across
 * versions.
 *
 * Renderer-only. No Node.js APIs.
 */

/** The subset of the ONLYOFFICE connector object we use. */
export type OnlyOfficeConnector = {
  /** Run an Office JS API command inside the editor; callback gets the return. */
  callCommand: (commandFn: () => unknown, callback?: (ret: unknown) => void, isNoCalc?: boolean) => void;
  /** Execute a named editor method with args; callback gets the result. */
  executeMethod: (name: string, args?: unknown[], callback?: (ret: unknown) => void) => void;
  /** Disconnect the connector (on teardown). */
  disconnect?: () => void;
};

/** Document family the tools branch on. */
export type OfficeDocKind = 'word' | 'cell' | 'slide';

/** A live connector handle plus the document kind it edits. */
type ConnectorEntry = { connector: OnlyOfficeConnector; kind: OfficeDocKind };

const registry = new Map<string, ConnectorEntry>();
const waiters = new Map<string, Array<(entry: ConnectorEntry) => void>>();

/** Register a live connector for `filePath` (called by the editor when ready). */
export const registerConnector = (filePath: string, connector: OnlyOfficeConnector, kind: OfficeDocKind): void => {
  const entry = { connector, kind };
  registry.set(filePath, entry);
  const pending = waiters.get(filePath);
  if (pending) {
    waiters.delete(filePath);
    for (const resolve of pending) resolve(entry);
  }
};

/** Remove a connector (called by the editor on unmount). */
export const unregisterConnector = (filePath: string): void => {
  registry.delete(filePath);
};

/** Whether a live connector exists for `filePath`. */
export const hasConnector = (filePath: string): boolean => registry.has(filePath);

/** The document kind of a registered connector, or null when none. */
export const connectorKind = (filePath: string): OfficeDocKind | null => registry.get(filePath)?.kind ?? null;

/** Normalise a path for tolerant matching: forward slashes, no trailing slash, lower-case. */
const normalizePath = (p: string): string => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/**
 * Resolve the REGISTERED connector path that best matches `filePath`, tolerating
 * the mismatches that break a naive `registry.has()` check:
 *  1. exact key match;
 *  2. separator/case-insensitive match (Windows `\` vs `/`, drive-letter case);
 *  3. basename match (the agent passed a different directory but the same file),
 *     only when it is unambiguous;
 *  4. single-open-editor fallback (only one Office doc is open, so any path the
 *     agent passes must mean that one) — mirrors how the browser-control server
 *     falls back to the single open tab.
 *
 * Returns the registered key to use with the tool functions, or null when no
 * live connector can be matched.
 */
export const resolveConnectorPath = (filePath: string): string | null => {
  if (registry.has(filePath)) return filePath;
  const keys = [...registry.keys()];
  if (keys.length === 0) return null;

  const target = normalizePath(filePath);
  const exact = keys.find((k) => normalizePath(k) === target);
  if (exact) return exact;

  const base = target.slice(target.lastIndexOf('/') + 1);
  if (base.length > 0) {
    const byBase = keys.filter((k) => {
      const nk = normalizePath(k);
      return nk === base || nk.endsWith('/' + base);
    });
    if (byBase.length === 1) return byBase[0];
  }

  // Only one Office editor is open → any path the agent passes means that one.
  if (keys.length === 1) return keys[0];
  return null;
};

/** Resolve the connector for `filePath`, waiting up to `timeoutMs` for it. */
const awaitEntry = (filePath: string, timeoutMs = 15000): Promise<ConnectorEntry> => {
  // Tolerant match first (separator/case/basename/single-editor), then exact key.
  const resolvedKey = resolveConnectorPath(filePath);
  const existing = registry.get(resolvedKey ?? filePath);
  if (existing) return Promise.resolve(existing);
  return new Promise<ConnectorEntry>((resolve, reject) => {
    const onResolve = (entry: ConnectorEntry): void => {
      clearTimeout(timer);
      resolve(entry);
    };
    const timer = setTimeout(() => {
      const list = waiters.get(filePath);
      if (list)
        waiters.set(
          filePath,
          list.filter((r) => r !== onResolve)
        );
      reject(new Error('The Office editor is not ready yet. Open the document in "Edit (Office)" mode first.'));
    }, timeoutMs);
    const list = waiters.get(filePath) ?? [];
    list.push(onResolve);
    waiters.set(filePath, list);
  });
};

const OFFICE_COMMAND_TIMEOUT_MS = 12000;

const callbackOperation = <T>(label: string, start: (done: (value: T) => void) => void): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`${label} timed out after ${Math.round(OFFICE_COMMAND_TIMEOUT_MS / 1000)}s.`));
    }, OFFICE_COMMAND_TIMEOUT_MS);

    const done = (value: T): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    try {
      start(done);
    } catch (error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    }
  });

/** Promise wrapper around `callCommand`. The fn body runs in the editor context. */
const callCommand = (connector: OnlyOfficeConnector, commandFn: () => unknown, isNoCalc = false): Promise<unknown> =>
  callbackOperation('Office editor command', (done) => {
    connector.callCommand(commandFn, done, isNoCalc);
  });

/** Promise wrapper around `executeMethod`. */
const executeMethod = (connector: OnlyOfficeConnector, name: string, args: unknown[] = []): Promise<unknown> =>
  callbackOperation(`Office editor method "${name}"`, (done) => {
    connector.executeMethod(name, args, done);
  });

/**
 * Hand a plain-data value to the isolated command realm via the editor-global
 * `Asc.scope` (the ONLYOFFICE-documented channel for passing data into
 * `callCommand`). The command bodies read it back as `Asc.scope.<key>`. We
 * create the `Asc`/`scope` containers defensively so the first write can't throw
 * when the editor hasn't seeded them yet.
 */
const setAscScope = (key: string, value: unknown): void => {
  const g = globalThis as unknown as { Asc?: { scope?: Record<string, unknown> } };
  if (!g.Asc) g.Asc = {};
  if (!g.Asc.scope) g.Asc.scope = {};
  g.Asc.scope[key] = value;
};

/**
 * Run an editor command with DATA embedded directly into the command's source —
 * the transport-independent way to pass plain data into the isolated command
 * realm. The connector serializes the command function via `toString()` and
 * re-evaluates it in the editor; we therefore build the function from a string
 * with the data baked in as a JSON literal (`var DATA = {...}`), so it does NOT
 * rely on `Asc.scope` mirroring (which only the plugin transport guarantees).
 *
 * `bodySource` is a JS function body string that may use `DATA` (the parsed
 * value) and the editor globals `Api` / `Asc`, and may `return` a JSON value.
 */
const callWithData = async (connector: OnlyOfficeConnector, data: unknown, bodySource: string): Promise<unknown> => {
  const json = JSON.stringify(data ?? null);
  // eslint-disable-next-line no-new-func
  const fn = new Function(`"use strict";\nvar DATA = ${json};\n${bodySource}`) as () => unknown;
  return callbackOperation('Office editor command', (done) => {
    connector.callCommand(fn, done);
  });
};

/**
 * Read the document's plain text. The command body uses only the editor-global
 * `Api` (no captured data), which is safe in the isolated command realm.
 */
export const readText = async (filePath: string): Promise<string> => {
  const { connector, kind } = await awaitEntry(filePath);
  if (kind === 'word') {
    const out = await callCommand(connector, () => {
      const Api = (
        globalThis as unknown as { Api: { GetDocument: () => { GetRange: () => { GetText: () => string } } } }
      ).Api;
      const range = Api.GetDocument().GetRange();
      return range && typeof range.GetText === 'function' ? range.GetText() : '';
    });
    return typeof out === 'string' ? out : '';
  }
  if (kind === 'slide') {
    const out = await callCommand(connector, () => {
      type SlideEl = { GetText?: () => string };
      type Slide = {
        GetAllDrawings?: () => Array<{
          GetContent?: () => { GetElementsCount: () => number; GetElement: (j: number) => SlideEl };
        }>;
      };
      const Api = (
        globalThis as unknown as {
          Api: { GetPresentation: () => { GetSlidesCount: () => number; GetSlideByIndex: (i: number) => Slide } };
        }
      ).Api;
      const pres = Api.GetPresentation();
      const slideCount = pres.GetSlidesCount();
      const parts: string[] = [];
      for (let s = 0; s < slideCount; s++) {
        const slide = pres.GetSlideByIndex(s);
        const drawings = slide.GetAllDrawings ? slide.GetAllDrawings() : [];
        const slideParts: string[] = [];
        for (const drawing of drawings) {
          const content = drawing.GetContent ? drawing.GetContent() : null;
          if (!content) continue;
          const c = content.GetElementsCount();
          for (let j = 0; j < c; j++) {
            const el = content.GetElement(j);
            if (el && typeof el.GetText === 'function') slideParts.push(el.GetText());
          }
        }
        parts.push(`--- Slide ${s + 1} ---\n${slideParts.join('\n')}`);
      }
      return parts.join('\n\n');
    });
    return typeof out === 'string' ? out : '';
  }
  // cell
  const out = await callCommand(connector, () => {
    const Api = (
      globalThis as unknown as { Api: { GetActiveSheet: () => { GetUsedRange: () => { GetValue?: () => string } } } }
    ).Api;
    const sheet = Api.GetActiveSheet();
    const range = sheet.GetUsedRange();
    return range && typeof range.GetValue === 'function' ? range.GetValue() : '';
  });
  return typeof out === 'string' ? out : '';
};

/**
 * Replace the ENTIRE document body with `text` (newlines → paragraphs). Word
 * only — selecting all and pasting plain text via `executeMethod` (plain args,
 * reliable). For cell/slide a full rewrite would wreck layout, so it's blocked.
 */
export const replaceAllText = async (filePath: string, text: string): Promise<void> => {
  const { connector, kind } = await awaitEntry(filePath);
  if (kind !== 'word') {
    throw new Error(
      'Replacing the whole document is only supported for Word files. Use search & replace for sheets/slides.'
    );
  }
  // Select the whole body, then paste replacement text over the selection.
  await executeMethod(connector, 'MoveCursorToStart', []);
  await executeMethod(connector, 'PasteText', [text]);
};

/** Insert/paste text at the current cursor (replacing any selection). */
export const insertText = async (filePath: string, text: string): Promise<void> => {
  const { connector } = await awaitEntry(filePath);
  await executeMethod(connector, 'PasteText', [text]);
};

/** Insert HTML at the current cursor (richer formatting). */
export const insertHtml = async (filePath: string, html: string): Promise<void> => {
  const { connector } = await awaitEntry(filePath);
  await executeMethod(connector, 'PasteHtml', [html]);
};

/** Find/replace all occurrences of `search` with `replace`. Works for all kinds. */
export const searchReplace = async (filePath: string, search: string, replace: string): Promise<void> => {
  const { connector } = await awaitEntry(filePath);
  await executeMethod(connector, 'SearchAndReplace', [
    { searchString: search, replaceString: replace, matchCase: false },
  ]);
};

/** Append a paragraph at the end of the document. Word only. */
export const appendText = async (filePath: string, text: string): Promise<void> => {
  const { connector, kind } = await awaitEntry(filePath);
  if (kind !== 'word') {
    throw new Error('Appending text is only supported for Word files.');
  }
  await executeMethod(connector, 'MoveCursorToEnd', []);
  await executeMethod(connector, 'PasteText', [`\n${text}`]);
};

/**
 * Apply a built-in heading style to every paragraph whose trimmed text EXACTLY
 * matches one of `headings`. Word only. This is the real "select the heading →
 * choose Heading 1/2" action (via the editor's paragraph style API), so a
 * subsequent {@link insertTableOfContents} picks the paragraphs up.
 *
 * Data is passed into the isolated command realm via `Asc.scope` (the supported
 * channel for handing plain data to `callCommand`). `headings` maps an exact
 * paragraph text to a heading level (1–9).
 */
export const applyHeadings = async (
  filePath: string,
  headings: Array<{ text: string; level: number }>
): Promise<number> => {
  const { connector, kind } = await awaitEntry(filePath);
  if (kind !== 'word') {
    throw new Error('Applying heading styles is only supported for Word files.');
  }
  // Hand the heading map to the command realm via the GLOBAL Asc.scope.
  setAscScope('aionuiHeadings', headings);
  const out = await callCommand(connector, () => {
    type Para = {
      GetText?: () => string;
      SetStyle?: (style: unknown) => void;
    };
    type DocApi = {
      GetElementsCount: () => number;
      GetElement: (i: number) => Para;
      GetStyle: (name: string) => unknown;
    };
    const g = globalThis as unknown as {
      Api: { GetDocument: () => DocApi };
      Asc?: { scope?: { aionuiHeadings?: Array<{ text: string; level: number }> } };
    };
    const map = g.Asc?.scope?.aionuiHeadings ?? [];
    const want = new Map<string, number>();
    for (const h of map) want.set(h.text.trim(), h.level);
    const doc = g.Api.GetDocument();
    const count = doc.GetElementsCount();
    let applied = 0;
    for (let i = 0; i < count; i++) {
      const el = doc.GetElement(i);
      if (!el || typeof el.GetText !== 'function' || typeof el.SetStyle !== 'function') continue;
      const txt = (el.GetText() || '').trim();
      const level = want.get(txt);
      if (!level) continue;
      const style = doc.GetStyle(`Heading ${level}`);
      if (style) {
        el.SetStyle(style);
        applied++;
      }
    }
    return applied;
  });
  return typeof out === 'number' ? out : 0;
};

/**
 * Insert an automatic Table of Contents. Word only. Inserts at the cursor (move
 * it to the start first for a front-of-document TOC). The TOC is a real,
 * updatable field built from the document's Heading-styled paragraphs — exactly
 * what "Insert → Table of Contents" does.
 */
export const insertTableOfContents = async (filePath: string, atStart = true): Promise<void> => {
  const { connector, kind } = await awaitEntry(filePath);
  if (kind !== 'word') {
    throw new Error('A table of contents is only supported for Word files.');
  }
  if (atStart) await executeMethod(connector, 'MoveCursorToStart', []);
  await callCommand(connector, () => {
    type DocWithToc = { AddTableOfContents?: (props?: unknown) => void };
    const g = globalThis as unknown as { Api: { GetDocument: () => DocWithToc } };
    const doc = g.Api.GetDocument();
    if (typeof doc.AddTableOfContents === 'function') {
      // Default props: show page numbers, right-align them, use heading levels 1–3.
      doc.AddTableOfContents({ ShowPageNumbers: true, RightAlignTab: true, OutlineRange: [1, 3] });
    }
  });
};

/**
 * Run an ARBITRARY ONLYOFFICE Automation/Builder API script inside the live
 * editor — the "do anything Office can do" escape hatch.
 *
 * The model's `code` string is turned into a function and executed in the
 * editor's command realm, where the global `Api` (and `Asc`) are available:
 *   - Word:        `Api.GetDocument()` → paragraphs, runs, tables, images,
 *                  charts, styles, sections, comments, bookmarks, …
 *   - Spreadsheet: `Api.GetActiveSheet()` / `Api.GetSheet(i)` → ranges, cells,
 *                  formulas, charts, formatting, …
 *   - Presentation:`Api.GetPresentation()` → slides, shapes, text, …
 *
 * The code may `return` a JSON-serializable value (string/number/boolean) which
 * is sent back as the observation. It runs sandboxed to the document — there is
 * NO access to Node, the filesystem, or the network from this realm.
 *
 * Building the function from a string is the supported way to feed model-authored
 * code to `callCommand`: the connector serializes the function via `toString()`
 * and re-evaluates it in the editor, so the code is embedded literally (no closure
 * capture needed).
 */
export const runOfficeScript = async (filePath: string, code: string): Promise<string> => {
  const { connector } = await awaitEntry(filePath);
  // eslint-disable-next-line no-new-func
  const fn = new Function(`"use strict";\n${code}`) as () => unknown;
  const out = await callCommand(connector, fn);
  if (out === undefined || out === null) return '';
  if (typeof out === 'string') return out;
  try {
    return JSON.stringify(out);
  } catch {
    return String(out);
  }
};

/**
 * Replace a SPECIFIC passage (Word only) located by an anchor, then write
 * `replacement` in its place — more reliable than `searchReplace` for editing
 * one passage because it (a) targets the FIRST match only and (b) can match a
 * long passage via a `from … to` anchor without needing the exact full text.
 *
 * Matching modes:
 *  - `find` alone: replace the first exact occurrence of `find`.
 *  - `find` + `until`: replace from the start of `find` THROUGH the end of the
 *    first following `until` (covers the whole passage in between). Use this for
 *    long paragraphs: pass the first words as `find` and the last words as
 *    `until`.
 *
 * Returns true if a passage was replaced.
 */
export const replacePassage = async (
  filePath: string,
  find: string,
  replacement: string,
  until?: string
): Promise<boolean> => {
  const { connector, kind } = await awaitEntry(filePath);
  if (kind !== 'word') throw new Error('Replacing a specific passage is only supported for Word files.');
  setAscScope('aionuiPassage', { find, replacement, until: until ?? null });
  const out = await callCommand(connector, () => {
    type Range = {
      GetStartPos?: () => unknown;
      GetEndPos?: () => unknown;
      Delete?: () => void;
      AddText?: (t: string) => void;
    };
    type Doc = {
      Search: (text: string, matchCase: boolean) => Range[];
      GetRange?: (start: unknown, end: unknown) => Range;
    };
    const g = globalThis as unknown as {
      Api: { GetDocument: () => Doc };
      Asc?: { scope?: { aionuiPassage?: { find: string; replacement: string; until: string | null } } };
    };
    const data = g.Asc?.scope?.aionuiPassage;
    if (!data) return false;
    const doc = g.Api.GetDocument();
    const startMatches = doc.Search(data.find, false) || [];
    if (startMatches.length === 0) return false;
    let target: Range | null = startMatches[0];

    // `from … to` mode: build a combined range from the first `find` match's
    // start to the first following `until` match's end.
    if (data.until && typeof doc.GetRange === 'function') {
      const endMatches = doc.Search(data.until, false) || [];
      if (endMatches.length > 0) {
        const startPos = startMatches[0].GetStartPos?.();
        const endPos = endMatches[endMatches.length > 0 ? 0 : 0].GetEndPos?.();
        const combined = startPos && endPos ? doc.GetRange(startPos, endPos) : null;
        if (combined) target = combined;
      }
    }

    if (!target || typeof target.Delete !== 'function' || typeof target.AddText !== 'function') return false;
    target.Delete();
    target.AddText(data.replacement);
    return true;
  });
  return out === true;
};
export type TextFormat = {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikeout?: boolean;
  /** Text color as a hex string, e.g. "#C00000". */
  color?: string;
  /** Highlight color as a hex string, e.g. "#FFFF00". */
  highlight?: string;
  /** Font size in points (half-points are NOT used here). */
  fontSize?: number;
  /** Font family name, e.g. "Times New Roman". */
  fontFamily?: string;
};

/** Parse a `#rrggbb` / `rrggbb` hex string to an {r,g,b} triple (or null). */
const hexToRgbLiteral = (hex: string): { r: number; g: number; b: number } | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
};

/**
 * Format every occurrence of `search` in the document (Word only) — bold,
 * italic, underline, strikeout, text color, highlight, font size, font family.
 * Uses the real `ApiDocument.Search` → `ApiRange.Set*` formatting API, so it is
 * exactly equivalent to selecting the text and applying formatting. Returns how
 * many occurrences were formatted.
 */
export const formatText = async (filePath: string, search: string, format: TextFormat): Promise<number> => {
  const { connector, kind } = await awaitEntry(filePath);
  if (kind !== 'word') throw new Error('Text formatting is only supported for Word files.');
  const rgb = format.color ? hexToRgbLiteral(format.color) : null;
  const hl = format.highlight ? hexToRgbLiteral(format.highlight) : null;
  setAscScope('aionuiFmt', { search, format, rgb, hl });
  const out = await callCommand(connector, () => {
    type Range = {
      SetBold?: (v: boolean) => void;
      SetItalic?: (v: boolean) => void;
      SetUnderline?: (v: boolean) => void;
      SetStrikeout?: (v: boolean) => void;
      SetColor?: (r: number, g: number, b: number) => void;
      SetHighlight?: ((r: number, g: number, b: number) => void) & ((name: string) => void);
      SetFontSize?: (pt: number) => void;
      SetFontFamily?: (name: string) => void;
    };
    type DocSearch = { Search: (text: string, matchCase: boolean) => Range[] };
    const g = globalThis as unknown as {
      Api: { GetDocument: () => DocSearch };
      Asc?: {
        scope?: {
          aionuiFmt?: {
            search: string;
            format: TextFormat;
            rgb: { r: number; g: number; b: number } | null;
            hl: { r: number; g: number; b: number } | null;
          };
        };
      };
    };
    const data = g.Asc?.scope?.aionuiFmt;
    if (!data) return 0;
    const { format: f, rgb: c, hl: h } = data;
    const ranges = g.Api.GetDocument().Search(data.search, false) || [];
    for (const r of ranges) {
      if (f.bold !== undefined && r.SetBold) r.SetBold(f.bold);
      if (f.italic !== undefined && r.SetItalic) r.SetItalic(f.italic);
      if (f.underline !== undefined && r.SetUnderline) r.SetUnderline(f.underline);
      if (f.strikeout !== undefined && r.SetStrikeout) r.SetStrikeout(f.strikeout);
      if (c && r.SetColor) r.SetColor(c.r, c.g, c.b);
      if (h && r.SetHighlight) r.SetHighlight(h.r, h.g, h.b);
      if (f.fontSize && r.SetFontSize) r.SetFontSize(f.fontSize);
      if (f.fontFamily && r.SetFontFamily) r.SetFontFamily(f.fontFamily);
    }
    return ranges.length;
  });
  return typeof out === 'number' ? out : 0;
};

/**
 * Apply character formatting to ONE specific passage (Word only), located by an
 * anchor — the formatting equivalent of {@link replacePassage}. This is the
 * "select the whole passage, then apply bold/italic/…" action.
 *
 * Matching modes:
 *  - `find` alone: format the first exact occurrence of `find`.
 *  - `find` + `until`: format from the start of `find` THROUGH the end of the
 *    first following `until` — pass the first words as `find` and the last words
 *    as `until` to cover a long paragraph without quoting it all.
 *
 * Returns true if a passage was formatted.
 */
export const formatPassage = async (
  filePath: string,
  find: string,
  format: TextFormat,
  until?: string
): Promise<boolean> => {
  const { connector, kind } = await awaitEntry(filePath);
  if (kind !== 'word') throw new Error('Formatting a specific passage is only supported for Word files.');
  const rgb = format.color ? hexToRgbLiteral(format.color) : null;
  const hl = format.highlight ? hexToRgbLiteral(format.highlight) : null;
  setAscScope('aionuiFmtPassage', { find, format, until: until ?? null, rgb, hl });
  const out = await callCommand(connector, () => {
    type Range = {
      GetStartPos?: () => unknown;
      GetEndPos?: () => unknown;
      SetBold?: (v: boolean) => void;
      SetItalic?: (v: boolean) => void;
      SetUnderline?: (v: boolean) => void;
      SetStrikeout?: (v: boolean) => void;
      SetColor?: (r: number, g: number, b: number) => void;
      SetHighlight?: (r: number, g: number, b: number) => void;
      SetFontSize?: (pt: number) => void;
      SetFontFamily?: (name: string) => void;
    };
    type Doc = {
      Search: (text: string, matchCase: boolean) => Range[];
      GetRange?: (start: unknown, end: unknown) => Range;
    };
    const g = globalThis as unknown as {
      Api: { GetDocument: () => Doc };
      Asc?: {
        scope?: {
          aionuiFmtPassage?: {
            find: string;
            format: TextFormat;
            until: string | null;
            rgb: { r: number; g: number; b: number } | null;
            hl: { r: number; g: number; b: number } | null;
          };
        };
      };
    };
    const data = g.Asc?.scope?.aionuiFmtPassage;
    if (!data) return false;
    const doc = g.Api.GetDocument();
    const startMatches = doc.Search(data.find, false) || [];
    if (startMatches.length === 0) return false;
    let target: Range | null = startMatches[0];
    if (data.until && typeof doc.GetRange === 'function') {
      const endMatches = doc.Search(data.until, false) || [];
      if (endMatches.length > 0) {
        const startPos = startMatches[0].GetStartPos?.();
        const endPos = endMatches[0].GetEndPos?.();
        const combined = startPos && endPos ? doc.GetRange(startPos, endPos) : null;
        if (combined) target = combined;
      }
    }
    if (!target) return false;
    const f = data.format;
    if (f.bold !== undefined && target.SetBold) target.SetBold(f.bold);
    if (f.italic !== undefined && target.SetItalic) target.SetItalic(f.italic);
    if (f.underline !== undefined && target.SetUnderline) target.SetUnderline(f.underline);
    if (f.strikeout !== undefined && target.SetStrikeout) target.SetStrikeout(f.strikeout);
    if (data.rgb && target.SetColor) target.SetColor(data.rgb.r, data.rgb.g, data.rgb.b);
    if (data.hl && target.SetHighlight) target.SetHighlight(data.hl.r, data.hl.g, data.hl.b);
    if (f.fontSize && target.SetFontSize) target.SetFontSize(f.fontSize);
    if (f.fontFamily && target.SetFontFamily) target.SetFontFamily(f.fontFamily);
    return true;
  });
  return out === true;
};

/**
 * Insert a table (Word only). `data` (optional) fills cells row-by-row; its
 * dimensions override `rows`/`cols` when given. The table is appended at the end
 * of the document. Uses the real `Api.CreateTable` builder API.
 */
export const insertTable = async (filePath: string, rows: number, cols: number, data?: string[][]): Promise<void> => {
  const { connector, kind } = await awaitEntry(filePath);
  if (kind !== 'word') throw new Error('Inserting a table is only supported for Word files.');
  const r = Math.max(1, data?.length || rows);
  const c = Math.max(1, data?.[0]?.length || cols);
  setAscScope('aionuiTable', { rows: r, cols: c, data: data ?? null });
  await callCommand(connector, () => {
    type Cell = { GetContent?: () => { GetElement: (i: number) => { AddText?: (t: string) => void } } };
    type Row = { GetCell: (i: number) => Cell };
    type Table = { GetRow: (i: number) => Row };
    type Doc = { Push: (el: unknown) => void };
    const g = globalThis as unknown as {
      Api: { GetDocument: () => Doc; CreateTable: (cols: number, rows: number) => Table };
      Asc?: { scope?: { aionuiTable?: { rows: number; cols: number; data: string[][] | null } } };
    };
    const t = g.Asc?.scope?.aionuiTable;
    if (!t) return;
    const table = g.Api.CreateTable(t.cols, t.rows);
    if (t.data) {
      for (let ri = 0; ri < t.rows; ri++) {
        for (let ci = 0; ci < t.cols; ci++) {
          const val = t.data[ri]?.[ci];
          if (val == null) continue;
          const cell = table.GetRow(ri)?.GetCell(ci);
          const para = cell?.GetContent?.()?.GetElement(0);
          if (para && typeof para.AddText === 'function') para.AddText(String(val));
        }
      }
    }
    g.Api.GetDocument().Push(table);
  });
};

/**
 * Set spreadsheet cell values (Excel only). `start` is the top-left cell ref
 * (e.g. "A1"); `values` is a 2D array written row-by-row from there. Uses the
 * real `ApiRange.SetValue` API. Optionally targets a specific sheet by name.
 */
export const setCells = async (
  filePath: string,
  start: string,
  values: Array<Array<string | number>>,
  sheetName?: string
): Promise<number> => {
  const { connector, kind } = await awaitEntry(filePath);
  if (kind !== 'cell') throw new Error('Setting cells is only supported for spreadsheets.');
  setAscScope('aionuiCells', { start, values, sheetName: sheetName ?? null });
  const out = await callCommand(connector, () => {
    type Range = { SetValue: (v: string | number) => void };
    type Sheet = { GetRangeByNumber?: (r: number, c: number) => Range; GetRange?: (ref: string) => Range };
    type ApiX = {
      GetActiveSheet: () => Sheet;
      GetSheet?: (name: string) => Sheet;
    };
    const g = globalThis as unknown as {
      Api: ApiX;
      Asc?: {
        scope?: {
          aionuiCells?: { start: string; values: Array<Array<string | number>>; sheetName: string | null };
        };
      };
    };
    const data = g.Asc?.scope?.aionuiCells;
    if (!data) return 0;
    const sheet = data.sheetName && g.Api.GetSheet ? g.Api.GetSheet(data.sheetName) : g.Api.GetActiveSheet();
    if (!sheet) return 0;
    // Parse the start ref (e.g. "A1") into 0-based row/col.
    const m = /^([A-Za-z]+)(\d+)$/.exec(data.start.trim());
    let baseCol = 0;
    let baseRow = 0;
    if (m) {
      const letters = m[1].toUpperCase();
      let col = 0;
      for (let i = 0; i < letters.length; i++) col = col * 26 + (letters.charCodeAt(i) - 64);
      baseCol = col - 1;
      baseRow = parseInt(m[2], 10) - 1;
    }
    let written = 0;
    for (let ri = 0; ri < data.values.length; ri++) {
      const row = data.values[ri];
      for (let ci = 0; ci < row.length; ci++) {
        const cell = sheet.GetRangeByNumber ? sheet.GetRangeByNumber(baseRow + ri, baseCol + ci) : null;
        if (cell) {
          cell.SetValue(row[ci]);
          written++;
        }
      }
    }
    return written;
  });
  return typeof out === 'number' ? out : 0;
};

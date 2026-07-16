/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `elementInspectorLocator` — the pure mapping core behind Quick Test's
 * **visual element picker** ("Inspect", like F12's pick-element).
 *
 * This is a SEPARATE, ADDITIVE feature from the bug-prediction trace flow: the
 * user toggles Inspect, clicks an element in the live app, and instead of
 * describing it vaguely ("the hero button"), the picker hands the agent a
 * concrete anchor — the element's tag/role/text, its on-screen box + key
 * computed styles, AND the component + `file:line` it renders from — so a design
 * request ("nudge this up 20px", "make this accent") lands on the right code
 * with zero guessing.
 *
 * ## Why this is precise (not heuristic guessing)
 *
 * The page-side picker first reads the element's **React fiber `_debugSource`**
 * (emitted by the JSX dev transform): when the app runs in dev mode this is the
 * EXACT `fileName:lineNumber` the element was authored at — no token matching.
 * `componentName` comes from the fiber's `type` name. We map that source file to
 * a graph node here (suffix match), and only when the fiber source is absent
 * (production build / no debug info) do we fall back to the same token-overlap
 * mapping the trace builder uses.
 *
 * Pure + dependency-free (no fs, no DOM, no LLM). Process boundary: shared
 * module — the page-side capture lives in `elementInspectorBridge` (Main).
 */

import type { KnowledgeGraph, KnowledgeNode } from './understandTypes';

/**
 * A source location read from a React fiber's `_debugSource` (dev transform).
 * Present only when the app was built with JSX debug info (dev mode).
 */
export type ElementSource = {
  /** Absolute or repo-relative file path the JSX was authored in. */
  fileName: string;
  /** 1-based line number of the JSX element. */
  lineNumber: number;
  /** 1-based column, when available. */
  columnNumber?: number;
};

/** The raw element snapshot the page-side picker returns on click. */
export type PickedElement = {
  /** A CSS selector path to the element (best-effort, for display + replay). */
  selector: string;
  /** Lowercase tag name (e.g. `button`). */
  tagName: string;
  /** The element's `id` attribute, when set. */
  id?: string;
  /** Class list (split, no dots). */
  classes: string[];
  /** Trimmed visible text (capped). */
  text: string;
  /** Selected attributes worth showing the agent (role, aria-*, data-*, name, type, href). */
  attributes: Record<string, string>;
  /** On-screen box in CSS pixels, relative to the viewport. */
  rect: { x: number; y: number; width: number; height: number };
  /** Key computed styles (color, background, font, spacing, layout). */
  styles: Record<string, string>;
  /** React component display name from the fiber `type`, when resolvable. */
  componentName?: string;
  /** React fiber `_debugSource` — the authored file:line (dev mode only). */
  source?: ElementSource;
};

/** The picked element mapped to the code that renders it. */
export type LocatedElement = {
  /** The raw element snapshot. */
  element: PickedElement;
  /** Repo-relative file (graph node id) the element renders from, or null. */
  file: string | null;
  /** 1-based line in {@link file}, or null when unknown. */
  line: number | null;
  /** Best symbol name at/around the element (component/function), or null. */
  symbol: string | null;
  /** Modules the rendering file imports/uses (outgoing graph edges). */
  uses: string[];
  /** One-line summary of the rendering file (from the graph), or null. */
  summary: string | null;
  /** How {@link file} was resolved — fiber debug source vs token heuristic. */
  resolvedBy: 'fiber-source' | 'token-match' | 'none';
};

/** Tokenise a selector / name into searchable words (mirrors traceContextBuilder). */
const tokens = (value: string): string[] =>
  value
    .replace(/[#.[\]>+~:()]/g, ' ')
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);

/** Normalise a fiber source path to a repo-relative, forward-slash fragment. */
const normalizeSourcePath = (fileName: string): string =>
  fileName
    .replace(/\\/g, '/')
    .replace(/^[a-zA-Z]:\//, '')
    .replace(/^\.\//, '')
    .replace(/^\/+/, '');

/**
 * Find the graph node whose id best matches a fiber source file. Exact first,
 * then longest common suffix (so `…/src/Hero.tsx` matches `src/Hero.tsx`).
 */
const nodeForSource = (graph: KnowledgeGraph, fileName: string): KnowledgeNode | null => {
  const rel = normalizeSourcePath(fileName);
  const exact = graph.nodes.find((n) => n.id === rel);
  if (exact) return exact;
  let best: KnowledgeNode | null = null;
  let bestLen = 0;
  for (const node of graph.nodes) {
    if (rel.endsWith(node.id) || node.id.endsWith(rel)) {
      const len = Math.min(node.id.length, rel.length);
      if (len > bestLen) {
        bestLen = len;
        best = node;
      }
    }
  }
  return best;
};

/**
 * Token-match an element to a UI graph node (the fallback when no fiber source
 * is available). Same >= 2 overlap bar as the trace builder to avoid false
 * trails. Returns the best node or null.
 */
const nodeByTokens = (graph: KnowledgeGraph, element: PickedElement): KnowledgeNode | null => {
  const elTokens = new Set([
    ...tokens(element.selector),
    ...tokens(element.text),
    ...tokens(element.componentName ?? ''),
    ...tokens(element.id ?? ''),
    ...element.classes.flatMap((c) => tokens(c)),
  ]);
  let best: KnowledgeNode | null = null;
  let bestHits = 1;
  for (const node of graph.nodes) {
    if (node.layer !== 'ui') continue;
    const nameTokens = tokens(node.label);
    const symTokens = node.symbols.flatMap((s) => tokens(s.name));
    const hits = [...nameTokens, ...symTokens].filter((tok) => elTokens.has(tok)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = node;
    }
  }
  return best;
};

/** Pick the symbol whose name best matches the component/selector, else the first. */
const bestSymbol = (node: KnowledgeNode, element: PickedElement): { name: string; line: number } | null => {
  if (node.symbols.length === 0) return null;
  const want = new Set([...tokens(element.componentName ?? ''), ...tokens(element.selector), ...tokens(element.text)]);
  let best = node.symbols[0];
  let bestHits = -1;
  for (const s of node.symbols) {
    const hits = tokens(s.name).filter((tok) => want.has(tok)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = s;
    }
  }
  return { name: best.name, line: best.line };
};

/**
 * Map a {@link PickedElement} to the code that renders it. Prefers the fiber
 * debug source (exact authored file:line); falls back to token matching against
 * UI graph nodes. Pure: same element + graph always yields the same result.
 */
export const locateElement = (element: PickedElement, graph: KnowledgeGraph | null): LocatedElement => {
  const usesFor = (nodeId: string): string[] =>
    graph ? graph.edges.filter((e) => e.from === nodeId).map((e) => e.to) : [];

  // 1) Fiber debug source — the authoritative, exact authored location.
  if (graph && element.source?.fileName) {
    const node = nodeForSource(graph, element.source.fileName);
    if (node) {
      const sym = bestSymbol(node, element);
      return {
        element,
        file: node.id,
        line: element.source.lineNumber || sym?.line || null,
        symbol: element.componentName ?? sym?.name ?? null,
        uses: usesFor(node.id).slice(0, 5),
        summary: node.summary || null,
        resolvedBy: 'fiber-source',
      };
    }
    // Source file is not in the graph (e.g. node_modules / generated) but we
    // still know the authored path + line — surface it directly.
    return {
      element,
      file: normalizeSourcePath(element.source.fileName),
      line: element.source.lineNumber || null,
      symbol: element.componentName ?? null,
      uses: [],
      summary: null,
      resolvedBy: 'fiber-source',
    };
  }

  // 2) Token heuristic against UI nodes (production build / no debug info).
  if (graph) {
    const node = nodeByTokens(graph, element);
    if (node) {
      const sym = bestSymbol(node, element);
      return {
        element,
        file: node.id,
        line: sym?.line ?? null,
        symbol: element.componentName ?? sym?.name ?? null,
        uses: usesFor(node.id).slice(0, 5),
        summary: node.summary || null,
        resolvedBy: 'token-match',
      };
    }
  }

  // 3) Nothing matched — return the element snapshot alone (still useful: the
  // agent gets box + styles + selector even without a code anchor).
  return {
    element,
    file: null,
    line: null,
    symbol: element.componentName ?? null,
    uses: [],
    summary: null,
    resolvedBy: 'none',
  };
};

/** Render one `key: value` style line, skipping empty values. */
const styleLine = (styles: Record<string, string>, keys: string[]): string =>
  keys
    .map((k) => (styles[k] ? `${k}: ${styles[k]}` : ''))
    .filter(Boolean)
    .join('; ');

/**
 * Compose a ready-to-send agent brief from a located element + the user's
 * design/change request. The brief leads with the user's intent, then gives the
 * concrete anchor (component, `file:line`, box, styles) so the agent edits the
 * right code without guessing. When `request` is empty the brief is still useful
 * as a precise "here is the element" description.
 *
 * Pure: same input always yields the same Markdown.
 */
export const renderElementBrief = (located: LocatedElement, request: string): string => {
  const { element } = located;
  const trimmedRequest = request.trim();
  const where = located.file
    ? located.line
      ? `\`${located.file}:${located.line}\``
      : `\`${located.file}\``
    : '_not resolved to a source file_';
  const sym = located.symbol ? ` (${located.symbol})` : '';
  const usesStr = located.uses.length > 0 ? located.uses.join(', ') : '—';

  const intro = trimmedRequest
    ? [`I picked a specific element in the live app and want this change:`, '', `> ${trimmedRequest}`, '']
    : [`I picked a specific element in the live app. Here is exactly what and where it is:`, ''];

  const attrEntries = Object.entries(element.attributes);
  const attrLine = attrEntries.length > 0 ? attrEntries.map(([k, v]) => `${k}="${v}"`).join(' ') : '—';

  return [
    ...intro,
    '## Picked element',
    `- **Renders from:** ${where}${sym}`,
    located.summary ? `- **File role:** ${located.summary}` : '',
    `- **Uses:** ${usesStr}`,
    `- **Resolved by:** ${located.resolvedBy === 'fiber-source' ? 'React source (exact)' : located.resolvedBy === 'token-match' ? 'graph heuristic' : 'unresolved'}`,
    '',
    '### DOM',
    `- **Tag:** \`${element.tagName}\`${element.id ? ` · id \`${element.id}\`` : ''}${element.classes.length > 0 ? ` · class \`${element.classes.join(' ')}\`` : ''}`,
    element.text ? `- **Text:** "${element.text}"` : '',
    `- **Attributes:** ${attrLine}`,
    `- **Selector:** \`${element.selector}\``,
    '',
    '### Box (viewport px)',
    `- x ${Math.round(element.rect.x)}, y ${Math.round(element.rect.y)}, w ${Math.round(element.rect.width)}, h ${Math.round(element.rect.height)}`,
    '',
    '### Key computed styles',
    `- **Color/Bg:** ${styleLine(element.styles, ['color', 'backgroundColor']) || '—'}`,
    `- **Typography:** ${styleLine(element.styles, ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight']) || '—'}`,
    `- **Box model:** ${styleLine(element.styles, ['margin', 'padding', 'border', 'borderRadius']) || '—'}`,
    `- **Layout:** ${styleLine(element.styles, ['display', 'position', 'width', 'height', 'flex', 'gap']) || '—'}`,
    '',
    located.file
      ? '_Open the file above and apply the change. Respect the project UI stack (Arco + UnoCSS semantic tokens, i18n) — adjust the token/utility, not hardcoded values._'
      : '_The element could not be tied to a source file. Use the selector + styles above to locate it, and rebuild the knowledge graph for precise mapping._',
  ]
    .filter((l) => l !== '')
    .join('\n');
};

/**
 * Render the "where + DOM + box + styles" block for ONE located element, with
 * an optional ordinal label (`#1`, `#2`…) so a multi-element brief can list
 * several picks unambiguously. Pure. Shared by the single- and multi-element
 * briefs so both read identically per element.
 */
const renderElementBlock = (located: LocatedElement, ordinal?: number): string[] => {
  const { element } = located;
  const where = located.file
    ? located.line
      ? `\`${located.file}:${located.line}\``
      : `\`${located.file}\``
    : '_not resolved to a source file_';
  const sym = located.symbol ? ` (${located.symbol})` : '';
  const usesStr = located.uses.length > 0 ? located.uses.join(', ') : '—';
  const attrEntries = Object.entries(element.attributes);
  const attrLine = attrEntries.length > 0 ? attrEntries.map(([k, v]) => `${k}="${v}"`).join(' ') : '—';
  const heading = ordinal
    ? `### Element #${ordinal}: \`${element.tagName}\`${element.id ? `#${element.id}` : ''}`
    : '### Picked element';

  return [
    heading,
    `- **Renders from:** ${where}${sym}`,
    located.summary ? `- **File role:** ${located.summary}` : '',
    `- **Uses:** ${usesStr}`,
    `- **Resolved by:** ${located.resolvedBy === 'fiber-source' ? 'React source (exact)' : located.resolvedBy === 'token-match' ? 'graph heuristic' : 'unresolved'}`,
    element.text ? `- **Text:** "${element.text}"` : '',
    `- **Attributes:** ${attrLine}`,
    `- **Selector:** \`${element.selector}\``,
    `- **Box (viewport px):** x ${Math.round(element.rect.x)}, y ${Math.round(element.rect.y)}, w ${Math.round(element.rect.width)}, h ${Math.round(element.rect.height)}`,
    `- **Color/Bg:** ${styleLine(element.styles, ['color', 'backgroundColor']) || '—'}`,
    `- **Typography:** ${styleLine(element.styles, ['fontFamily', 'fontSize', 'fontWeight', 'lineHeight']) || '—'}`,
    `- **Box model:** ${styleLine(element.styles, ['margin', 'padding', 'border', 'borderRadius']) || '—'}`,
    `- **Layout:** ${styleLine(element.styles, ['display', 'position', 'width', 'height', 'flex', 'gap']) || '—'}`,
  ].filter((l) => l !== '');
};

/**
 * Compose an agent brief from MULTIPLE picked elements + one shared design
 * request (e.g. "make these three cards symmetric"). Each element gets its own
 * numbered block with its anchor + box + styles, so the agent can reason about
 * them together (alignment, symmetry, consistent spacing) and edit each at the
 * right `file:line`. An optional screenshot path is referenced so a
 * vision-capable agent can SEE the current layout. Pure.
 */
export type ScreenshotEvidence = {
  filePath: string;
  mode: 'viewport' | 'fullPage';
};

export type VideoEvidence = {
  filePath: string;
  durationMs: number;
};

export const renderMultiElementBrief = (
  items: LocatedElement[],
  request: string,
  screenshots: ScreenshotEvidence[] = [],
  videos: VideoEvidence[] = []
): string => {
  const hasEvidence = screenshots.length > 0 || videos.length > 0;
  if (items.length === 0 && !hasEvidence) return '';
  if (items.length === 1 && !hasEvidence) return renderElementBrief(items[0], request);

  const trimmedRequest = request.trim();
  const intro =
    items.length === 0
      ? trimmedRequest
        ? ['I captured the live app and want help with this request:', '', `> ${trimmedRequest}`, '']
        : ['I captured the live app so you can inspect its current visual state.', '']
      : trimmedRequest
        ? [
            `I picked ${items.length} elements in the live app and want this change applied across them:`,
            '',
            `> ${trimmedRequest}`,
            '',
          ]
        : [`I picked ${items.length} elements in the live app. Here is exactly what and where each one is:`, ''];

  const files = Array.from(new Set(items.map((it) => it.file).filter((f): f is string => Boolean(f))));
  const filesLine = files.length > 0 ? ['**Files involved:** ' + files.map((f) => `\`${f}\``).join(', '), ''] : [];
  const blocks = items.flatMap((it, i) => [...renderElementBlock(it, i + 1), '']);
  const shots =
    screenshots.length > 0
      ? [
          '### Screenshots',
          ...screenshots.map((shot, index) => {
            const scope = shot.mode === 'fullPage' ? 'full-page' : 'visible-frame';
            return `${index + 1}. ${scope}: \`${shot.filePath}\``;
          }),
          '_Open every screenshot with an image tool before answering._',
          '',
        ]
      : [];
  const recordings =
    videos.length > 0
      ? [
          '### Screen recordings',
          ...videos.map(
            (video, index) =>
              `${index + 1}. ${Math.max(1, Math.round(video.durationMs / 1000))}s: \`${video.filePath}\``
          ),
          '_Review the recordings before answering; extract representative frames if direct playback is unavailable._',
          '',
        ]
      : [];

  const closing =
    items.length === 0
      ? '_Use all visual evidence and inspect the repository files needed to answer or implement the request._'
      : files.length > 0
        ? '_Edit the files above. Respect the project UI stack (Arco + UnoCSS semantic tokens, i18n) — adjust tokens/utilities, not hardcoded values._'
        : '_Some elements were not tied to a source file; use their selectors + styles above and rebuild the knowledge graph for precise mapping._';

  return [...intro, ...filesLine, ...shots, ...recordings, ...blocks, closing].filter((line) => line !== '').join('\n');
};

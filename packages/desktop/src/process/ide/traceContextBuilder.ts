/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `traceContextBuilder` — converts a {@link RuntimeTrace} (the "what actually
 * ran" from Quick Test) into a focused {@link ContextPack} supplement.
 *
 * The static Context Builder (Phase 1) ranks files by lexical/semantic
 * similarity to the user's request. The trace builder adds the DYNAMIC layer:
 * it knows which files were ACTUALLY involved in the failing interaction, so
 * the agent receives both "files that look relevant" AND "files that were
 * running when it broke".
 *
 * ## Mapping strategy
 *
 * The trace contains DOM selectors, network URLs, and stack traces. We map
 * these to graph nodes by:
 *   1. **Stack trace URL** → strip origin → relative path → exact node id.
 *   2. **Network URL path** → match against `api` / `service` layer nodes.
 *   3. **DOM selector text** → fuzzy-match against component symbol names.
 *
 * All three are heuristic (the trace doesn't carry source maps), but they
 * narrow the suspect list dramatically compared to a blank slate.
 *
 * Pure + dependency-free (no fs, no LLM). Process boundary: shared module.
 */

import type { ContextPack, ContextSlice, KnowledgeGraph } from './understandTypes';
import type { RuntimeTrace } from './quickTestTracer';

/** Max slices in the trace-derived supplement. */
const MAX_TRACE_SLICES = 8;

/** Extract a relative file path from a stack-trace URL (best-effort). */
const pathFromStackUrl = (url: string): string | null => {
  try {
    // Strip origin: "http://localhost:3000/src/auth/authApi.ts:42" → "src/auth/authApi.ts"
    const u = new URL(url);
    const p = u.pathname.replace(/^\//, '').replace(/:\d+$/, '');
    return p.length > 0 ? p : null;
  } catch {
    // Not a URL — try as a bare path fragment.
    const clean = url.replace(/:\d+$/, '').replace(/^\//, '');
    return clean.length > 0 ? clean : null;
  }
};

/** Normalise a network URL path to a relative API path for matching. */
const apiPathFrom = (url: string): string => {
  try {
    return new URL(url).pathname.replace(/^\//, '');
  } catch {
    return url.replace(/^\//, '');
  }
};

/** Tokenise a CSS selector into searchable words. */
const selectorTokens = (selector: string): string[] =>
  selector
    .replace(/[#.[\]>+~:()]/g, ' ')
    .split(/\s+/)
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2);

/**
 * Build a focused {@link ContextPack} supplement from a {@link RuntimeTrace}.
 * The pack's `renderedContext` describes the failing interaction in plain
 * English so the agent understands what the user did and where it broke.
 *
 * Pure: same trace + graph always yields the same pack.
 */
export const buildTraceContext = (trace: RuntimeTrace, graph: KnowledgeGraph): ContextPack => {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n] as const));
  const sliceMap = new Map<string, ContextSlice>();

  const addSlice = (id: string, reason: ContextSlice['reason'], score: number): void => {
    const node = nodeById.get(id);
    if (!node || sliceMap.has(id)) return;
    sliceMap.set(id, {
      path: id,
      layer: node.layer,
      reason,
      score,
      summary: node.summary,
      symbols: node.symbols,
    });
  };

  // Map a coverage file to the best-matching graph node id (exact, then suffix
  // either way), or null when the file is not in the graph.
  const coverageNodeId = (file: string): string | null => {
    const rel = file.replace(/^\.\//, '');
    if (nodeById.has(rel)) return rel;
    for (const id of nodeById.keys()) {
      if (id.endsWith(rel) || rel.endsWith(id)) return id;
    }
    return null;
  };

  // 0a. The PRE-ERROR interaction's coverage is the sharpest localiser we have:
  // the exact functions that ran during the click/input that immediately
  // preceded the first error. These get the top score so the agent reads them
  // first — this is what turns "code that ran sometime" into "code that ran
  // when it broke". (Per-interaction coverage is attached to each DOM event.)
  const errorIndex = trace.firstError ? trace.events.indexOf(trace.firstError) : -1;
  let preErrorCoverage: typeof trace.coverage = undefined;
  if (errorIndex >= 0) {
    for (let i = errorIndex; i >= 0; i -= 1) {
      const ev = trace.events[i];
      if ((ev.kind === 'click' || ev.kind === 'input') && ev.coverage && ev.coverage.length > 0) {
        preErrorCoverage = ev.coverage;
        break;
      }
    }
  }
  for (const fn of preErrorCoverage ?? []) {
    const id = coverageNodeId(fn.file);
    if (id) addSlice(id, 'changed', 1300 + Math.min(fn.callCount, 50));
  }

  // 0b. Session-wide V8 coverage — the user's OWN functions that executed during
  // the test. Still a strong signal (exact repo-relative file, no URL guessing;
  // catches bugs that throw nothing), just broader than the pre-error set, so it
  // scores below it. Ranked by call count, hottest path highest.
  for (const fn of trace.coverage ?? []) {
    const id = coverageNodeId(fn.file);
    if (id) addSlice(id, 'changed', 1100 + Math.min(fn.callCount, 50));
  }

  // 1. Map stack-trace URLs to graph nodes (highest confidence).
  for (const ev of trace.events) {
    if (ev.kind === 'exception') {
      const stackLines = (ev.stack ?? '').split('\n');
      for (const line of stackLines) {
        const urlMatch = line.match(/https?:\/\/[^\s)]+/);
        if (urlMatch) {
          const rel = pathFromStackUrl(urlMatch[0]);
          if (rel) {
            // Exact match first.
            if (nodeById.has(rel)) {
              addSlice(rel, 'changed', 1000);
            } else {
              // Suffix match (e.g. "auth/authApi.ts" matches "src/auth/authApi.ts").
              for (const id of nodeById.keys()) {
                if (id.endsWith(rel)) {
                  addSlice(id, 'changed', 900);
                  break;
                }
              }
            }
          }
        }
      }
    }
  }

  // 2. Map network error URLs to api/service layer nodes. A failed request is
  // either a 4xx/5xx response or a transport failure (status 0 + error).
  for (const ev of trace.events) {
    if (ev.kind === 'network' && (ev.status >= 400 || Boolean(ev.error))) {
      const apiPath = apiPathFrom(ev.url);
      const apiSegments = apiPath.split('/').filter((s) => s.length > 1);
      for (const node of graph.nodes) {
        if (node.layer === 'api' || node.layer === 'service') {
          const nodeSegments = node.id.split('/').map((s) => s.toLowerCase().replace(/\.[^.]+$/, ''));
          const hits = apiSegments.filter((seg) =>
            nodeSegments.some((ns) => ns.includes(seg) || seg.includes(ns))
          ).length;
          if (hits >= 1) {
            addSlice(node.id, 'seed', 800);
          }
        }
      }
    }
  }

  // 3. Map DOM selector text to component symbol names (fuzzy).
  for (const ev of trace.events) {
    if (ev.kind === 'click' || ev.kind === 'input') {
      const label = ev.kind === 'click' ? ev.text : ev.value;
      const tokens = new Set([...selectorTokens(ev.selector), ...selectorTokens(label ?? '')]);
      for (const node of graph.nodes) {
        if (node.layer !== 'ui') continue;
        const nameTokens = selectorTokens(node.label);
        const symTokens = node.symbols.flatMap((s) => selectorTokens(s.name));
        const allTokens = [...nameTokens, ...symTokens];
        const hits = allTokens.filter((t) => tokens.has(t)).length;
        if (hits >= 2) addSlice(node.id, 'seed', 600 + hits * 10);
      }
    }
  }

  const ordered = Array.from(sliceMap.values())
    .toSorted((a, b) => b.score - a.score || a.path.localeCompare(b.path))
    .slice(0, MAX_TRACE_SLICES);

  // Compose a plain-English brief describing the failing interaction.
  const errorEvent = trace.firstError;
  const errorDesc = errorEvent
    ? errorEvent.kind === 'exception'
      ? `**Exception:** ${errorEvent.message.split('\n')[0]}`
      : errorEvent.kind === 'network'
        ? `**Network error:** ${errorEvent.method} ${errorEvent.url} → ${errorEvent.status}${errorEvent.error ? ` (${errorEvent.error})` : ''}`
        : errorEvent.kind === 'console'
          ? `**Console error:** ${errorEvent.message.split('\n')[0]}`
          : '_Error detected._'
    : '_No error detected — trace shows the interaction path._';

  // Outgoing graph edges for a node = the modules it imports/calls. This is the
  // "what does this component touch" relationship the agent needs to follow the
  // flow (a click handler that calls a hook that calls an API), rather than
  // guessing from a bare selector.
  const usesFor = (nodeId: string): string[] => graph.edges.filter((e) => e.from === nodeId).map((e) => e.to);

  // Annotate a DOM interaction with the UI component it maps to: file:line of the
  // best-matching symbol + what that component uses. Turns a raw selector into a
  // concrete entry point in the code. Empty when nothing matches confidently
  // (same >= 2 token-overlap bar as the slice mapping, to avoid false trails).
  const annotateInteraction = (selector: string, label: string | undefined): string => {
    const tokens = new Set([...selectorTokens(selector), ...selectorTokens(label ?? '')]);
    let best: (typeof graph.nodes)[number] | null = null;
    let bestHits = 1;
    for (const node of graph.nodes) {
      if (node.layer !== 'ui') continue;
      const nameTokens = selectorTokens(node.label);
      const symTokens = node.symbols.flatMap((s) => selectorTokens(s.name));
      const hits = [...nameTokens, ...symTokens].filter((tok) => tokens.has(tok)).length;
      if (hits > bestHits) {
        bestHits = hits;
        best = node;
      }
    }
    if (!best) return '';
    // Pick the symbol whose name best overlaps the selector/label, else the first.
    let bestSym = best.symbols[0];
    let bestSymHits = -1;
    for (const s of best.symbols) {
      const h = selectorTokens(s.name).filter((tok) => tokens.has(tok)).length;
      if (h > bestSymHits) {
        bestSymHits = h;
        bestSym = s;
      }
    }
    const where = bestSym && bestSym.line > 0 ? `${best.id}:${bestSym.line}` : best.id;
    const sym = bestSym ? ` ${bestSym.name}()` : '';
    const uses = usesFor(best.id);
    const usesStr = uses.length > 0 ? ` · uses: ${uses.slice(0, 3).join(', ')}` : '';
    return `\n  ↳ \`${where}\`${sym}${usesStr}`;
  };

  const interactionLines = trace.events
    .filter((e) => e.kind === 'click' || e.kind === 'input' || e.kind === 'navigate')
    .slice(-10)
    .map((e) => {
      if (e.kind === 'click') return `- Click: \`${e.selector}\` "${e.text}"${annotateInteraction(e.selector, e.text)}`;
      if (e.kind === 'input')
        return `- Input: \`${e.selector}\` = "${e.value}"${annotateInteraction(e.selector, e.value)}`;
      if (e.kind === 'navigate') return `- Navigate: ${e.url}`;
      return '';
    })
    .filter(Boolean);

  // Each relevant file carries the primary symbol's line + what it uses, so the
  // list reads as "open here, it touches these" instead of a flat path dump.
  const sliceLines = ordered.map((s) => {
    const node = nodeById.get(s.path);
    const sym = node?.symbols[0];
    const where = sym && sym.line > 0 ? `${s.path}:${sym.line}` : s.path;
    const uses = usesFor(s.path);
    const usesStr = uses.length > 0 ? ` · uses: ${uses.slice(0, 3).join(', ')}` : '';
    return `- \`${where}\` (${s.layer}) — ${s.summary || 'no summary'}${usesStr}`;
  });

  /** Render a coverage list as `- file:line — fn() ×N` lines. */
  const renderCoverage = (fns: NonNullable<RuntimeTrace['coverage']>, limit: number): string[] =>
    fns.slice(0, limit).map((fn) => {
      const where = fn.line > 0 ? `${fn.file}:${fn.line}` : fn.file;
      return `- \`${where}\` — ${fn.functionName}() ×${fn.callCount}`;
    });

  // The functions that ran during the interaction RIGHT BEFORE the error — the
  // sharpest localiser (the exact code path of the action that broke).
  const preErrorLines = preErrorCoverage ? renderCoverage(preErrorCoverage, 15) : [];

  // The user's OWN functions that actually executed across the whole session
  // (V8 coverage), ranked by call count. The broader "which code ran when I
  // clicked" answer — the strongest fix signal for bugs that throw nothing.
  const coverageLines = renderCoverage(trace.coverage ?? [], 20);

  const renderedContext = [
    '## Quick Test trace',
    `Duration: ${((trace.stoppedAt - trace.startedAt) / 1000).toFixed(1)}s · ${trace.events.length} events`,
    '',
    '### User interaction path',
    interactionLines.length > 0 ? interactionLines.join('\n') : '_No interactions recorded._',
    '',
    '### Error',
    errorDesc,
    '',
    preErrorLines.length > 0
      ? '### Code that ran during the action that broke (read these FIRST)\n' +
        preErrorLines.join('\n') +
        '\n\n_These functions executed during the interaction immediately before the error — the most precise suspect set._'
      : '',
    '',
    coverageLines.length > 0
      ? '### Code that actually ran (V8 coverage, whole session, hottest first)\n' +
        coverageLines.join('\n') +
        "\n\n_These are the user's own functions that executed during the test — the real call path, including code that ran without throwing._"
      : '',
    '',
    ordered.length > 0 ? '### Relevant files (from trace)\n' + sliceLines.join('\n') : '',
    '',
    errorEvent
      ? '_These files were identified from the runtime trace. Read them first when fixing the bug._'
      : '_These files were identified from the runtime trace. Read them first when reviewing the flow._',
  ]
    .filter((l) => l !== undefined)
    .join('\n');

  return {
    request: 'Quick Test trace',
    slices: ordered,
    rules: [],
    renderedContext,
    sliceCount: ordered.length,
    truncated: sliceMap.size > MAX_TRACE_SLICES,
  };
};

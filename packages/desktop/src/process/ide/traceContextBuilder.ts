/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
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

  const interactionLines = trace.events
    .filter((e) => e.kind === 'click' || e.kind === 'input' || e.kind === 'navigate')
    .slice(-10)
    .map((e) => {
      if (e.kind === 'click') return `- Click: \`${e.selector}\` "${e.text}"`;
      if (e.kind === 'input') return `- Input: \`${e.selector}\` = "${e.value}"`;
      if (e.kind === 'navigate') return `- Navigate: ${e.url}`;
      return '';
    })
    .filter(Boolean);

  const sliceLines = ordered.map((s) => `- \`${s.path}\` (${s.layer}) — ${s.summary || 'no summary'}`);

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
    ordered.length > 0 ? '### Suspected files (from trace)\n' + sliceLines.join('\n') : '',
    '',
    '_These files were identified from the runtime trace. Read them first when fixing the bug._',
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

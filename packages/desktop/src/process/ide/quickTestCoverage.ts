/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `quickTestCoverage` — the "which code actually ran" recorder for Quick Test.
 *
 * The DOM/console/network tracer ({@link createQuickTestTracer}) answers *what
 * the user did* and *what errored*. This module answers the harder question the
 * user asked: **which functions / lines of THEIR code executed** — including the
 * nasty bugs that throw nothing (a button runs the wrong logic, the console
 * stays silent). That call chain is the strongest signal an agent can get when
 * there is no stack trace to follow.
 *
 * ## What it does that makes localisation precise
 *
 *   1. **Per-interaction deltas** ({@link CoverageRecorder.takeDelta}) — V8
 *      precise coverage is cumulative, so the delta between two takes is exactly
 *      the code that ran *between* them. The tracer takes a delta after each
 *      click/input, so each interaction carries the functions IT triggered — not
 *      a whole-session blur. The interaction right before an error is therefore
 *      the precise suspect set.
 *   2. **Source-mapped positions** — V8 reports offsets in the SERVED script
 *      (transpiled TS/JSX under a dev server). Each served module's inline source
 *      map ({@link extractInlineSourceMap}) is decoded so a function points at the
 *      user's ORIGINAL file + line, not the generated output.
 *   3. **User-code filtering** — vendor/framework/virtual scripts (node_modules,
 *      Vite internals) are dropped both by served URL and by mapped source, so
 *      the result is only the user's own functions.
 *
 * It drives V8 precise coverage over CDP (the engine behind Chrome DevTools'
 * "Coverage" tab): `Profiler.startPreciseCoverage({ callCount, detailed })` on
 * start, `Profiler.takePreciseCoverage` for each delta + the final total.
 *
 * Pure of Electron/fs: the single CDP seam (`sendCommand`) and URL→repo mapping
 * are injected, so the whole module is unit-testable with fakes.
 *
 * Process boundary: Main-process (Node.js / Electron) module. No DOM APIs.
 */

import { extractInlineSourceMap, mapPosition, cleanSource, type DecodedSourceMap } from './sourceMap';

/** One function of the user's code that executed. */
export type CoverageFunction = {
  /** Repo-relative file path (forward-slash), source-mapped to the original. */
  file: string;
  /** Function name, or `(anonymous)` when V8 reports none. */
  functionName: string;
  /** 1-based start line in the ORIGINAL source (0 when unresolved). */
  line: number;
  /** Times the function was entered in the window (session total, or delta). */
  callCount: number;
};

/** The CDP command seam (Electron's `webContents.debugger.sendCommand`). */
export type CoverageCdpSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;

/** Injected collaborators for {@link createCoverageRecorder}. */
export type CoverageRecorderDeps = {
  /** Send a CDP command and resolve its result. */
  sendCommand: CoverageCdpSend;
  /**
   * Map a served script URL to a repo-relative path, or null to DROP it
   * (vendor / node_modules / framework-internal / non-source). Defaults to
   * {@link resolveCoverageUrl}. Used as the fallback when a script has no
   * usable source map.
   */
  resolveUrl?: (url: string) => string | null;
  /** Max functions kept in a result, ranked by call count. Defaults to 60. */
  maxFunctions?: number;
};

/** Records which of the user's functions executed during a Quick Test session. */
export type CoverageRecorder = {
  /** Begin precise coverage. Resolves false when the Profiler could not start. */
  start: () => Promise<boolean>;
  /**
   * Return the functions that executed SINCE THE LAST take (or since start),
   * source-mapped + ranked by delta call count. Each call advances the delta
   * baseline, so consecutive calls partition the session. Best-effort: any CDP
   * failure yields an empty list. No-op (empty) before {@link start}.
   */
  takeDelta: () => Promise<CoverageFunction[]>;
  /**
   * Take the final cumulative coverage (the WHOLE session), stop precise
   * coverage, and return the ranked executed-function list. Best-effort: any CDP
   * failure yields an empty list rather than throwing.
   */
  finalize: () => Promise<CoverageFunction[]>;
};

/** Code-file extensions whose coverage is worth surfacing (the user's sources). */
const CODE_EXT = /\.(?:tsx?|jsx?|mjs|cjs|vue|svelte)$/i;

/**
 * Whether a repo-relative path is the user's OWN source (not vendor / framework
 * / virtual / non-code). Shared by the served-URL resolver and the source-map
 * path filter so both planes drop the same noise.
 */
export const isUserSourcePath = (rel: string): boolean => {
  if (!rel) return false;
  if (
    rel.includes('node_modules') ||
    rel.includes('/@') ||
    rel.startsWith('@') ||
    rel.startsWith('.vite/') ||
    rel.includes('/.vite/') ||
    /^(?:vite|webpack|react-refresh|node:|chrome-extension|eval)/i.test(rel)
  ) {
    return false;
  }
  return CODE_EXT.test(rel);
};

/**
 * Resolve a CDP script URL to a repo-relative path, or null to drop it.
 *
 * Keeps only the user's own source files: strips the origin, query and hash,
 * and rejects framework/vendor noise. Exported for unit testing.
 */
export const resolveCoverageUrl = (rawUrl: string): string | null => {
  if (!rawUrl) return null;
  let pathPart = rawUrl;
  try {
    if (/^https?:\/\//i.test(rawUrl) || rawUrl.startsWith('file://')) {
      pathPart = new URL(rawUrl).pathname;
    }
  } catch {
    return null;
  }
  // Drop query/hash (Vite appends `?t=…`, `?import`, etc.).
  pathPart = pathPart.split('?')[0].split('#')[0];
  try {
    pathPart = decodeURIComponent(pathPart);
  } catch {
    /* keep as-is on malformed escapes */
  }
  const rel = pathPart.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
  return isUserSourcePath(rel) ? rel : null;
};

/** Convert a character offset into a 1-based line number within `source`. */
export const lineFromOffset = (source: string, offset: number): number => offsetToPosition(source, offset).line + 1;

/**
 * Convert a character offset into a 0-based `{ line, column }` within `source`.
 * Used both for plain line numbers and as the generated position fed to the
 * source map. Walks once, tracking the last newline for the column.
 */
export const offsetToPosition = (source: string, offset: number): { line: number; column: number } => {
  const limit = Math.max(0, Math.min(offset, source.length));
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < limit; i += 1) {
    if (source.charCodeAt(i) === 10 /* \n */) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: limit - lineStart };
};

/** Default cap on returned functions. */
const DEFAULT_MAX_FUNCTIONS = 60;

/** Shape of a `Profiler.takePreciseCoverage` result entry (the bits we use). */
type ScriptCoverage = {
  scriptId: string;
  url: string;
  functions?: Array<{
    functionName?: string;
    ranges?: Array<{ startOffset: number; endOffset: number; count: number }>;
  }>;
};

/** A served script's resolved source text + decoded inline map (cached per id). */
type ScriptInfo = {
  /** Served source text (with the inline map comment), or '' when unavailable. */
  source: string;
  /** Decoded inline source map, or null when none/external/malformed. */
  map: DecodedSourceMap | null;
  /** Repo-relative path from the served URL (fallback when unmapped), or null. */
  urlPath: string | null;
};

/**
 * Create a {@link CoverageRecorder} over a CDP command seam.
 *
 * @param deps Injected `sendCommand` + optional URL resolver / cap.
 * @returns A recorder driving V8 precise coverage for one session.
 */
export const createCoverageRecorder = (deps: CoverageRecorderDeps): CoverageRecorder => {
  const resolveUrl = deps.resolveUrl ?? resolveCoverageUrl;
  const maxFunctions = deps.maxFunctions ?? DEFAULT_MAX_FUNCTIONS;
  let started = false;
  /** Per-script resolved source + decoded map, cached across takes. */
  const scriptCache = new Map<string, ScriptInfo>();
  /** Last seen cumulative count per `scriptId|offset` (for delta computation). */
  const prevCounts = new Map<string, number>();
  /** Serialise takes so concurrent click-driven deltas keep consistent baselines. */
  let queue: Promise<unknown> = Promise.resolve();

  const start = async (): Promise<boolean> => {
    try {
      await deps.sendCommand('Profiler.enable');
      await deps.sendCommand('Profiler.startPreciseCoverage', { callCount: true, detailed: true });
      started = true;
      return true;
    } catch {
      started = false;
      return false;
    }
  };

  /** Fetch + decode a served script (cached): source text + inline source map. */
  const infoOf = async (scriptId: string, url: string): Promise<ScriptInfo> => {
    const hit = scriptCache.get(scriptId);
    if (hit) return hit;
    let source = '';
    try {
      const res = (await deps.sendCommand('Debugger.getScriptSource', { scriptId })) as
        | { scriptSource?: string }
        | undefined;
      source = typeof res?.scriptSource === 'string' ? res.scriptSource : '';
    } catch {
      source = '';
    }
    const info: ScriptInfo = {
      source,
      map: source ? extractInlineSourceMap(source) : null,
      urlPath: resolveUrl(url),
    };
    scriptCache.set(scriptId, info);
    return info;
  };

  /**
   * Resolve a function's `(file, line)`: prefer the source map (original file +
   * line), else the served URL path + generated line. Returns null to DROP a
   * function whose file is neither a user source via the map nor via the URL.
   */
  const resolveFn = (info: ScriptInfo, startOffset: number): { file: string; line: number } | null => {
    const pos = info.source ? offsetToPosition(info.source, startOffset) : { line: 0, column: 0 };
    if (info.map) {
      const orig = mapPosition(info.map, pos.line, pos.column);
      if (orig) {
        const file = cleanSource(orig.source);
        if (isUserSourcePath(file)) return { file, line: orig.line };
        // Mapped to vendor — drop (a bundled chunk's vendor frame).
        return null;
      }
    }
    // No map (or position uncovered): fall back to the served URL path.
    if (info.urlPath) return { file: info.urlPath, line: info.source ? pos.line + 1 : 0 };
    return null;
  };

  /** Take coverage and reduce it to ranked user functions using `countFor`. */
  const collect = async (countFor: (key: string, absCount: number) => number): Promise<CoverageFunction[]> => {
    let scripts: ScriptCoverage[] = [];
    try {
      const res = (await deps.sendCommand('Profiler.takePreciseCoverage')) as { result?: ScriptCoverage[] } | undefined;
      scripts = Array.isArray(res?.result) ? res.result : [];
    } catch {
      scripts = [];
    }

    const byKey = new Map<string, CoverageFunction>();
    for (const script of scripts) {
      if (!Array.isArray(script.functions)) continue;
      // Pre-filter to functions with ANY cumulative count, so we only fetch
      // source for scripts that ran at all.
      const ranged = script.functions
        .map((fn) => ({ fn, range: fn.ranges?.[0] }))
        .filter((x): x is { fn: (typeof script.functions)[number]; range: NonNullable<typeof x.range> } =>
          Boolean(x.range)
        );
      if (ranged.length === 0) continue;
      // Compute the per-function count to USE (absolute or delta) up front so a
      // pure-delta take that found nothing new skips the source fetch entirely.
      const useable = ranged
        .map(({ fn, range }) => {
          const key = `${script.scriptId}\u0000${range.startOffset}`;
          const count = countFor(key, range.count);
          return { fn, range, count };
        })
        .filter((x) => x.count > 0);
      if (useable.length === 0) continue;

      // eslint-disable-next-line no-await-in-loop -- sequential keeps CDP calls bounded; script count is small.
      const info = await infoOf(script.scriptId, script.url);
      for (const { fn, range, count } of useable) {
        const resolved = resolveFn(info, range.startOffset);
        if (!resolved) continue;
        const name = fn.functionName && fn.functionName.length > 0 ? fn.functionName : '(anonymous)';
        const key = `${resolved.file}\u0000${name}\u0000${resolved.line}`;
        const existing = byKey.get(key);
        if (existing) existing.callCount += count;
        else byKey.set(key, { file: resolved.file, functionName: name, line: resolved.line, callCount: count });
      }
    }

    return Array.from(byKey.values())
      .toSorted((a, b) => b.callCount - a.callCount || a.file.localeCompare(b.file) || a.line - b.line)
      .slice(0, maxFunctions);
  };

  const takeDelta = async (): Promise<CoverageFunction[]> => {
    if (!started) return [];
    // Serialise: a delta both READS and WRITES prevCounts, so overlapping
    // click-driven takes must not interleave.
    const run = queue.then(() =>
      collect((key, absCount) => {
        const prev = prevCounts.get(key) ?? 0;
        prevCounts.set(key, absCount);
        return absCount - prev;
      }).catch((): CoverageFunction[] => [])
    );
    queue = run;
    return run;
  };

  const finalize = async (): Promise<CoverageFunction[]> => {
    if (!started) return [];
    // Final cumulative total (the whole session) — absolute counts, independent
    // of the delta baseline. Chained after any in-flight delta.
    const run = queue.then(() => collect((_key, absCount) => absCount).catch((): CoverageFunction[] => []));
    queue = run;
    const result = await run;
    await deps.sendCommand('Profiler.stopPreciseCoverage').catch((): void => undefined);
    await deps.sendCommand('Profiler.disable').catch((): void => undefined);
    started = false;
    return result;
  };

  return { start, takeDelta, finalize };
};

export default createCoverageRecorder;

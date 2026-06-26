/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `sourceMap` — a tiny, dependency-free Source Map v3 decoder, just enough to
 * turn a position in a SERVED (transpiled/bundled) script back into the user's
 * ORIGINAL file + line.
 *
 * Why: Quick Test's V8 coverage reports offsets in the file the browser ran —
 * which, under a dev server (Vite, etc.), is transpiled TS/JSX, not the source
 * the user reads. Without mapping, `cart.ts:88` could really be `cart.ts:140`
 * of the generated output — so the agent reads the wrong lines. Vite (and most
 * dev servers) append an INLINE source map (`//# sourceMappingURL=data:…base64`)
 * to each served module; this module extracts and decodes it so coverage points
 * at the real source.
 *
 * Scope: only what coverage needs — inline data-URL maps, the `mappings` VLQ
 * grid, and a nearest-segment lookup `(genLine, genCol) → { source, line }`.
 * It does NOT rewrite stacks or handle external `.map` files (dev servers inline
 * them). Pure + synchronous; unit-tested with hand-built maps.
 *
 * Process boundary: shared TS module (no Node/DOM). Safe to import anywhere.
 */

/** A decoded mapping segment on one generated line (all fields 0-based). */
export type MapSegment = {
  /** Column in the generated line. */
  genCol: number;
  /** Index into {@link DecodedSourceMap.sources}. */
  sourceIndex: number;
  /** 0-based line in the original source. */
  sourceLine: number;
  /** 0-based column in the original source. */
  sourceCol: number;
};

/** A decoded Source Map v3 (only the fields we use). */
export type DecodedSourceMap = {
  /** Original source paths (as the tool wrote them; may be repo-relative-ish). */
  sources: string[];
  /** Per generated line (0-based index), the segments on that line, sorted by genCol. */
  linesSegments: MapSegment[][];
};

/** Base64 alphabet for VLQ decoding. */
const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP: Record<string, number> = (() => {
  const map: Record<string, number> = {};
  for (let i = 0; i < B64.length; i += 1) map[B64[i]] = i;
  return map;
})();

/**
 * Decode a Base64-VLQ string into an array of signed integers. VLQ packs each
 * value as 5-bit groups (low bit = sign on the first group, high bit =
 * continuation). Returns [] on any malformed character.
 */
export const decodeVlq = (segment: string): number[] => {
  const out: number[] = [];
  let shift = 0;
  let value = 0;
  for (const ch of segment) {
    const digit = B64_LOOKUP[ch];
    if (digit === undefined) return [];
    const continuation = digit & 0b100000;
    value += (digit & 0b011111) << shift;
    if (continuation) {
      shift += 5;
    } else {
      const negative = value & 1;
      value >>= 1;
      out.push(negative ? -value : value);
      value = 0;
      shift = 0;
    }
  }
  return out;
};

/**
 * Decode a source map's `mappings` field into a per-generated-line segment grid.
 * Implements the standard running-delta decode (gen col, source index, source
 * line, source col are all delta-encoded across the whole stream; gen col resets
 * per line). The `names` delta (5th field) is ignored — we only need positions.
 */
export const decodeMappings = (mappings: string): MapSegment[][] => {
  const lines: MapSegment[][] = [];
  let sourceIndex = 0;
  let sourceLine = 0;
  let sourceCol = 0;
  for (const lineStr of mappings.split(';')) {
    const segments: MapSegment[] = [];
    let genCol = 0;
    if (lineStr.length > 0) {
      for (const segStr of lineStr.split(',')) {
        if (segStr.length === 0) continue;
        const fields = decodeVlq(segStr);
        if (fields.length === 0) continue;
        genCol += fields[0];
        // A 1-field segment has no source info — skip (it maps to nothing).
        if (fields.length >= 4) {
          sourceIndex += fields[1];
          sourceLine += fields[2];
          sourceCol += fields[3];
          segments.push({ genCol, sourceIndex, sourceLine, sourceCol });
        }
      }
    }
    segments.sort((a, b) => a.genCol - b.genCol);
    lines.push(segments);
  }
  return lines;
};

/**
 * Extract and decode the INLINE source map appended to a served script, or null
 * when there is none / it is external / malformed. Recognises both base64 and
 * URL-encoded `data:` payloads on the last `//# sourceMappingURL=` comment.
 */
export const extractInlineSourceMap = (scriptSource: string): DecodedSourceMap | null => {
  // Use the LAST occurrence (bundlers append it at the very end).
  const marker = '//# sourceMappingURL=';
  const idx = scriptSource.lastIndexOf(marker);
  if (idx < 0) return null;
  const urlLine = scriptSource
    .slice(idx + marker.length)
    .split(/\s/)[0]
    .trim();
  if (!urlLine.startsWith('data:')) return null; // external .map — not supported

  const comma = urlLine.indexOf(',');
  if (comma < 0) return null;
  const meta = urlLine.slice('data:'.length, comma);
  const payload = urlLine.slice(comma + 1);
  let json: string;
  try {
    if (/;base64/i.test(meta)) {
      json = Buffer.from(payload, 'base64').toString('utf-8');
    } else {
      json = decodeURIComponent(payload);
    }
  } catch {
    return null;
  }

  try {
    const parsed = JSON.parse(json) as { sources?: unknown; mappings?: unknown; sourceRoot?: unknown };
    if (!Array.isArray(parsed.sources) || typeof parsed.mappings !== 'string') return null;
    const sources = parsed.sources.map((s) => (typeof s === 'string' ? s : ''));
    return { sources, linesSegments: decodeMappings(parsed.mappings) };
  } catch {
    return null;
  }
};

/** A resolved original position. */
export type OriginalPosition = {
  /** Original source path from the map's `sources` (cleaned of `webpack://`-style prefixes). */
  source: string;
  /** 1-based line in the original source. */
  line: number;
};

/**
 * Map a generated `(line, column)` (both 0-based) to the original source +
 * 1-based line, using the nearest segment at or before the column on that line.
 * Returns null when the line/column is not covered by the map.
 */
export const mapPosition = (map: DecodedSourceMap, genLine: number, genCol: number): OriginalPosition | null => {
  const segments = map.linesSegments[genLine];
  if (!segments || segments.length === 0) return null;
  // Find the last segment whose genCol <= the queried column (binary search).
  let lo = 0;
  let hi = segments.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].genCol <= genCol) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  // Before the first segment — fall back to the first (start of line).
  const seg = best >= 0 ? segments[best] : segments[0];
  const source = map.sources[seg.sourceIndex];
  if (typeof source !== 'string' || source.length === 0) return null;
  return { source: cleanSource(source), line: seg.sourceLine + 1 };
};

/**
 * Clean a source-map `sources` entry into a repo-relative-ish path: strip
 * `webpack://`/`file://` and scheme-ish prefixes, query strings, and leading
 * slashes / `./`. Vite uses paths like `/src/main.ts` or absolute fs paths.
 */
export const cleanSource = (source: string): string => {
  let s = source;
  // Strip a scheme prefix like `webpack://name/` or `file://`.
  s = s.replace(/^[a-z]+:\/\/[^/]*\//i, '').replace(/^[a-z]+:\/\//i, '');
  s = s.split('?')[0].split('#')[0];
  s = s.replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
  return s;
};

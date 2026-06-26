/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests the V8 precise-coverage recorder with a fake CDP `sendCommand`, so the
 * "which of the user's functions executed" logic is verified without a real
 * Electron WebContents / Chromium. Covers URL filtering (vendor noise dropped),
 * offset→line resolution, call-count ranking, source caching, and best-effort
 * teardown on CDP failure.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createCoverageRecorder,
  lineFromOffset,
  resolveCoverageUrl,
  type CoverageCdpSend,
} from '@/process/ide/quickTestCoverage';

describe('resolveCoverageUrl', () => {
  it('keeps the user’s own source files as repo-relative paths', () => {
    expect(resolveCoverageUrl('http://localhost:5173/src/main.js')).toBe('src/main.js');
    expect(resolveCoverageUrl('http://localhost:5173/src/cart/cart.ts?t=123')).toBe('src/cart/cart.ts');
  });

  it('drops vendor / framework-internal / non-code scripts', () => {
    expect(resolveCoverageUrl('http://localhost:5173/node_modules/react/index.js')).toBeNull();
    expect(resolveCoverageUrl('http://localhost:5173/@vite/client')).toBeNull();
    expect(resolveCoverageUrl('http://localhost:5173/@react-refresh')).toBeNull();
    expect(resolveCoverageUrl('http://localhost:5173/src/styles.css')).toBeNull();
    expect(resolveCoverageUrl('')).toBeNull();
    expect(resolveCoverageUrl('node:internal/process')).toBeNull();
  });
});

describe('lineFromOffset', () => {
  it('maps a character offset to a 1-based line', () => {
    const src = 'line1\nline2\nline3';
    expect(lineFromOffset(src, 0)).toBe(1);
    expect(lineFromOffset(src, 6)).toBe(2);
    expect(lineFromOffset(src, 12)).toBe(3);
  });
});

/** Build a fake CDP send that serves canned coverage + script source. */
const makeSend = (overrides: Partial<Record<string, unknown>> = {}): { send: CoverageCdpSend; calls: string[] } => {
  const calls: string[] = [];
  const send = vi.fn(async (method: string) => {
    calls.push(method);
    if (method in overrides) return overrides[method];
    return {};
  }) as unknown as CoverageCdpSend;
  return { send, calls };
};

describe('createCoverageRecorder', () => {
  it('returns the executed user functions ranked by call count', async () => {
    const source = 'function a(){}\nfunction b(){}\nfunction c(){}'; // lines 1,2,3
    const { send } = makeSend({
      'Profiler.takePreciseCoverage': {
        result: [
          {
            scriptId: '1',
            url: 'http://localhost:5173/src/cart.ts',
            functions: [
              { functionName: 'applyDiscount', ranges: [{ startOffset: 0, endOffset: 13, count: 3 }] },
              { functionName: 'formatPrice', ranges: [{ startOffset: 15, endOffset: 28, count: 7 }] },
              { functionName: 'unused', ranges: [{ startOffset: 30, endOffset: 42, count: 0 }] },
            ],
          },
          {
            scriptId: '2',
            url: 'http://localhost:5173/node_modules/react/index.js',
            functions: [{ functionName: 'render', ranges: [{ startOffset: 0, endOffset: 5, count: 99 }] }],
          },
        ],
      },
      'Debugger.getScriptSource': { scriptSource: source },
    });
    const rec = createCoverageRecorder({ sendCommand: send });
    expect(await rec.start()).toBe(true);
    const fns = await rec.finalize();

    // Vendor script dropped; only the two EXECUTED user functions remain.
    expect(fns).toHaveLength(2);
    // Ranked by call count (formatPrice 7 > applyDiscount 3).
    expect(fns[0]).toMatchObject({ file: 'src/cart.ts', functionName: 'formatPrice', callCount: 7, line: 2 });
    expect(fns[1]).toMatchObject({ file: 'src/cart.ts', functionName: 'applyDiscount', callCount: 3, line: 1 });
  });

  it('returns an empty list when nothing was started', async () => {
    const { send } = makeSend();
    const rec = createCoverageRecorder({ sendCommand: send });
    expect(await rec.finalize()).toEqual([]);
  });

  it('starts precise coverage and tears it down on finalize', async () => {
    const { send, calls } = makeSend({ 'Profiler.takePreciseCoverage': { result: [] } });
    const rec = createCoverageRecorder({ sendCommand: send });
    await rec.start();
    await rec.finalize();
    expect(calls).toContain('Profiler.startPreciseCoverage');
    expect(calls).toContain('Profiler.takePreciseCoverage');
    expect(calls).toContain('Profiler.stopPreciseCoverage');
  });

  it('yields an empty list (never throws) when the Profiler cannot start', async () => {
    const send = vi.fn(async (method: string) => {
      if (method === 'Profiler.startPreciseCoverage') throw new Error('not supported');
      return {};
    }) as unknown as CoverageCdpSend;
    const rec = createCoverageRecorder({ sendCommand: send });
    expect(await rec.start()).toBe(false);
    expect(await rec.finalize()).toEqual([]);
  });

  it('caps the result to maxFunctions', async () => {
    const fns = Array.from({ length: 10 }, (_, i) => ({
      functionName: `fn${i}`,
      ranges: [{ startOffset: 0, endOffset: 1, count: i + 1 }],
    }));
    const { send } = makeSend({
      'Profiler.takePreciseCoverage': {
        result: [{ scriptId: '1', url: 'http://localhost:5173/src/a.ts', functions: fns }],
      },
      'Debugger.getScriptSource': { scriptSource: 'x' },
    });
    const rec = createCoverageRecorder({ sendCommand: send, maxFunctions: 3 });
    await rec.start();
    const out = await rec.finalize();
    expect(out).toHaveLength(3);
    expect(out.map((f) => f.callCount)).toEqual([10, 9, 8]);
  });

  it('takeDelta returns only the functions that ran SINCE the previous take', async () => {
    // V8 precise coverage is cumulative; consecutive takes return growing counts.
    // The recorder must report the DELTA so each interaction carries only its own
    // code (the key to per-interaction localisation).
    const takes = [
      // take 1: handleA ran once.
      {
        result: [
          {
            scriptId: '1',
            url: 'http://localhost:5173/src/app.js',
            functions: [
              { functionName: 'handleA', ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] },
              { functionName: 'handleB', ranges: [{ startOffset: 12, endOffset: 22, count: 0 }] },
            ],
          },
        ],
      },
      // take 2 (cumulative): handleA still 1 (no new run), handleB now 1 (just ran).
      {
        result: [
          {
            scriptId: '1',
            url: 'http://localhost:5173/src/app.js',
            functions: [
              { functionName: 'handleA', ranges: [{ startOffset: 0, endOffset: 10, count: 1 }] },
              { functionName: 'handleB', ranges: [{ startOffset: 12, endOffset: 22, count: 1 }] },
            ],
          },
        ],
      },
    ];
    let takeIdx = 0;
    const send = vi.fn(async (method: string) => {
      if (method === 'Profiler.takePreciseCoverage') return takes[Math.min(takeIdx++, takes.length - 1)];
      if (method === 'Debugger.getScriptSource') return { scriptSource: 'function handleA(){}\nfunction handleB(){}' };
      return {};
    }) as unknown as CoverageCdpSend;

    const rec = createCoverageRecorder({ sendCommand: send });
    await rec.start();

    const d1 = await rec.takeDelta();
    expect(d1.map((f) => f.functionName)).toEqual(['handleA']);

    const d2 = await rec.takeDelta();
    // Only handleB is NEW since take 1 — handleA's unchanged count is not re-reported.
    expect(d2.map((f) => f.functionName)).toEqual(['handleB']);
  });

  it('source-maps a served function back to the ORIGINAL file + line', async () => {
    // A generated bundle line 0 maps to src/cart.ts line 5 (1-based) via an inline
    // map. The recorder must report the original file + line, not the served one.
    // Build a minimal inline map: gen (line0,col0) -> source[0], origLine 4 (0-based).
    // VLQ for [0,0,4,0] = "AAIA". Mappings for line 0 = "AAIA".
    const inlineMap = Buffer.from(
      JSON.stringify({ version: 3, sources: ['src/cart.ts'], names: [], mappings: 'AAIA' })
    ).toString('base64');
    const served = 'function x(){}\n//# sourceMappingURL=data:application/json;base64,' + inlineMap;
    const send = vi.fn(async (method: string) => {
      if (method === 'Profiler.takePreciseCoverage') {
        return {
          result: [
            {
              scriptId: '1',
              url: 'http://localhost:5173/src/cart.ts',
              functions: [{ functionName: 'applyDiscount', ranges: [{ startOffset: 0, endOffset: 14, count: 2 }] }],
            },
          ],
        };
      }
      if (method === 'Debugger.getScriptSource') return { scriptSource: served };
      return {};
    }) as unknown as CoverageCdpSend;

    const rec = createCoverageRecorder({ sendCommand: send });
    await rec.start();
    const out = await rec.finalize();
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ file: 'src/cart.ts', functionName: 'applyDiscount', line: 5, callCount: 2 });
  });

  it('drops a function that source-maps INTO vendor (node_modules)', async () => {
    const inlineMap = Buffer.from(
      JSON.stringify({ version: 3, sources: ['node_modules/react/index.js'], names: [], mappings: 'AAAA' })
    ).toString('base64');
    const served = 'function r(){}\n//# sourceMappingURL=data:application/json;base64,' + inlineMap;
    const send = vi.fn(async (method: string) => {
      if (method === 'Profiler.takePreciseCoverage') {
        return {
          result: [
            {
              scriptId: '1',
              url: 'http://localhost:5173/src/app.js',
              functions: [{ functionName: 'render', ranges: [{ startOffset: 0, endOffset: 14, count: 5 }] }],
            },
          ],
        };
      }
      if (method === 'Debugger.getScriptSource') return { scriptSource: served };
      return {};
    }) as unknown as CoverageCdpSend;

    const rec = createCoverageRecorder({ sendCommand: send });
    await rec.start();
    expect(await rec.finalize()).toEqual([]);
  });
});

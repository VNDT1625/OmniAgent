/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for quickTestService — the agent-facing one-shot Quick Test runner.
 * Uses fakes for the web WebContents, the native stream, and the graph loader.
 */

import { describe, expect, it, vi } from 'vitest';
import { createQuickTestService } from '@/process/ide/quickTestService';
import type { CdpWebContents } from '@/process/ide/quickTestTracer';
import type { NativeLogStream } from '@/process/ide/quickTestNativeTracer';
import type { KnowledgeGraph } from '@/process/ide/understandTypes';

/** A fake CDP WebContents whose debugger does nothing (no events recorded). */
const makeFakeWc = (): CdpWebContents => ({
  debugger: {
    attach: vi.fn(),
    detach: vi.fn(),
    sendCommand: vi.fn(async () => ({})),
    on: vi.fn(),
    removeAllListeners: vi.fn(),
    isAttached: vi.fn(() => false),
  },
  executeJavaScript: vi.fn(async () => undefined),
});

/** A controllable fake native stream. */
const makeFakeStream = () => {
  let lineListener: ((line: string) => void) | null = null;
  const stream: NativeLogStream = {
    onLine: (l) => {
      lineListener = l;
    },
    onClose: () => undefined,
    close: vi.fn(),
  };
  return { stream, emit: (line: string) => lineListener?.(line) };
};

describe('quickTestService', () => {
  it('throws a clear error when no folder path is given', async () => {
    const service = createQuickTestService({
      getWebContents: () => null,
      openNativeStream: async () => null,
      loadGraph: async () => null,
    });
    await expect(service.runSession({ platform: 'web', rootPath: '   ' })).rejects.toThrow(/folder path/i);
  });

  it('throws when the web tracer cannot start (no browser tab)', async () => {
    const service = createQuickTestService({
      getWebContents: () => null,
      openNativeStream: async () => null,
      loadGraph: async () => null,
    });
    await expect(service.runSession({ platform: 'web', rootPath: '/repo' })).rejects.toThrow(/browser tab/i);
  });

  it('throws when the android stream cannot open (no device)', async () => {
    const service = createQuickTestService({
      getWebContents: () => null,
      openNativeStream: async () => null,
      loadGraph: async () => null,
    });
    await expect(service.runSession({ platform: 'android', rootPath: '/repo' })).rejects.toThrow(/android/i);
  });

  it('runs a web session and returns a trace (no graph → null contextPack)', async () => {
    let t = 0;
    const service = createQuickTestService({
      getWebContents: () => makeFakeWc(),
      openNativeStream: async () => null,
      loadGraph: async () => null,
      now: () => (t += 100),
      sleep: async () => undefined,
    });
    const result = await service.runSession({ platform: 'web', rootPath: '/repo', durationMs: 300 });
    expect(result.trace.platform).toBe('web');
    expect(result.contextPack).toBeNull();
  });

  it('early-exits the observation window once a first error appears (android)', async () => {
    const fake = makeFakeStream();
    let t = 0;
    const sleep = vi.fn(async () => {
      // Emit a fatal line on the first poll so the loop should break early.
      fake.emit('E/AndroidRuntime( 1): FATAL EXCEPTION: main');
    });
    const service = createQuickTestService({
      getWebContents: () => null,
      openNativeStream: async () => fake.stream,
      loadGraph: async () => null,
      now: () => (t += 100),
      sleep,
    });
    const result = await service.runSession({ platform: 'android', rootPath: '/repo', durationMs: 60000 });
    expect(result.trace.firstError?.kind).toBe('exception');
    // Should have polled only once (broke out after the first error).
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('throws a clear error when the windows app cannot be launched', async () => {
    const service = createQuickTestService({
      getWebContents: () => null,
      openNativeStream: async () => null,
      loadGraph: async () => null,
    });
    await expect(
      service.runSession({ platform: 'windows', rootPath: '/repo', target: 'C:/missing.exe' })
    ).rejects.toThrow(/\.exe|launch/i);
  });

  it('builds a contextPack from the trace + graph when a graph is available', async () => {
    const fake = makeFakeStream();
    let t = 0;
    const sleep = vi.fn(async () => {
      fake.emit('E/AndroidRuntime( 1): FATAL EXCEPTION: main');
    });
    const graph: KnowledgeGraph = {
      rootPath: '/repo',
      version: 2,
      builtAt: 1,
      nodes: [],
      edges: [],
      tours: [],
      truncated: false,
      fileCount: 0,
    };
    const service = createQuickTestService({
      getWebContents: () => null,
      openNativeStream: async () => fake.stream,
      loadGraph: async () => graph,
      now: () => (t += 100),
      sleep,
    });
    const result = await service.runSession({ platform: 'android', rootPath: '/repo', durationMs: 60000 });
    expect(result.contextPack).not.toBeNull();
    expect(result.contextPack?.request).toBe('Quick Test trace');
  });

  it('clamps an over-long duration to the hard cap (no hang)', async () => {
    let t = 0;
    const sleep = vi.fn(async () => undefined);
    const service = createQuickTestService({
      getWebContents: () => makeFakeWc(),
      openNativeStream: async () => null,
      loadGraph: async () => null,
      now: () => (t += 1000),
      sleep,
    });
    // 10 minutes requested → clamped to 60s; with 1000ms/now-tick + 250ms polls
    // the loop ends in a bounded number of iterations rather than spinning.
    await service.runSession({ platform: 'web', rootPath: '/repo', durationMs: 600_000 });
    expect(sleep.mock.calls.length).toBeLessThanOrEqual(61);
  });

  it('uses real timers by default when no clock/sleep is injected', async () => {
    const service = createQuickTestService({
      getWebContents: () => makeFakeWc(),
      openNativeStream: async () => null,
      loadGraph: async () => null,
    });
    // Small window: exercises the default `now` + `defaultSleep` (one real poll).
    const result = await service.runSession({ platform: 'web', rootPath: '/repo', durationMs: 200 });
    expect(result.trace.platform).toBe('web');
  });
});

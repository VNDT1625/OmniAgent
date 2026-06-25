/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DOM tests for {@link useUnderstand} — the IDE "Understand Anything" hook.
 *
 * `./ideClient` and the GenerationProgress side (recordGenDuration/getGenEstimate)
 * are mocked so no IPC and no timers run. The kgEvent mock returns a no-op
 * unsubscribe and captures the listener so a test can emit build phases.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeBuildPhase, KnowledgeGraph, UnderstandResult } from '@process/ide/understandTypes';

const {
  kgGetMock,
  kgBuildMock,
  kgStatusMock,
  onKgEventMock,
  kgWatchStartMock,
  kgWatchStopMock,
  onKgChangedMock,
  recordGenDurationMock,
  kgListenerRef,
  kgChangedListenerRef,
} = vi.hoisted(() => ({
  kgGetMock: vi.fn(),
  kgBuildMock: vi.fn(),
  kgStatusMock: vi.fn(),
  onKgEventMock: vi.fn(),
  kgWatchStartMock: vi.fn(),
  kgWatchStopMock: vi.fn(),
  onKgChangedMock: vi.fn(),
  recordGenDurationMock: vi.fn(),
  kgListenerRef: {
    current: undefined as
      | ((event: { phase: KnowledgeBuildPhase; detail?: string; rootPath?: string }) => void)
      | undefined,
  },
  kgChangedListenerRef: {
    current: undefined as ((event: { rootPath: string; changed: string[]; removed: string[] }) => void) | undefined,
  },
}));

vi.mock('@renderer/pages/studio/ide/ideClient', () => ({
  ideClient: {
    kgGet: kgGetMock,
    kgBuild: kgBuildMock,
    kgStatus: kgStatusMock,
    onKgEvent: onKgEventMock,
    kgWatchStart: kgWatchStartMock,
    kgWatchStop: kgWatchStopMock,
    onKgChanged: onKgChangedMock,
  },
}));

vi.mock('@renderer/pages/studio/components/GenerationProgress', () => ({
  recordGenDuration: recordGenDurationMock,
  getGenEstimate: (_key: string, fallback: number) => fallback,
}));

import { useUnderstand } from '@renderer/pages/studio/ide/useUnderstand';

const ROOT = '/repo';

/** Build a minimal but well-formed knowledge graph for assertions. */
const buildGraph = (overrides: Partial<KnowledgeGraph> = {}): KnowledgeGraph => ({
  rootPath: ROOT,
  version: 1,
  builtAt: 1700000000000,
  nodes: [
    {
      id: 'src/api/index.ts',
      label: 'index.ts',
      group: 'src',
      layer: 'api',
      summary: 'API entry',
      tags: ['entry'],
      symbols: [{ name: 'handler', kind: 'function', line: 12 }],
      language: 'ts',
      importedBy: 3,
    },
  ],
  edges: [{ from: 'src/api/index.ts', to: 'src/util/log.ts' }],
  tours: [{ title: 'Start here', steps: [{ nodeId: 'src/api/index.ts', note: 'The entry point' }] }],
  truncated: false,
  fileCount: 1,
  ...overrides,
});

const ok = <T>(data: T): UnderstandResult<T> => ({ ok: true, data });
const fail = (error: string, code: 'no-model' | 'error' = 'error'): UnderstandResult<never> => ({
  ok: false,
  error,
  code,
});

describe('useUnderstand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    kgListenerRef.current = undefined;
    // Default: no graph persisted; build returns a graph; events captured.
    kgGetMock.mockResolvedValue(ok<KnowledgeGraph | null>(null));
    kgBuildMock.mockResolvedValue(ok(buildGraph()));
    kgStatusMock.mockResolvedValue(ok({ running: false, phase: 'idle', events: [] }));
    kgWatchStartMock.mockResolvedValue(ok(true));
    kgWatchStopMock.mockResolvedValue(ok(true));
    onKgChangedMock.mockReturnValue(vi.fn());
    onKgChangedMock.mockImplementation(
      (listener: (event: { rootPath: string; changed: string[]; removed: string[] }) => void) => {
        kgChangedListenerRef.current = listener;
        return vi.fn();
      }
    );
    onKgEventMock.mockImplementation(
      (listener: (event: { phase: KnowledgeBuildPhase; detail?: string; rootPath?: string }) => void) => {
        kgListenerRef.current = listener;
        return vi.fn();
      }
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts idle with no graph', () => {
    const { result } = renderHook(() => useUnderstand(ROOT));
    expect(result.current.status).toBe('idle');
    expect(result.current.graph).toBeNull();
    expect(result.current.phase).toBe('idle');
    expect(result.current.error).toBeNull();
  });

  it('loadExisting with no persisted graph leaves it idle', async () => {
    const { result } = renderHook(() => useUnderstand(ROOT));
    await act(async () => {
      await result.current.loadExisting();
    });
    expect(kgStatusMock).toHaveBeenCalledWith(ROOT);
    expect(kgGetMock).toHaveBeenCalledWith(ROOT);
    expect(result.current.status).toBe('idle');
    expect(result.current.graph).toBeNull();
  });

  it('loadExisting with a persisted graph becomes ready', async () => {
    const graph = buildGraph();
    kgGetMock.mockResolvedValue(ok<KnowledgeGraph | null>(graph));
    const { result } = renderHook(() => useUnderstand(ROOT));
    await act(async () => {
      await result.current.loadExisting();
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.graph).toEqual(graph);
    expect(result.current.phase).toBe('done');
  });

  it('loadExisting surfaces persisted graph freshness as changed files', async () => {
    const graph = buildGraph();
    kgGetMock.mockResolvedValue(ok<KnowledgeGraph | null>(graph));
    kgStatusMock.mockResolvedValue(
      ok({
        running: false,
        phase: 'idle',
        events: [],
        freshness: {
          fresh: false,
          changed: ['src/api/index.ts'],
          removed: ['src/old.ts'],
          added: ['src/new.ts'],
        },
      })
    );
    const { result } = renderHook(() => useUnderstand(ROOT));

    await act(async () => {
      await result.current.loadExisting();
    });

    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.changedFiles).toEqual(['src/api/index.ts', 'src/old.ts', 'src/new.ts']);
  });

  it('build success sets the graph + ready, records duration, and tracks phases', async () => {
    const graph = buildGraph({ fileCount: 2 });
    // Use a deferred result so the build stays in flight while we assert the
    // intermediate phase, then resolve it explicitly (avoids a resolve race).
    let resolveBuild: ((r: UnderstandResult<KnowledgeGraph>) => void) | undefined;
    kgBuildMock.mockReturnValue(
      new Promise<UnderstandResult<KnowledgeGraph>>((resolve) => {
        resolveBuild = resolve;
      })
    );
    const { result } = renderHook(() => useUnderstand(ROOT));

    let buildPromise: Promise<void>;
    act(() => {
      buildPromise = result.current.build('gpt-test');
    });

    // While in flight: building + a phase event flows through.
    await waitFor(() => expect(result.current.status).toBe('building'));
    expect(onKgEventMock).toHaveBeenCalledTimes(1);
    act(() => {
      kgListenerRef.current?.({ phase: 'summarizing', detail: 'index.ts' });
    });
    expect(result.current.phase).toBe('summarizing');
    expect(result.current.phaseDetail).toBe('index.ts');
    expect(result.current.buildEvents).toEqual([
      expect.objectContaining({ phase: 'scanning', detail: '' }),
      expect.objectContaining({ phase: 'summarizing', detail: 'index.ts' }),
    ]);

    // Now complete the build.
    await act(async () => {
      resolveBuild?.(ok(graph));
      await buildPromise;
    });

    expect(kgBuildMock).toHaveBeenCalledWith(ROOT, 'gpt-test', undefined, false);
    expect(result.current.status).toBe('ready');
    expect(result.current.graph).toEqual(graph);
    expect(result.current.phase).toBe('done');
    expect(result.current.buildEvents.at(-1)).toEqual(expect.objectContaining({ phase: 'done', detail: '' }));
    expect(recordGenDurationMock).toHaveBeenCalledWith('ide.kg', expect.any(Number));
  });

  it('loadExisting attaches to a running background build', async () => {
    kgStatusMock.mockResolvedValue(
      ok({
        running: true,
        phase: 'summarizing',
        detail: '1/2 · src · src/api/index.ts',
        events: [{ phase: 'summarizing', detail: '1/2 · src · src/api/index.ts', at: 1700000000100 }],
      })
    );
    const graph = buildGraph({ fileCount: 2 });
    kgGetMock.mockResolvedValue(ok<KnowledgeGraph | null>(graph));
    const { result } = renderHook(() => useUnderstand(ROOT));

    await act(async () => {
      await result.current.loadExisting();
    });

    expect(result.current.status).toBe('building');
    expect(result.current.phase).toBe('summarizing');
    expect(result.current.phaseDetail).toBe('1/2 · src · src/api/index.ts');
    expect(result.current.buildEvents).toEqual([
      expect.objectContaining({ phase: 'summarizing', detail: '1/2 · src · src/api/index.ts' }),
    ]);
    expect(onKgEventMock).toHaveBeenCalledTimes(1);

    act(() => {
      kgListenerRef.current?.({ phase: 'done' });
    });
    await waitFor(() => expect(result.current.status).toBe('ready'));
    expect(result.current.graph).toEqual(graph);
  });

  it('build failure sets error + error status with the failure code', async () => {
    kgBuildMock.mockResolvedValue(fail('no provider configured', 'no-model'));
    const { result } = renderHook(() => useUnderstand(ROOT));

    await act(async () => {
      await result.current.build('gpt-test');
    });

    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('no provider configured');
    expect(result.current.errorCode).toBe('no-model');
    expect(result.current.graph).toBeNull();
    expect(recordGenDurationMock).not.toHaveBeenCalled();
  });

  it('keeps live watcher running after unmount so changes can still be tracked', () => {
    const { result, unmount } = renderHook(() => useUnderstand(ROOT));

    act(() => {
      result.current.setLive(true, 'gpt-test', 'vi-VN');
    });
    unmount();

    expect(kgWatchStartMock).toHaveBeenCalledWith(ROOT, 'gpt-test', 'vi-VN');
    expect(kgWatchStopMock).not.toHaveBeenCalled();
  });

  it('tracks live changes without starting or attaching to semantic builds', () => {
    kgStatusMock.mockResolvedValue(
      ok({
        running: true,
        queued: false,
        phase: 'scanning',
        events: [{ phase: 'scanning', at: 1700000000100 }],
      })
    );
    const { result } = renderHook(() => useUnderstand(ROOT));

    act(() => {
      result.current.setLive(true, 'gpt-test', 'vi-VN');
    });
    act(() => {
      kgChangedListenerRef.current?.({ rootPath: ROOT, changed: ['src/a.ts'], removed: [] });
    });

    expect(result.current.status).toBe('idle');
    expect(result.current.changedFiles).toEqual(['src/a.ts']);
    expect(kgStatusMock).not.toHaveBeenCalled();
    expect(onKgEventMock).not.toHaveBeenCalled();
    expect(kgBuildMock).not.toHaveBeenCalled();
  });
});

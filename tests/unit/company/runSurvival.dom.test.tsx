/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Regression tests for the user-reported bug: a running company "prompt test"
 * disappeared when switching tabs (the page unmounts) or refreshing the
 * renderer. The fix moves run state into module-level sessions that outlive the
 * component, so:
 *
 *  - **Pipeline**: unmounting the hook no longer stops the run; remounting
 *    re-attaches to the same store and still shows the live snapshot.
 *  - **Conversation**: the Main-process engine keeps streaming; a remounted hook
 *    re-attaches to the persistent session and keeps the transcript/board.
 */

import type { ConversationEvent } from '@/process/company/companyConversation';
import type { CompanyStructure } from '@/process/company/companyOrchestrator';
import type { PipelineStore } from '@/renderer/pages/company/pipeline/pipelineStore';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// --- Pipeline facade mock: capture the store, never stop on its own ----------
const pipelineMock = vi.hoisted(() => ({
  store: null as PipelineStore | null,
  stop: vi.fn(),
  resolveApproval: vi.fn(),
}));
vi.mock('@/renderer/pages/company/pipeline/companyPipeline', () => ({
  runCompany: (input: { store: PipelineStore }) => {
    pipelineMock.store = input.store;
    return {
      runId: 'r1',
      resolveApproval: pipelineMock.resolveApproval,
      stop: pipelineMock.stop,
      done: Promise.resolve(),
    };
  },
}));

// --- Company bridge client mock: a captured event stream + run starter --------
const clientMocks = vi.hoisted(() => ({
  runConversation: vi.fn(),
  resolvePermission: vi.fn(),
  cancelConversation: vi.fn(),
  listeners: [] as Array<(envelope: { event: ConversationEvent }) => void>,
}));
vi.mock('@/renderer/pages/company/companyBridgeClient', () => ({
  companyClient: {
    runConversation: { invoke: clientMocks.runConversation },
    resolvePermission: { invoke: clientMocks.resolvePermission },
    cancelConversation: { invoke: clientMocks.cancelConversation },
  },
  onCompanyConversationEvent: (listener: (envelope: { event: ConversationEvent }) => void) => {
    clientMocks.listeners.push(listener);
    return () => {
      clientMocks.listeners = clientMocks.listeners.filter((l) => l !== listener);
    };
  },
}));

import { resetCompanyPipelineSessions, useCompanyPipeline } from '@/renderer/pages/company/useCompanyPipeline';
import {
  resetCompanyConversationSessions,
  useCompanyConversation,
} from '@/renderer/pages/company/useCompanyConversation';

const STRUCTURE: CompanyStructure = {
  companyId: 'co',
  root: { id: 'co:president', role: 'president', name: 'President', children: [] },
};

const emitConversation = (event: ConversationEvent): void => {
  act(() => {
    for (const l of clientMocks.listeners) l({ event });
  });
};

describe('Company pipeline run survives tab switch (unmount/remount)', () => {
  beforeEach(() => {
    resetCompanyPipelineSessions();
    pipelineMock.store = null;
    pipelineMock.stop.mockReset();
  });
  afterEach(() => cleanup());

  it('does not stop the run on unmount and re-attaches on remount', () => {
    const first = renderHook(() => useCompanyPipeline('co'));
    act(() => {
      first.result.current.start({
        companyName: 'IT',
        structure: STRUCTURE,
        rules: [],
        goal: 'test prompt',
        language: 'en',
      });
    });
    expect(pipelineMock.store).not.toBeNull();

    // The run produces some state.
    act(() => {
      pipelineMock.store?.dispatch({
        type: 'run-started',
        runId: 'r1',
        rootId: 'co:president',
        states: [{ nodeId: 'co:president', name: 'President', role: 'president', activity: 'planning', updatedAt: 1 }],
      });
    });
    expect(first.result.current.running).toBe(true);

    // Switch tabs → the Company page unmounts.
    first.unmount();
    // The fix: unmounting must NOT stop the run.
    expect(pipelineMock.stop).not.toHaveBeenCalled();

    // More progress arrives while no component is mounted.
    act(() => {
      pipelineMock.store?.dispatch({
        type: 'message',
        runId: 'r1',
        message: { id: 'm1', fromId: 'co:president', toId: 'co:president', content: 'working', kind: 'note', at: 2 },
      });
    });

    // Come back to the tab → remount re-attaches to the same live run.
    const second = renderHook(() => useCompanyPipeline('co'));
    expect(second.result.current.running).toBe(true);
    expect(second.result.current.snapshot.messages).toHaveLength(1);
    expect(second.result.current.snapshot.states['co:president']).toBeDefined();
  });

  it('restores an interrupted run as stopped after a reload (fresh sessions + persisted snapshot)', async () => {
    const { result, unmount } = renderHook(() => useCompanyPipeline('co'));
    act(() => {
      result.current.start({ companyName: 'IT', structure: STRUCTURE, rules: [], goal: 'g', language: 'en' });
    });
    act(() => {
      pipelineMock.store?.dispatch({ type: 'run-started', runId: 'r1', rootId: 'co:president', states: [] });
      pipelineMock.store?.dispatch({
        type: 'message',
        runId: 'r1',
        message: { id: 'm1', fromId: 'a', toId: 'b', content: 'hi', kind: 'note', at: 1 },
      });
    });
    unmount();

    // Simulate a renderer reload: a fresh module instance (empty in-memory
    // sessions) but the same `sessionStorage` snapshot survives.
    vi.resetModules();
    const fresh = await import('@/renderer/pages/company/useCompanyPipeline');
    const reopened = renderHook(() => fresh.useCompanyPipeline('co'));
    // Interrupted (was running) → restored as stopped, transcript intact.
    expect(reopened.result.current.snapshot.phase).toBe('stopped');
    expect(reopened.result.current.snapshot.messages).toHaveLength(1);
  });

  it('auto-resumes an interrupted run from its goal after a reload (no prompt)', async () => {
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() => useCompanyPipeline('co'));
      act(() => {
        result.current.start({
          companyName: 'IT',
          structure: STRUCTURE,
          rules: [],
          goal: 'do the thing',
          language: 'en',
        });
      });
      // Mark it running (interrupted state) before the "reload".
      act(() => {
        pipelineMock.store?.dispatch({ type: 'run-started', runId: 'r1', rootId: 'co:president', states: [] });
      });
      unmount();

      // Simulate a renderer reload: fresh module instance, same sessionStorage.
      vi.resetModules();
      // Re-mock the facade BEFORE importing the fresh module graph (vitest v4
      // applies doMock only to imports that happen after the call) and capture
      // the resumed input.
      let resumed: { goal?: string; store?: PipelineStore } | null = null;
      vi.doMock('@/renderer/pages/company/pipeline/companyPipeline', () => ({
        runCompany: (input: { goal: string; store: PipelineStore }) => {
          resumed = { goal: input.goal, store: input.store };
          return { runId: 'r2', resolveApproval: vi.fn(), stop: vi.fn(), done: Promise.resolve() };
        },
      }));
      const fresh = await import('@/renderer/pages/company/useCompanyPipeline');

      renderHook(() => fresh.useCompanyPipeline('co'));
      // The auto-resume runs on a deferred tick.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      // The same goal was restarted automatically — no user action needed.
      expect(resumed).not.toBeNull();
      expect((resumed as { goal?: string }).goal).toBe('do the thing');
    } finally {
      vi.useRealTimers();
      vi.doUnmock('@/renderer/pages/company/pipeline/companyPipeline');
    }
  });

  it('auto-resumes via the app-level scan WITHOUT opening the Company page', async () => {
    vi.useFakeTimers();
    try {
      const { result, unmount } = renderHook(() => useCompanyPipeline('co'));
      act(() => {
        result.current.start({
          companyName: 'IT',
          structure: STRUCTURE,
          rules: [],
          goal: 'background goal',
          language: 'en',
        });
      });
      // Mark it running (interrupted) before the "reload".
      act(() => {
        pipelineMock.store?.dispatch({ type: 'run-started', runId: 'r1', rootId: 'co:president', states: [] });
      });
      unmount();

      // Simulate a renderer reload: fresh module instance, same sessionStorage.
      vi.resetModules();
      // Re-mock BEFORE importing the fresh module graph (vitest v4 applies
      // doMock only to subsequent imports).
      let resumed: { goal?: string } | null = null;
      vi.doMock('@/renderer/pages/company/pipeline/companyPipeline', () => ({
        runCompany: (input: { goal: string; store: PipelineStore }) => {
          resumed = { goal: input.goal };
          return { runId: 'r2', resolveApproval: vi.fn(), stop: vi.fn(), done: Promise.resolve() };
        },
      }));
      const fresh = await import('@/renderer/pages/company/useCompanyPipeline');

      // The app boot scan runs — note: NO renderHook / no Company page mount.
      act(() => {
        fresh.resumeInterruptedCompanyRuns();
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      // The interrupted run was restarted from its goal purely by the boot scan.
      expect(resumed).not.toBeNull();
      expect((resumed as { goal?: string }).goal).toBe('background goal');
    } finally {
      vi.useRealTimers();
      vi.doUnmock('@/renderer/pages/company/pipeline/companyPipeline');
    }
  });
});

describe('Company conversation run survives tab switch + reload', () => {
  beforeEach(() => {
    resetCompanyConversationSessions();
    clientMocks.runConversation.mockReset();
    clientMocks.listeners = [];
    clientMocks.runConversation.mockResolvedValue({ ok: true, data: { runId: 'r1', summary: '', status: 'done' } });
  });
  afterEach(() => cleanup());

  it('keeps streaming into the session while unmounted and re-attaches on remount', async () => {
    const first = renderHook(() => useCompanyConversation('co'));
    await act(async () => {
      await first.result.current.start('test prompt');
    });
    emitConversation({
      type: 'run-started',
      runId: 'r1',
      goal: 'g',
      participants: [{ id: 'co:president', name: 'President', role: 'president' }],
    });
    expect(first.result.current.phase).toBe('running');

    // Switch tabs (unmount). The Main-process engine keeps streaming.
    first.unmount();
    emitConversation({
      type: 'message',
      runId: 'r1',
      message: {
        id: 'm1',
        fromId: 'co:president',
        toId: 'co:president',
        content: 'still working',
        kind: 'directive',
        at: 2,
      },
    });

    // Return to the tab → remount sees the live transcript.
    const second = renderHook(() => useCompanyConversation('co'));
    expect(second.result.current.phase).toBe('running');
    expect(second.result.current.messages).toHaveLength(1);
    expect(second.result.current.messages[0].content).toBe('still working');
  });
});

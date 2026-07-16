/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests the Quick Test IPC bridge. The `@office-ai/platform` bridge providers
 * register handlers onto channel names; we capture them via a mock so we can
 * invoke `start`/`stop` directly and assert the {@link UnderstandResult} envelope
 * + that recorded events are streamed through the `ide.qt-event` emitter.
 *
 * Everything OS/Electron-touching (WebContents, native stream, graph loader) is
 * injected, so no real Electron/adb is needed.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

const { handlers, emitted } = vi.hoisted(() => ({
  handlers: new Map<string, (req: unknown) => unknown>(),
  emitted: [] as unknown[],
}));

vi.mock('@office-ai/platform', () => ({
  bridge: {
    buildProvider: vi.fn((channel: string) => ({
      provider: vi.fn((handler: (req: unknown) => unknown) => {
        handlers.set(channel, handler);
        return vi.fn();
      }),
      invoke: vi.fn(),
    })),
    buildEmitter: vi.fn(() => ({
      emit: vi.fn((payload: unknown) => emitted.push(payload)),
      on: vi.fn(),
    })),
  },
}));

import {
  registerQuickTestBridge,
  QT_CHANNELS,
  type QtStartRequest,
  type QtStopResponse,
} from '@/process/ide/quickTestBridge';
import type { CdpWebContents } from '@/process/ide/quickTestTracer';
import type { NativeLogStream } from '@/process/ide/quickTestNativeTracer';
import type { KnowledgeGraph, UnderstandResult } from '@/process/ide/understandTypes';

type Ok<T> = { ok: true; data: T };
const asOk = <T>(r: UnderstandResult<T>): Ok<T> => {
  if (!r.ok) throw new Error(`expected ok, got error: ${(r as { error: string }).error}`);
  return r as Ok<T>;
};

/** A fake CDP WebContents that captures the message listener so we can fire events. */
const makeFakeWc = (renderedText = '') => {
  let listener: ((evt: unknown, method: string, params: Record<string, unknown>) => void) | null = null;
  const wc: CdpWebContents = {
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(async () => ({})),
      on: vi.fn((_e, l) => {
        listener = l;
      }),
      removeAllListeners: vi.fn(),
      isAttached: vi.fn(() => false),
    },
    executeJavaScript: vi.fn(async () => renderedText),
  };
  return { wc, fire: (method: string, params: Record<string, unknown>) => listener?.(null, method, params) };
};

/** A controllable fake native log stream. */
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

const emptyGraph = (rootPath: string): KnowledgeGraph => ({
  rootPath,
  version: 2,
  builtAt: 1,
  nodes: [],
  edges: [],
  tours: [],
  truncated: false,
  fileCount: 0,
});

const start = (req: QtStartRequest) => handlers.get(QT_CHANNELS.start)?.(req) as Promise<UnderstandResult<boolean>>;
const stop = () => handlers.get(QT_CHANNELS.stop)?.(undefined) as Promise<UnderstandResult<QtStopResponse>>;

beforeEach(() => {
  handlers.clear();
  emitted.length = 0;
});

describe('registerQuickTestBridge', () => {
  it('rejects start with an empty folder path', async () => {
    registerQuickTestBridge({
      getWebContents: () => null,
      loadGraph: async () => null,
      openNativeStream: async () => null,
    });
    const res = await start({ rootPath: '   ' });
    expect(res.ok).toBe(false);
  });

  it('starts a web session, streams events, and returns a trace + contextPack on stop', async () => {
    const { wc, fire } = makeFakeWc();
    registerQuickTestBridge({
      getWebContents: () => wc,
      loadGraph: async (root) => emptyGraph(root),
      openNativeStream: async () => null,
    });

    const started = await start({ rootPath: '/repo', platform: 'web' });
    expect(asOk(started).data).toBe(true);

    // A recorded event is streamed live through the qt-event emitter.
    fire('Runtime.exceptionThrown', { exceptionDetails: { text: 'boom', exception: { description: 'Error: boom' } } });
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { event: { kind: string } }).event.kind).toBe('exception');

    const stopped = await stop();
    const data = asOk(stopped).data;
    expect(data.trace.platform).toBe('web');
    expect(data.trace.firstError?.kind).toBe('exception');
    expect(data.contextPack).not.toBeNull(); // graph loaded → pack built
  });

  it('streams only significant events (routine logs stay in the trace, not the live feed)', async () => {
    const { wc, fire } = makeFakeWc();
    registerQuickTestBridge({
      getWebContents: () => wc,
      loadGraph: async () => null,
      openNativeStream: async () => null,
    });
    await start({ rootPath: '/repo', platform: 'web' });

    // A routine console.log is recorded but NOT streamed.
    fire('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'chatty log' }] });
    expect(emitted).toHaveLength(0);

    // A click marker IS significant → streamed live.
    fire('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ value: '[omni-qt-click]{\u0022selector\u0022:\u0022button#go\u0022,\u0022text\u0022:\u0022Go\u0022}' }],
    });
    expect(emitted).toHaveLength(1);
    expect((emitted[0] as { event: { kind: string } }).event.kind).toBe('click');

    // The routine log still survives in the final trace.
    const data = asOk(await stop()).data;
    expect(data.trace.events.some((e) => e.kind === 'console' && e.message === 'chatty log')).toBe(true);
  });

  it('evaluates an explicit expected-text assertion against the rendered page', async () => {
    const { wc } = makeFakeWc('Dashboard ready');
    registerQuickTestBridge({
      getWebContents: () => wc,
      loadGraph: async () => null,
      openNativeStream: async () => null,
    });

    await start({ rootPath: '/repo', platform: 'web', expectedText: 'dashboard READY' });
    const passed = asOk(await stop()).data.verification;
    expect(passed).toEqual({ kind: 'text', expected: 'dashboard READY', passed: true });

    await start({ rootPath: '/repo', platform: 'web', expectedText: 'Missing state' });
    const failed = asOk(await stop()).data.verification;
    expect(failed).toEqual({ kind: 'text', expected: 'Missing state', passed: false });
  });

  it('returns observation-only output when no pass condition is provided', async () => {
    const { wc } = makeFakeWc('Dashboard ready');
    registerQuickTestBridge({
      getWebContents: () => wc,
      loadGraph: async () => null,
      openNativeStream: async () => null,
    });

    await start({ rootPath: '/repo', platform: 'web' });
    expect(asOk(await stop()).data.verification).toBeNull();
  });

  it('returns data:false when starting web with no browser tab open', async () => {
    registerQuickTestBridge({
      getWebContents: () => null,
      loadGraph: async () => null,
      openNativeStream: async () => null,
    });
    const res = await start({ rootPath: '/repo', platform: 'web' });
    expect(asOk(res).data).toBe(false);
    expect(emitted).toHaveLength(0);
  });

  it('starts an android session via the native stream and streams parsed lines', async () => {
    const fake = makeFakeStream();
    registerQuickTestBridge({
      getWebContents: () => null,
      loadGraph: async () => null,
      openNativeStream: async () => fake.stream,
    });

    const started = await start({ rootPath: '/repo', platform: 'android', target: 'emulator-5554' });
    expect(asOk(started).data).toBe(true);

    fake.emit('E/AndroidRuntime( 1): FATAL EXCEPTION: main');
    expect(emitted).toHaveLength(1);

    const stopped = await stop();
    const data = asOk(stopped).data;
    expect(data.trace.platform).toBe('android');
    expect(data.trace.firstError?.kind).toBe('exception');
    expect(data.contextPack).toBeNull(); // no graph
  });

  it('returns data:false when the android stream cannot open (no device)', async () => {
    registerQuickTestBridge({
      getWebContents: () => null,
      loadGraph: async () => null,
      openNativeStream: async () => null,
    });
    const res = await start({ rootPath: '/repo', platform: 'android' });
    expect(asOk(res).data).toBe(false);
  });

  it('stop without an active session returns an empty web trace (no throw)', async () => {
    registerQuickTestBridge({
      getWebContents: () => null,
      loadGraph: async () => null,
      openNativeStream: async () => null,
    });
    const stopped = await stop();
    const data = asOk(stopped).data;
    expect(data.trace.events).toHaveLength(0);
    expect(data.trace.firstError).toBeNull();
  });

  it('survives a loadGraph failure on stop (best-effort contextPack)', async () => {
    const { wc } = makeFakeWc();
    registerQuickTestBridge({
      getWebContents: () => wc,
      loadGraph: async () => {
        throw new Error('disk error');
      },
      openNativeStream: async () => null,
    });
    await start({ rootPath: '/repo', platform: 'web' });
    const stopped = await stop();
    expect(asOk(stopped).data.contextPack).toBeNull();
  });
});

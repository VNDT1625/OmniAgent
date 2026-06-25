/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for quickTestTracer — CDP-based runtime trace recorder.
 * Uses a fake WebContents (no real Electron/CDP).
 */

import { describe, expect, it, vi } from 'vitest';
import { createQuickTestTracer, type CdpWebContents, type TraceEvent } from '@/process/ide/quickTestTracer';

/** Build a fake CdpWebContents that captures CDP commands + fires events. */
const makeFakeWc = () => {
  let messageListener: ((evt: unknown, method: string, params: Record<string, unknown>) => void) | null = null;
  const sentCommands: string[] = [];
  const executedScripts: string[] = [];

  const wc: CdpWebContents = {
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      sendCommand: vi.fn(async (method: string) => {
        sentCommands.push(method);
        return {};
      }),
      on: vi.fn((_event, listener) => {
        messageListener = listener;
      }),
      removeAllListeners: vi.fn(),
      isAttached: vi.fn(() => false),
    },
    executeJavaScript: vi.fn(async (code: string) => {
      executedScripts.push(code);
      return undefined;
    }),
  };

  const fireMessage = (method: string, params: Record<string, unknown>): void => {
    messageListener?.(null, method, params);
  };

  return { wc, sentCommands, executedScripts, fireMessage };
};

describe('createQuickTestTracer', () => {
  it('returns false when no WebContents is available (native target)', async () => {
    const tracer = createQuickTestTracer({ getWebContents: () => null });
    const started = await tracer.start('/repo');
    expect(started).toBe(false);
    expect(tracer.isActive()).toBe(false);
  });

  it('attaches CDP and enables domains on start', async () => {
    const { wc, sentCommands } = makeFakeWc();
    const tracer = createQuickTestTracer({ getWebContents: () => wc });
    const started = await tracer.start('/repo');
    expect(started).toBe(true);
    expect(tracer.isActive()).toBe(true);
    expect(wc.debugger.attach).toHaveBeenCalledWith('1.3');
    expect(sentCommands).toContain('Network.enable');
    expect(sentCommands).toContain('Runtime.enable');
  });

  it('records a console error event', async () => {
    const { wc, fireMessage } = makeFakeWc();
    const tracer = createQuickTestTracer({ getWebContents: () => wc, now: () => 1000 });
    await tracer.start('/repo');
    fireMessage('Runtime.consoleAPICalled', {
      type: 'error',
      args: [{ value: 'Something went wrong' }],
    });
    const events = tracer.currentEvents();
    expect(events.some((e) => e.kind === 'console' && e.level === 'error')).toBe(true);
  });

  it('records a network error event (status >= 400)', async () => {
    const { wc, fireMessage } = makeFakeWc();
    const tracer = createQuickTestTracer({ getWebContents: () => wc, now: () => 1000 });
    await tracer.start('/repo');
    fireMessage('Network.responseReceived', {
      response: { url: 'http://localhost/api/login', status: 500 },
      request: { method: 'POST' },
    });
    const events = tracer.currentEvents();
    expect(events.some((e) => e.kind === 'network' && e.status === 500)).toBe(true);
  });

  it('records a failed network request (Network.loadingFailed)', async () => {
    const { wc, fireMessage } = makeFakeWc();
    const tracer = createQuickTestTracer({ getWebContents: () => wc, now: () => 1000 });
    await tracer.start('/repo');
    fireMessage('Network.loadingFailed', { request: { url: 'http://localhost/api/x' }, errorText: 'net::ERR_CONNECTION_REFUSED' });
    const ev = tracer.currentEvents().find((e) => e.kind === 'network');
    expect(ev).toMatchObject({ kind: 'network', status: 0, error: 'net::ERR_CONNECTION_REFUSED' });
    // A transport failure (status 0 + error) now counts as an error → early-exit.
    expect(tracer.hasError()).toBe(true);
  });

  it('returns false and stays inactive when CDP attach throws', async () => {
    const { wc } = makeFakeWc();
    (wc.debugger.attach as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('debugger in use');
    });
    const tracer = createQuickTestTracer({ getWebContents: () => wc });
    const started = await tracer.start('/repo');
    expect(started).toBe(false);
    expect(tracer.isActive()).toBe(false);
  });

  it('keeps a malformed DOM marker as a console event (no crash)', async () => {
    const { wc, fireMessage } = makeFakeWc();
    const tracer = createQuickTestTracer({ getWebContents: () => wc, now: () => 1000 });
    await tracer.start('/repo');
    fireMessage('Runtime.consoleAPICalled', { type: 'log', args: [{ value: '[omni-qt-click]{not valid json' }] });
    const events = tracer.currentEvents();
    expect(events).toHaveLength(1);
    expect(events[0].kind).toBe('console');
  });

  it('keeps a malformed [omni-qt-input] marker as a console event', async () => {
    const { wc, fireMessage } = makeFakeWc();
    const tracer = createQuickTestTracer({ getWebContents: () => wc, now: () => 1000 });
    await tracer.start('/repo');
    fireMessage('Runtime.consoleAPICalled', { type: 'log', args: [{ value: '[omni-qt-input]{broken' }] });
    expect(tracer.currentEvents()[0]?.kind).toBe('console');
  });

  it('ignores CDP messages it does not handle', async () => {
    const { wc, fireMessage } = makeFakeWc();
    const tracer = createQuickTestTracer({ getWebContents: () => wc, now: () => 1000 });
    await tracer.start('/repo');
    fireMessage('Debugger.scriptParsed', { scriptId: '1' });
    expect(tracer.currentEvents()).toHaveLength(0);
  });

  it('is idempotent: a second start() while active returns true without re-attaching', async () => {
    const { wc } = makeFakeWc();
    const tracer = createQuickTestTracer({ getWebContents: () => wc });
    await tracer.start('/repo');
    (wc.debugger.attach as ReturnType<typeof vi.fn>).mockClear();
    const again = await tracer.start('/repo');
    expect(again).toBe(true);
    expect(wc.debugger.attach).not.toHaveBeenCalled();
  });

  it('records an exception event', async () => {
    const { wc, fireMessage } = makeFakeWc();
    const tracer = createQuickTestTracer({ getWebContents: () => wc, now: () => 1000 });
    await tracer.start('/repo');
    fireMessage('Runtime.exceptionThrown', {
      exceptionDetails: {
        text: 'Uncaught TypeError',
        exception: { description: 'TypeError: null\n  at foo.ts:10' },
        url: 'http://localhost/foo.ts',
        lineNumber: 10,
      },
    });
    const events = tracer.currentEvents();
    expect(events.some((e) => e.kind === 'exception')).toBe(true);
  });

  it('stop returns a RuntimeTrace with firstError set', async () => {
    const { wc, fireMessage } = makeFakeWc();
    // Make isAttached return true after attach so detach is called on stop.
    (wc.debugger.isAttached as ReturnType<typeof vi.fn>).mockReturnValue(true);
    const tracer = createQuickTestTracer({ getWebContents: () => wc, now: () => 1000 });
    await tracer.start('/repo');
    fireMessage('Runtime.exceptionThrown', {
      exceptionDetails: {
        text: 'Uncaught',
        exception: { description: 'TypeError: oops' },
        url: '',
        lineNumber: 0,
      },
    });
    const trace = tracer.stop();
    expect(trace.platform).toBe('web');
    expect(trace.rootPath).toBe('/repo');
    expect(trace.firstError).not.toBeNull();
    expect(trace.firstError?.kind).toBe('exception');
    expect(tracer.isActive()).toBe(false);
    expect(wc.debugger.detach).toHaveBeenCalled();
  });

  it('parses [omni-qt-click] console messages into click events', async () => {
    const { wc, fireMessage } = makeFakeWc();
    const tracer = createQuickTestTracer({ getWebContents: () => wc, now: () => 1000 });
    await tracer.start('/repo');
    fireMessage('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ value: '[omni-qt-click]{"selector":"button#login","text":"Login"}' }],
    });
    const trace = tracer.stop();
    expect(trace.events.some((e) => e.kind === 'click' && e.selector === 'button#login')).toBe(true);
  });

  it('parses DOM markers at record time (live), not only on stop', async () => {
    const { wc, fireMessage } = makeFakeWc();
    const streamed: TraceEvent[] = [];
    const tracer = createQuickTestTracer({ getWebContents: () => wc, now: () => 1000, onEvent: (e) => streamed.push(e) });
    await tracer.start('/repo');
    fireMessage('Runtime.consoleAPICalled', {
      type: 'log',
      args: [{ value: '[omni-qt-input]{"selector":"input#email","value":"a@b.co"}' }],
    });
    // Already a typed `input` event in the live buffer + stream (not raw console).
    expect(tracer.currentEvents().some((e) => e.kind === 'input' && e.selector === 'input#email')).toBe(true);
    expect(streamed[0]?.kind).toBe('input');
  });

  it('keeps the interaction path under heavy log pressure (markers are significant)', async () => {
    const { wc, fireMessage } = makeFakeWc();
    const tracer = createQuickTestTracer({ getWebContents: () => wc, now: () => 1000 });
    await tracer.start('/repo');
    fireMessage('Runtime.consoleAPICalled', { type: 'log', args: [{ value: '[omni-qt-click]{"selector":"button#buy","text":"Buy"}' }] });
    // Flood with routine logs well past the buffer cap.
    for (let i = 0; i < 300; i += 1) {
      fireMessage('Runtime.consoleAPICalled', { type: 'log', args: [{ value: `noise ${i}` }] });
    }
    const trace = tracer.stop();
    expect(trace.events.some((e) => e.kind === 'click' && e.selector === 'button#buy')).toBe(true);
  });

  it('records a top-level navigation and re-injects DOM listeners', async () => {
    const { wc, executedScripts, fireMessage } = makeFakeWc();
    const tracer = createQuickTestTracer({ getWebContents: () => wc, now: () => 1000 });
    await tracer.start('/repo');
    expect(executedScripts).toHaveLength(1); // injected once on start
    fireMessage('Page.frameNavigated', { frame: { url: 'http://localhost/page2' } });
    const events = tracer.currentEvents();
    expect(events.some((e) => e.kind === 'navigate' && e.url === 'http://localhost/page2')).toBe(true);
    expect(executedScripts).toHaveLength(2); // re-injected after navigation
  });

  it('ignores sub-frame navigations and about:blank', async () => {
    const { wc, executedScripts, fireMessage } = makeFakeWc();
    const tracer = createQuickTestTracer({ getWebContents: () => wc, now: () => 1000 });
    await tracer.start('/repo');
    fireMessage('Page.frameNavigated', { frame: { url: 'http://localhost/iframe', parentId: 'parent-1' } });
    fireMessage('Page.frameNavigated', { frame: { url: 'about:blank' } });
    expect(tracer.currentEvents().some((e) => e.kind === 'navigate')).toBe(false);
    expect(executedScripts).toHaveLength(1); // no re-injection for sub-frame / blank
  });

  it('exposes hasError() and a monotonic recordedCount()', async () => {
    const { wc, fireMessage } = makeFakeWc();
    const tracer = createQuickTestTracer({ getWebContents: () => wc, now: () => 1000 });
    await tracer.start('/repo');
    expect(tracer.hasError()).toBe(false);
    expect(tracer.recordedCount()).toBe(0);

    fireMessage('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'just a log' }] });
    expect(tracer.hasError()).toBe(false);
    expect(tracer.recordedCount()).toBe(1);

    fireMessage('Runtime.exceptionThrown', { exceptionDetails: { text: 'boom', exception: { description: 'Error: boom' } } });
    expect(tracer.hasError()).toBe(true);
    expect(tracer.recordedCount()).toBe(2);
  });

  it('streams every recorded event through the onEvent sink', async () => {
    const { wc, fireMessage } = makeFakeWc();
    const seen: string[] = [];
    const tracer = createQuickTestTracer({
      getWebContents: () => wc,
      now: () => 1000,
      onEvent: (e) => seen.push(e.kind),
    });
    await tracer.start('/repo');
    fireMessage('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'err' }] });
    fireMessage('Network.responseReceived', { response: { url: 'http://localhost/x', status: 200 }, request: { method: 'GET' } });
    expect(seen).toEqual(['console', 'network']);
  });

  it('ignores a network response that carries no URL', async () => {
    const { wc, fireMessage } = makeFakeWc();
    const tracer = createQuickTestTracer({ getWebContents: () => wc, now: () => 1000 });
    await tracer.start('/repo');
    fireMessage('Network.responseReceived', { response: { status: 200 }, request: { method: 'GET' } });
    expect(tracer.currentEvents()).toHaveLength(0);
  });

  it('stops cleanly even when the WebContents is gone at stop time', async () => {
    const { wc } = makeFakeWc();
    let live: CdpWebContents | null = wc;
    const tracer = createQuickTestTracer({ getWebContents: () => live, now: () => 1000 });
    await tracer.start('/repo');
    live = null; // tab closed before stop
    const trace = tracer.stop();
    expect(trace.platform).toBe('web');
    expect(tracer.isActive()).toBe(false);
  });
});

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for quickTestNativeTracer — the native (android/windows) runtime
 * trace recorder. Uses a fake NativeLogStream (no real adb/emulator/exe).
 */

import { describe, expect, it } from 'vitest';
import { createQuickTestNativeTracer, mapNativeLogLine, type NativeLogStream } from '@/process/ide/quickTestNativeTracer';

/** Build a fake NativeLogStream the test can drive by emitting lines/close. */
const makeFakeStream = () => {
  let lineListener: ((line: string) => void) | null = null;
  let closeListener: ((info: { code: number | null }) => void) | null = null;
  let closed = false;

  const stream: NativeLogStream = {
    onLine: (listener) => {
      lineListener = listener;
    },
    onClose: (listener) => {
      closeListener = listener;
    },
    close: () => {
      closed = true;
    },
  };

  return {
    stream,
    emit: (line: string) => lineListener?.(line),
    fireClose: (code: number | null) => closeListener?.({ code }),
    isClosed: () => closed,
  };
};

describe('mapNativeLogLine', () => {
  it('maps an Android FATAL EXCEPTION line to an exception event', () => {
    const ev = mapNativeLogLine('E/AndroidRuntime( 1234): FATAL EXCEPTION: main', 1000);
    expect(ev?.kind).toBe('exception');
  });

  it('maps an E/ priority line to a console error', () => {
    const ev = mapNativeLogLine('E/MyApp( 1234): something failed to load', 1000);
    expect(ev).toEqual({ kind: 'console', level: 'error', message: 'something failed to load', at: 1000 });
  });

  it('maps a W/ priority line to a console warning', () => {
    const ev = mapNativeLogLine('W/MyApp( 1234): deprecated API used', 1000);
    expect(ev?.kind).toBe('console');
    expect(ev).toMatchObject({ level: 'warn' });
  });

  it('maps an untagged stdio line with an error word to a console error', () => {
    const ev = mapNativeLogLine('Unhandled exception: NullReferenceException', 1000);
    expect(ev?.kind).toBe('exception');
  });

  it('skips blank lines', () => {
    expect(mapNativeLogLine('   ', 1000)).toBeNull();
  });
});

describe('createQuickTestNativeTracer', () => {
  it('returns false when the stream opener yields null (no tooling/target)', async () => {
    const tracer = createQuickTestNativeTracer({ openStream: async () => null });
    const started = await tracer.start('android', '/repo', '');
    expect(started).toBe(false);
    expect(tracer.isActive()).toBe(false);
  });

  it('returns false for the web platform (handled by the CDP tracer)', async () => {
    const { stream } = makeFakeStream();
    const tracer = createQuickTestNativeTracer({ openStream: async () => stream });
    const started = await tracer.start('web', '/repo', '');
    expect(started).toBe(false);
  });

  it('records parsed log lines while active', async () => {
    const fake = makeFakeStream();
    const tracer = createQuickTestNativeTracer({ openStream: async () => fake.stream, now: () => 1000 });
    const started = await tracer.start('android', '/repo', 'emulator-5554');
    expect(started).toBe(true);
    expect(tracer.isActive()).toBe(true);

    fake.emit('E/MyApp( 1): boom');
    const events = tracer.currentEvents();
    expect(events.some((e) => e.kind === 'console' && e.level === 'error')).toBe(true);
  });

  it('stop returns a trace with the right platform + firstError and closes the stream', async () => {
    const fake = makeFakeStream();
    const tracer = createQuickTestNativeTracer({ openStream: async () => fake.stream, now: () => 1000 });
    await tracer.start('android', '/repo', 'emulator-5554');
    fake.emit('E/AndroidRuntime( 1): FATAL EXCEPTION: main');
    const trace = tracer.stop();

    expect(trace.platform).toBe('android');
    expect(trace.rootPath).toBe('/repo');
    expect(trace.firstError?.kind).toBe('exception');
    expect(tracer.isActive()).toBe(false);
    expect(fake.isClosed()).toBe(true);
  });

  it('records a non-zero exit as an exception event', async () => {
    const fake = makeFakeStream();
    const tracer = createQuickTestNativeTracer({ openStream: async () => fake.stream, now: () => 1000 });
    await tracer.start('windows', '/repo', 'C:/app.exe');
    fake.fireClose(1);
    const trace = tracer.stop();
    expect(trace.platform).toBe('windows');
    expect(trace.events.some((e) => e.kind === 'exception')).toBe(true);
  });

  it('exposes hasError() and a monotonic recordedCount()', async () => {
    const fake = makeFakeStream();
    const tracer = createQuickTestNativeTracer({ openStream: async () => fake.stream, now: () => 1000 });
    await tracer.start('android', '/repo', 'emulator-5554');
    expect(tracer.hasError()).toBe(false);
    expect(tracer.recordedCount()).toBe(0);

    fake.emit('I/MyApp( 1): just info');
    expect(tracer.hasError()).toBe(false);
    expect(tracer.recordedCount()).toBe(1);

    fake.emit('E/MyApp( 1): boom');
    expect(tracer.hasError()).toBe(true);
    expect(tracer.recordedCount()).toBe(2);
  });

  it('streams every recorded event through the onEvent sink', async () => {
    const fake = makeFakeStream();
    const seen: string[] = [];
    const tracer = createQuickTestNativeTracer({ openStream: async () => fake.stream, now: () => 1000, onEvent: (e) => seen.push(e.kind) });
    await tracer.start('android', '/repo', 'emulator-5554');
    fake.emit('I/MyApp( 1): hi');
    fake.emit('E/MyApp( 1): boom');
    expect(seen).toEqual(['console', 'console']);
  });

  it('does not record after stop (stream silenced)', async () => {
    const fake = makeFakeStream();
    const tracer = createQuickTestNativeTracer({ openStream: async () => fake.stream, now: () => 1000 });
    await tracer.start('android', '/repo', 'emulator-5554');
    tracer.stop();
    fake.emit('E/MyApp( 1): late');
    expect(tracer.recordedCount()).toBe(0);
  });
});

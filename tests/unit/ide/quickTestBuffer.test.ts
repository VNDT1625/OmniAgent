/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for quickTestBuffer — the shared rolling-buffer policy (smart
 * eviction) + error precedence used by both Quick Test tracers. Pure module,
 * no fakes needed.
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_TRACE_EVENTS,
  findFirstError,
  isErrorEvent,
  isSignificantEvent,
  pushBounded,
} from '@/process/ide/quickTestBuffer';
import type { TraceEvent } from '@/process/ide/quickTestTracer';

const log = (message: string): TraceEvent => ({ kind: 'console', level: 'log', message, at: 0 });
const errConsole = (message: string): TraceEvent => ({ kind: 'console', level: 'error', message, at: 0 });
const ok200 = (url: string): TraceEvent => ({ kind: 'network', method: 'GET', url, status: 200, at: 0 });
const http500 = (url: string): TraceEvent => ({ kind: 'network', method: 'GET', url, status: 500, at: 0 });
const failedNet = (url: string): TraceEvent => ({
  kind: 'network',
  method: 'GET',
  url,
  status: 0,
  error: 'ECONN',
  at: 0,
});
const click = (selector: string): TraceEvent => ({ kind: 'click', selector, text: '', at: 0 });
const exception = (message: string): TraceEvent => ({ kind: 'exception', message, at: 0 });

describe('isErrorEvent', () => {
  it('flags exceptions, console errors, and 4xx/5xx network responses', () => {
    expect(isErrorEvent(exception('boom'))).toBe(true);
    expect(isErrorEvent(errConsole('oops'))).toBe(true);
    expect(isErrorEvent(http500('/api'))).toBe(true);
    expect(isErrorEvent({ kind: 'network', method: 'GET', url: '/a', status: 404, at: 0 })).toBe(true);
  });

  it('flags a transport failure (status 0 with an error)', () => {
    expect(isErrorEvent(failedNet('/api'))).toBe(true);
  });

  it('does NOT flag logs, warnings, or successful responses', () => {
    expect(isErrorEvent(log('hi'))).toBe(false);
    expect(isErrorEvent({ kind: 'console', level: 'warn', message: 'w', at: 0 })).toBe(false);
    expect(isErrorEvent(ok200('/api'))).toBe(false);
  });
});

describe('isSignificantEvent', () => {
  it('keeps errors, the interaction path, and failed requests', () => {
    expect(isSignificantEvent(exception('x'))).toBe(true);
    expect(isSignificantEvent(click('button'))).toBe(true);
    expect(isSignificantEvent({ kind: 'input', selector: 'i', value: 'v', at: 0 })).toBe(true);
    expect(isSignificantEvent({ kind: 'navigate', url: '/x', at: 0 })).toBe(true);
    expect(isSignificantEvent(failedNet('/api'))).toBe(true);
  });

  it('treats routine logs and successful responses as insignificant', () => {
    expect(isSignificantEvent(log('chatty'))).toBe(false);
    expect(isSignificantEvent(ok200('/ok'))).toBe(false);
  });
});

describe('findFirstError', () => {
  it('returns the first error-like event in order', () => {
    const first = http500('/a');
    const events = [log('x'), ok200('/b'), first, exception('later')];
    expect(findFirstError(events)).toBe(first);
  });

  it('returns null when there is no error', () => {
    expect(findFirstError([log('x'), ok200('/b')])).toBeNull();
  });
});

describe('pushBounded', () => {
  it('appends without eviction while under capacity', () => {
    const events: TraceEvent[] = [];
    pushBounded(events, log('a'), 3);
    pushBounded(events, log('b'), 3);
    expect(events).toHaveLength(2);
  });

  it('returns the same array reference (for chaining)', () => {
    const events: TraceEvent[] = [];
    expect(pushBounded(events, log('a'), 3)).toBe(events);
  });

  it('evicts the OLDEST low-value event first when over capacity', () => {
    // Fill with: [log0, click1, log2] then push click3 (cap 3).
    const events: TraceEvent[] = [];
    pushBounded(events, log('log0'), 3);
    pushBounded(events, click('click1'), 3);
    pushBounded(events, log('log2'), 3);
    pushBounded(events, click('click3'), 3); // over cap → evict oldest non-significant (log0)
    expect(events).toHaveLength(3);
    expect(events.find((e) => e.kind === 'console' && e.message === 'log0')).toBeUndefined();
    // Both clicks (significant) survive.
    expect(events.filter((e) => e.kind === 'click')).toHaveLength(2);
  });

  it('never drops the error even under heavy log pressure', () => {
    const events: TraceEvent[] = [];
    const cap = 10;
    pushBounded(events, exception('THE BUG'), cap);
    // Flood with 100 routine logs.
    for (let i = 0; i < 100; i += 1) pushBounded(events, log(`noise-${i}`), cap);
    expect(events.length).toBeLessThanOrEqual(cap);
    expect(findFirstError(events)).not.toBeNull();
    expect(findFirstError(events)?.kind).toBe('exception');
  });

  it('preserves the full interaction path + error under log flood', () => {
    const events: TraceEvent[] = [];
    const cap = 6;
    pushBounded(events, click('a'), cap);
    pushBounded(events, click('b'), cap);
    pushBounded(events, http500('/api/login'), cap);
    for (let i = 0; i < 50; i += 1) pushBounded(events, log(`n-${i}`), cap);
    const clicks = events.filter((e) => e.kind === 'click');
    expect(clicks).toHaveLength(2);
    expect(events.some((e) => e.kind === 'network' && e.status === 500)).toBe(true);
  });

  it('falls back to dropping the oldest when EVERY retained event is significant', () => {
    const events: TraceEvent[] = [];
    const cap = 3;
    pushBounded(events, click('first'), cap);
    pushBounded(events, click('second'), cap);
    pushBounded(events, click('third'), cap);
    pushBounded(events, click('fourth'), cap); // all significant → drop oldest (first)
    expect(events).toHaveLength(3);
    expect((events[0] as { selector: string }).selector).toBe('second');
    expect((events[2] as { selector: string }).selector).toBe('fourth');
  });

  it('defaults to MAX_TRACE_EVENTS when no cap is given', () => {
    const events: TraceEvent[] = [];
    for (let i = 0; i < MAX_TRACE_EVENTS + 25; i += 1) pushBounded(events, log(`x-${i}`));
    expect(events).toHaveLength(MAX_TRACE_EVENTS);
  });
});

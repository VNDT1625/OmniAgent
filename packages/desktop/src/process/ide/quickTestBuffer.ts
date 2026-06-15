/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `quickTestBuffer` — the shared rolling-buffer policy for both Quick Test
 * tracers (web/CDP and native/log-stream).
 *
 * ## Why a smart buffer
 *
 * A naive `events.shift()` cap drops the OLDEST event whenever the buffer is
 * full. In a real app that is exactly wrong: a chatty page emits dozens of
 * `console.log`s and `2xx` network responses per second, so a blind cap quickly
 * evicts the very click that triggered the bug — and even the error itself —
 * leaving the agent a trace with no signal.
 *
 * {@link pushBounded} fixes this by evicting the oldest **low-value** event
 * (routine logs / successful responses) first, and only falling back to the
 * oldest event when everything in the window is significant. The result: the
 * error and the interaction path that led to it survive even under heavy log
 * pressure, while memory stays bounded.
 *
 * Pure + dependency-free (type-only import of {@link TraceEvent}, erased at
 * runtime — no circular dependency with `quickTestTracer`). Shared module.
 */

import type { TraceEvent } from './quickTestTracer';

/**
 * Max events kept in a tracer's rolling buffer. Sized so the full interaction
 * path to an error survives a noisy app, while staying tiny in memory (a few
 * hundred small objects). Significant events are preserved beyond pure recency.
 */
export const MAX_TRACE_EVENTS = 150;

/**
 * An "error-like" event: an uncaught exception, a console error, or a network
 * request that failed — either a 4xx/5xx response OR a transport failure
 * (status 0 with an `error`, e.g. connection refused / DNS / timeout). Shared
 * so the web + native tracers and the service pick the SAME error precedence
 * (single source of truth for {@link findFirstError} and the tracers' `hasError`
 * flag).
 */
export const isErrorEvent = (e: TraceEvent): boolean =>
  e.kind === 'exception' || (e.kind === 'console' && e.level === 'error') || (e.kind === 'network' && (e.status >= 400 || Boolean(e.error)));

/**
 * A "significant" event worth preserving under buffer pressure: any error, plus
 * the user-driven interaction path (click/input/navigate). Routine `console.log`s
 * and successful network responses are NOT significant and are evicted first.
 */
export const isSignificantEvent = (e: TraceEvent): boolean =>
  isErrorEvent(e) || e.kind === 'click' || e.kind === 'input' || e.kind === 'navigate';

/** Find the first {@link isErrorEvent} in a list, or null. */
export const findFirstError = (events: readonly TraceEvent[]): TraceEvent | null => events.find(isErrorEvent) ?? null;

/**
 * Append `event` to `events` (mutating in place), keeping at most `max` items.
 *
 * When over capacity, evict the OLDEST non-significant event first so the error
 * and the interaction path are never lost; if every retained event is
 * significant, fall back to evicting the oldest event (true rolling window).
 *
 * Runs O(n) only on the over-capacity path (a single scan + splice); the common
 * path (under capacity) is O(1). Returns `events` for chaining.
 */
export const pushBounded = (events: TraceEvent[], event: TraceEvent, max: number = MAX_TRACE_EVENTS): TraceEvent[] => {
  events.push(event);
  if (events.length <= max) return events;
  // Evict the oldest low-value event; only the just-pushed event is never a
  // candidate (it is the newest, scanned left-to-right we stop before it).
  for (let i = 0; i < events.length - 1; i += 1) {
    if (!isSignificantEvent(events[i])) {
      events.splice(i, 1);
      return events;
    }
  }
  // Everything is significant — drop the oldest to stay bounded.
  events.shift();
  return events;
};

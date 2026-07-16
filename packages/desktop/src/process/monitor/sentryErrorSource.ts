/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `sentryErrorSource` — bridges the app's existing Sentry pipeline into the
 * {@link IBugMonitor} (Yêu cầu 6, criterion 6.1: "thu lỗi toàn app" tự động).
 *
 * `sentry.ts` already owns the single `Sentry.init({ beforeSend })` hook. Rather
 * than having the monitor import Sentry (and risk a second init), this module
 * exposes a tiny dependency-free pub/sub TAP: `beforeSend` pushes each captured
 * runtime error into the tap, and the {@link ErrorSource} returned here forwards
 * those to the bug monitor. This keeps the layering clean (sentry.ts depends on
 * this leaf module, not on the monitor internals) and stays fully testable
 * without a live Sentry.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import type { CapturedError, ErrorSource } from './bugMonitor';

/** A subscriber notified for each captured runtime error. */
type TapListener = (error: CapturedError) => void;

/**
 * Process-wide tap that `sentry.ts` pushes captured errors into. Listeners are
 * held in a Set so subscribe/unsubscribe is O(1) and a listener never fires
 * twice. Errors thrown by a listener are swallowed so error collection can never
 * itself crash the reporting path.
 */
class SentryErrorTap {
  private readonly listeners = new Set<TapListener>();

  /** Push a captured error to every current subscriber (best-effort). */
  push(error: CapturedError): void {
    for (const listener of this.listeners) {
      try {
        listener(error);
      } catch (err) {
        console.warn('[Monitor] Sentry tap listener threw; ignoring:', err);
      }
    }
  }

  /** Subscribe to captured errors; returns an unsubscribe function. */
  subscribe(listener: TapListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Whether anyone is currently listening (lets `beforeSend` skip work). */
  hasListeners(): boolean {
    return this.listeners.size > 0;
  }
}

/** The shared singleton tap. */
export const sentryErrorTap = new SentryErrorTap();

/** Max characters of a Sentry event message/stack retained on a captured error. */
const MAX_FIELD_CHARS = 4000;

/** Trim a string field to a sane size so a giant stack cannot bloat the store. */
const clamp = (value: string): string => (value.length > MAX_FIELD_CHARS ? value.slice(0, MAX_FIELD_CHARS) : value);

/**
 * Shape of the (subset of the) Sentry event `beforeSend` receives that we read.
 * Kept structural so we don't depend on the Sentry types at this layer.
 */
export type SentryLikeEvent = {
  message?: unknown;
  exception?: { values?: Array<{ type?: unknown; value?: unknown; stacktrace?: { frames?: unknown[] } }> };
};

/**
 * Project a Sentry event onto a {@link CapturedError}. Returns `undefined` when
 * the event carries no usable error text (so we don't record empty reports).
 */
export const capturedErrorFromSentryEvent = (event: SentryLikeEvent): CapturedError | undefined => {
  const firstException = event.exception?.values?.[0];
  const type = typeof firstException?.type === 'string' ? firstException.type : undefined;
  const value = typeof firstException?.value === 'string' ? firstException.value : undefined;
  const message = typeof event.message === 'string' ? event.message : undefined;

  const title = type ?? (message ? message.split('\n')[0] : undefined) ?? 'Runtime error';
  const text = value ?? message;
  if (!text) return undefined;

  // Reconstruct a compact stack line from the first few frames, when present.
  const frames = firstException?.stacktrace?.frames ?? [];
  const stackLines: string[] = [];
  for (const frame of frames.slice(-12)) {
    if (!frame || typeof frame !== 'object') continue;
    const fn = (frame as { function?: unknown }).function;
    const file = (frame as { filename?: unknown }).filename;
    const lineno = (frame as { lineno?: unknown }).lineno;
    const fnText = typeof fn === 'string' ? fn : '?';
    const fileText = typeof file === 'string' ? file : '';
    const lineText = typeof lineno === 'number' ? `:${lineno}` : '';
    stackLines.push(`    at ${fnText} (${fileText}${lineText})`);
  }
  const stack = stackLines.length > 0 ? `${title}: ${text}\n${stackLines.join('\n')}` : undefined;

  return {
    title: clamp(title),
    message: clamp(text),
    stack: stack ? clamp(stack) : undefined,
  };
};

/**
 * Create an {@link ErrorSource} backed by the shared {@link sentryErrorTap}.
 * Inject a different tap in tests via {@link createSentryErrorSourceFrom}.
 */
export const createSentryErrorSource = (): ErrorSource => createSentryErrorSourceFrom(sentryErrorTap);

/** Create an {@link ErrorSource} over a specific tap (testability seam). */
export const createSentryErrorSourceFrom = (tap: Pick<SentryErrorTap, 'subscribe'>): ErrorSource => ({
  subscribe: (onError) => tap.subscribe(onError),
});

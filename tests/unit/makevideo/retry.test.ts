/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/makevideo/retry — the bounded retry-with-backoff used
 * by every Make Video provider call. No real timers or network are touched
 * (`sleep` + `jitter` are injected for deterministic assertions).
 *
 * Covers:
 * - isTransientError: 429/5xx/network = retry; 4xx/abort/config = no retry.
 * - computeBackoff: exponential + jitter, capped at maxDelayMs.
 * - withRetry: succeeds first try, retries transient, stops on permanent,
 *   exhausts retries, and honours an aborted signal.
 */

import { describe, expect, it, vi } from 'vitest';
import { computeBackoff, isTransientError, withRetry, withStatus } from '@/process/makevideo/retry';

const httpError = (status: number): Error => withStatus(new Error(`Model request failed (HTTP ${status}).`), status);

describe('isTransientError', () => {
  it('retries throttling + server errors (408/425/429/5xx)', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isTransientError(httpError(status))).toBe(true);
    }
  });

  it('does NOT retry client errors (other 4xx)', () => {
    for (const status of [400, 401, 403, 404, 422]) {
      expect(isTransientError(httpError(status))).toBe(false);
    }
  });

  it('reads an HTTP status embedded in the message when no .status field is set', () => {
    expect(isTransientError(new Error('Model request failed (HTTP 503). upstream down'))).toBe(true);
    expect(isTransientError(new Error('Model request failed (HTTP 401). bad key'))).toBe(false);
  });

  it('retries low-level network flaps', () => {
    expect(isTransientError(new Error('fetch failed'))).toBe(true);
    expect(isTransientError(new Error('read ECONNRESET'))).toBe(true);
    expect(isTransientError(new Error('Model request timed out after 120s.'))).toBe(true);
  });

  it('never retries aborts or "nothing configured" sentinels', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(isTransientError(abort)).toBe(false);
    expect(isTransientError(new Error('Video clip generation aborted.'))).toBe(false);
    expect(isTransientError(new Error('No usable model is configured.'))).toBe(false);
    expect(isTransientError(new Error('no-image-model: select an image model.'))).toBe(false);
  });
});

describe('computeBackoff', () => {
  it('grows exponentially and is capped at maxDelayMs', () => {
    // jitter=1 → upper bound of the full-jitter window (== exp).
    expect(computeBackoff(1, 600, 8000, 1)).toBe(600);
    expect(computeBackoff(2, 600, 8000, 1)).toBe(1200);
    expect(computeBackoff(3, 600, 8000, 1)).toBe(2400);
    // attempt 5 would be 9600 → capped at 8000.
    expect(computeBackoff(5, 600, 8000, 1)).toBe(8000);
  });

  it('full jitter keeps the wait within [exp/2, exp]', () => {
    expect(computeBackoff(2, 600, 8000, 0)).toBe(600); // exp/2 = 1200/2
    expect(computeBackoff(2, 600, 8000, 1)).toBe(1200);
  });
});

describe('withRetry', () => {
  it('returns immediately on first success without sleeping', async () => {
    const sleep = vi.fn(async () => undefined);
    const fn = vi.fn(async () => 'ok');
    const result = await withRetry(fn, { sleep });
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a transient failure then succeeds', async () => {
    const sleep = vi.fn(async () => undefined);
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw httpError(429);
      return 'recovered';
    });
    const result = await withRetry(fn, { sleep, jitter: () => 0.5 });
    expect(result).toBe('recovered');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('does NOT retry a permanent failure', async () => {
    const sleep = vi.fn(async () => undefined);
    const fn = vi.fn(async () => {
      throw httpError(401);
    });
    await expect(withRetry(fn, { sleep })).rejects.toThrow(/HTTP 401/);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('exhausts the retry budget and rethrows the last error', async () => {
    const sleep = vi.fn(async () => undefined);
    const fn = vi.fn(async () => {
      throw httpError(503);
    });
    await expect(withRetry(fn, { retries: 2, sleep, jitter: () => 0 })).rejects.toThrow(/HTTP 503/);
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it('fires onRetry before each backoff with the attempt + delay', async () => {
    const sleep = vi.fn(async () => undefined);
    const onRetry = vi.fn();
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw httpError(500);
        return 'done';
      },
      { sleep, jitter: () => 1, baseDelayMs: 600, onRetry }
    );
    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry.mock.calls[0][0]).toMatchObject({ attempt: 1, delayMs: 600 });
    expect(onRetry.mock.calls[1][0]).toMatchObject({ attempt: 2, delayMs: 1200 });
  });

  it('stops immediately when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const fn = vi.fn(async () => 'never');
    await expect(withRetry(fn, { signal: controller.signal })).rejects.toThrow(/aborted/i);
    expect(fn).not.toHaveBeenCalled();
  });
});

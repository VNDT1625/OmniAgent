/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bounded retry-with-backoff for the Make Video provider calls.
 *
 * Cloud model / image / video endpoints fail transiently far more often than
 * they fail permanently: rate limits (HTTP 429), gateway hiccups (502/503/504),
 * request timeouts (408), and dropped sockets (`ECONNRESET`, `ETIMEDOUT`,
 * `fetch failed`). Retrying these with exponential backoff + jitter turns a
 * flaky long-running pipeline (script → image → voice → clip) into a robust one
 * without hammering the provider.
 *
 * The classifier deliberately does NOT retry:
 *  - User aborts (`AbortError` / an aborted signal) — the user asked to stop.
 *  - Auth/quota/validation errors (401/403/404/422) — retrying never helps.
 *  - The "nothing configured" sentinels (`no usable model` / `no-image-model`).
 *
 * Pure + dependency-injected (`sleep`) so it is fully unit-testable with no
 * real timers or network.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

/** An error carrying the originating HTTP status (attached by the fetch helper). */
export type StatusError = Error & { status?: number };

/** Attach an HTTP `status` to an Error so the retry classifier can read it. */
export const withStatus = (error: Error, status: number): StatusError => {
  (error as StatusError).status = status;
  return error as StatusError;
};

/** Read a numeric HTTP status off an error, whether typed or embedded in text. */
const statusOf = (error: unknown): number | null => {
  if (typeof (error as StatusError | undefined)?.status === 'number') {
    return (error as StatusError).status as number;
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/\bHTTP\s+(\d{3})\b/i);
  return match ? Number(match[1]) : null;
};

/** Whether the error message names a transient, low-level network failure. */
const isNetworkFlap = (message: string): boolean =>
  /\b(ECONNRESET|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|ENOTFOUND|EPIPE|socket hang up|network|fetch failed|terminated|timed out|timeout)\b/i.test(
    message
  );

/** True when an aborted/cancelled signal produced the error (never retry). */
const isAbort = (error: unknown): boolean => {
  if (error instanceof Error && (error.name === 'AbortError' || /\baborted\b/i.test(error.message))) return true;
  return false;
};

/** The "nothing is configured" sentinels — retrying cannot fix configuration. */
const isConfigSentinel = (message: string): boolean =>
  /no usable model|no model is configured|no-image-model|requires a generator/i.test(message);

/**
 * Decide whether an error is worth retrying. Transient = HTTP 408/425/429 or any
 * 5xx, or a low-level network flap. Aborts, config sentinels, and 4xx (other
 * than the throttling codes) are permanent.
 */
export const isTransientError = (error: unknown): boolean => {
  if (isAbort(error)) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (isConfigSentinel(message)) return false;

  const status = statusOf(error);
  if (status !== null) {
    if (status === 408 || status === 425 || status === 429) return true;
    if (status >= 500 && status <= 599) return true;
    return false; // other 4xx are permanent
  }
  return isNetworkFlap(message);
};

/** Options for {@link withRetry}. All have sensible production defaults. */
export type RetryOptions = {
  /** Max number of RE-tries after the first attempt. Default 2 (→ up to 3 tries). */
  retries?: number;
  /** Base backoff in ms (attempt 1 waits ~base, attempt 2 ~base*2, …). Default 600. */
  baseDelayMs?: number;
  /** Cap on a single backoff wait. Default 8000. */
  maxDelayMs?: number;
  /** Classifier deciding whether to retry. Default {@link isTransientError}. */
  isRetriable?: (error: unknown) => boolean;
  /** Sleep implementation (injectable for tests). Default real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
  /** Deterministic jitter in [0,1) (injectable for tests). Default `Math.random`. */
  jitter?: () => number;
  /** Cancellation — abort between attempts stops the retry loop. */
  signal?: AbortSignal;
  /** Observability hook fired before each backoff wait. */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
};

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential backoff with full jitter, capped at `maxDelayMs`. */
export const computeBackoff = (attempt: number, baseDelayMs: number, maxDelayMs: number, jitter: number): number => {
  const exp = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
  // Full jitter: random in [exp/2, exp] keeps spacing while de-correlating bursts.
  const min = exp / 2;
  return Math.round(min + (exp - min) * jitter);
};

/**
 * Run `fn` with bounded exponential-backoff retries on transient failures.
 *
 * `fn` receives the 1-based attempt number. The final error (after exhausting
 * retries, or the first permanent error) is re-thrown unchanged so callers keep
 * the provider's original message.
 */
export const withRetry = async <T>(fn: (attempt: number) => Promise<T>, options?: RetryOptions): Promise<T> => {
  const retries = Math.max(0, options?.retries ?? 2);
  const baseDelayMs = options?.baseDelayMs ?? 600;
  const maxDelayMs = options?.maxDelayMs ?? 8000;
  const isRetriable = options?.isRetriable ?? isTransientError;
  const sleep = options?.sleep ?? realSleep;
  const jitter = options?.jitter ?? Math.random;
  const signal = options?.signal;

  let lastError: unknown;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    if (signal?.aborted) throw new Error('Operation aborted.');
    try {
      // Sequential by design: each attempt must observe the previous failure.
      // eslint-disable-next-line no-await-in-loop
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const hasMore = attempt <= retries;
      if (!hasMore || !isRetriable(error) || signal?.aborted) throw error;
      const delayMs = computeBackoff(attempt, baseDelayMs, maxDelayMs, jitter());
      options?.onRetry?.({ attempt, delayMs, error });
      // Backoff between attempts — intentionally serialised.
      // eslint-disable-next-line no-await-in-loop
      await sleep(delayMs);
    }
  }
  // Unreachable: the loop either returns or throws. Satisfies the type checker.
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

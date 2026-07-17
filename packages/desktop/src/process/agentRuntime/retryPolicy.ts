/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Provider/process failure classes shared by agent transports. */
export type AgentFailureKind =
  | 'transient'
  | 'cancelled'
  | 'auth'
  | 'quota'
  | 'context'
  | 'configuration'
  | 'permission'
  | 'tool'
  | 'fatal';

export type AgentFailureClassification = {
  kind: AgentFailureKind;
  retry: boolean;
  message: string;
};

export type AgentRetryStatus = {
  kind: 'transient';
  totalFailures: number;
  batch: number;
  nextAttemptInBatch: number;
  batchSize: number;
  remainingMs: number;
  message: string;
};

type RetryManagedError = Error & { retryManaged?: true };

export const isRetryManagedError = (error: unknown): boolean =>
  error instanceof Error && (error as RetryManagedError).retryManaged === true;

const markRetryManaged = (error: unknown): Error => {
  const normalized = error instanceof Error ? error : new Error(String(error));
  (normalized as RetryManagedError).retryManaged = true;
  return normalized;
};

const errorText = (error: unknown): string => {
  if (error instanceof Error) {
    const cause = 'cause' in error && error.cause ? ` ${errorText(error.cause)}` : '';
    return `${error.name} ${error.message}${cause}`.trim();
  }
  if (typeof error === 'object' && error !== null) {
    try {
      return JSON.stringify(error);
    } catch {
      return String(error);
    }
  }
  return String(error);
};

const statusCode = (error: unknown, text: string): number | undefined => {
  if (typeof error === 'object' && error !== null) {
    const value =
      (error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode;
    if (typeof value === 'number' && Number.isInteger(value)) return value;
  }
  const labelled = /\b(?:http|status(?:\s+code)?|code)\D{0,4}(\d{3})\b/iu.exec(text);
  const standalone = /\b(4\d{2}|5\d{2})\b/u.exec(text);
  const value = labelled?.[1] ?? standalone?.[1];
  return value ? Number(value) : undefined;
};

/** Classify before retrying so permanent failures never become infinite loops. */
export const classifyAgentFailure = (error: unknown): AgentFailureClassification => {
  const message = errorText(error);
  const normalized = message.toLowerCase();
  const status = statusCode(error, message);

  if (
    /aborterror|\babort(?:ed)?\b|\bcancel(?:led|ed)?\b|user (?:stop|stopped)|request was cancelled/u.test(normalized)
  ) {
    return { kind: 'cancelled', retry: false, message };
  }
  if (
    /context (?:length|window)|maximum context|max(?:imum)? tokens|too many tokens|prompt (?:is )?too long|token limit exceeded/u.test(
      normalized
    )
  ) {
    return { kind: 'context', retry: false, message };
  }
  if (
    status === 401 ||
    status === 403 ||
    /invalid api[ _-]?key|incorrect api[ _-]?key|missing api[ _-]?key|api[ _-]?key.*required|unauthori[sz]ed|authentication failed|invalid bearer|unauthenticated|access token.*(?:invalid|expired)/u.test(
      normalized
    )
  ) {
    return { kind: 'auth', retry: false, message };
  }
  if (
    /insufficient[_ -]?quota|quota (?:exceeded|exhausted)|billing|credit balance|out of credits|no tokens left|hard limit|usage limit/u.test(
      normalized
    )
  ) {
    return { kind: 'quota', retry: false, message };
  }
  if (/permission denied|approval denied|denied by user|tool denied/u.test(normalized)) {
    return { kind: 'permission', retry: false, message };
  }
  if (
    /no (?:usable )?model|model (?:is )?not (?:configured|found)|unknown model|invalid model|invalid request|bad request|configuration|not installed|executable (?:was )?not found|\benoent\b|\beacces\b|\beperm\b|operation not permitted/u.test(
      normalized
    ) ||
    (status !== undefined && [400, 404, 405, 409, 410, 422].includes(status))
  ) {
    return { kind: 'configuration', retry: false, message };
  }
  if (/tool .*(?:failed|error)|translation failed|permission request failed|mcp .*failed/u.test(normalized)) {
    return { kind: 'tool', retry: false, message };
  }
  if (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status !== undefined && status >= 500 && status <= 599) ||
    /rate.?limit|too many requests|resource[_ -]?exhausted|throttl|overload|over capacity|capacity exceeded|api keys?.*(?:busy|overloaded|temporarily unavailable)|server busy|temporar(?:y|ily) unavailable|service unavailable|try again|gateway|timed? out|timeout|did not complete.*within|no activity|econnreset|econnrefused|etimedout|eai_again|enotfound|epipe|network|fetch failed|socket hang up|connection (?:reset|closed|lost)|stream closed|unexpected eof|request failed|provider .*unavailable|exited with code|terminated unexpectedly|failed to start/u.test(
      normalized
    )
  ) {
    return { kind: 'transient', retry: true, message };
  }
  return { kind: 'fatal', retry: false, message };
};

type RetrySleep = (delayMs: number, signal: AbortSignal) => Promise<void>;

const abortError = (): Error => markRetryManaged(new Error('The request was cancelled.'));

const sleepAbortably: RetrySleep = (delayMs, signal) =>
  new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    let settled = false;
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cleanup();
      reject(abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

export type PersistentAgentRetryOptions<T> = {
  operation: (attempt: number) => Promise<T>;
  signal: AbortSignal;
  onBeforeRetry?: () => void;
  onStatus?: (status: AgentRetryStatus) => void;
  classify?: (error: unknown) => AgentFailureClassification;
  batchSize?: number;
  retryDelayMs?: number;
  batchDelayMs?: number;
  sleep?: RetrySleep;
  agentLabel?: string;
};

const retryMessage = (status: Omit<AgentRetryStatus, 'message'>, agentLabel: string): string => {
  const seconds = Math.max(1, Math.ceil(status.remainingMs / 1_000));
  return status.nextAttemptInBatch === 1 && status.totalFailures >= status.batchSize
    ? `${agentLabel} is temporarily unavailable. Retry batch ${status.batch} starts in ${seconds}s. Press Stop to cancel.`
    : `${agentLabel} is temporarily unavailable. Retry ${status.nextAttemptInBatch}/${status.batchSize} in ${seconds}s. Press Stop to cancel.`;
};

/**
 * Retry transient agent failures in endless batches until success or explicit abort.
 * Permanent auth/quota/context/config/tool/permission failures are returned immediately.
 */
export const withPersistentAgentRetry = async <T>(options: PersistentAgentRetryOptions<T>): Promise<T> => {
  const classify = options.classify ?? classifyAgentFailure;
  const batchSize = Math.max(1, Math.trunc(options.batchSize ?? 5));
  const retryDelayMs = Math.max(0, options.retryDelayMs ?? 1_000);
  const batchDelayMs = Math.max(0, options.batchDelayMs ?? 15_000);
  const sleep = options.sleep ?? sleepAbortably;
  let attempt = 1;
  let totalFailures = 0;

  while (true) {
    if (options.signal.aborted) throw abortError();
    try {
      // Sequential by design: a logical turn must never have concurrent retries.
      // eslint-disable-next-line no-await-in-loop
      return await options.operation(attempt);
    } catch (error) {
      if (options.signal.aborted) throw abortError();
      const failure = classify(error);
      if (!failure.retry) throw markRetryManaged(error);

      totalFailures += 1;
      const failedAttemptInBatch = ((totalFailures - 1) % batchSize) + 1;
      const startsNewBatch = failedAttemptInBatch === batchSize;
      const batch = Math.floor(totalFailures / batchSize) + 1;
      const nextAttemptInBatch = startsNewBatch ? 1 : failedAttemptInBatch + 1;
      const remainingMs = startsNewBatch ? batchDelayMs : retryDelayMs;
      options.onBeforeRetry?.();

      if (options.signal.aborted) throw abortError();
      const rawStatus = {
        kind: 'transient' as const,
        totalFailures,
        batch,
        nextAttemptInBatch,
        batchSize,
        remainingMs,
      };
      options.onStatus?.({ ...rawStatus, message: retryMessage(rawStatus, options.agentLabel?.trim() || 'Agent') });
      // One status per wait avoids an unbounded UI event log during a long outage.
      // eslint-disable-next-line no-await-in-loop
      await sleep(remainingMs, options.signal);
      attempt += 1;
    }
  }
};

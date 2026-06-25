/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `bugMonitor` — the background error-collection agent (Yêu cầu 6, criteria 6.1
 * & 6.2). It plugs into the app's existing error infrastructure — Sentry
 * (`@sentry/electron`) for runtime errors plus the feedback logs — gathers the
 * logs + recent actions + situation into a {@link BugReport}, and also lets the
 * user file a report with a description (the existing FeedbackButton path).
 *
 * The Sentry/log sources and the feedback hook are INJECTED so this module only
 * orchestrates collection + recording (into the {@link IReportStore}) and stays
 * unit-testable without a live Sentry. A small ring buffer keeps the most recent
 * breadcrumbs to attach to a report.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import type { BugReport } from './monitorTypes';
import type { IReportStore } from './reportStore';

/** A captured runtime error handed in by the Sentry/error source. */
export type CapturedError = {
  /** Short title. */
  title: string;
  /** Error message. */
  message: string;
  /** Stack trace, if any. */
  stack?: string;
};

/**
 * A source of runtime errors (e.g. a Sentry `beforeSend` hook). Calls `onError`
 * for each captured error. Injected so tests drive errors deterministically.
 */
export type ErrorSource = {
  /** Subscribe to captured errors; returns an unsubscribe function. */
  subscribe(onError: (error: CapturedError) => void): () => void;
};

/** Options for {@link createBugMonitor}. */
export type BugMonitorDeps = {
  /** The repository that dedups + persists reports. */
  store: IReportStore;
  /** Runtime error sources (Sentry, log tailer, ...). */
  sources?: ErrorSource[];
  /** Max breadcrumbs retained in the ring buffer. Defaults to 50. */
  maxBreadcrumbs?: number;
  /** Called whenever a report is recorded (e.g. to trigger analysis). */
  onReport?: (report: BugReport) => void;
};

/** Public contract of the bug monitor. */
export type IBugMonitor = {
  /** Start listening to the injected error sources. Idempotent. */
  start(): void;
  /** Stop listening and clear subscriptions. */
  stop(): void;
  /** Record a breadcrumb (a recent user action) for the next report. */
  addBreadcrumb(action: string): void;
  /** File a user-initiated bug report with a free-text description (criterion 6.2). */
  reportFromUser(input: { title: string; message: string; description: string }): Promise<BugReport>;
  /** Programmatically record a captured error (used by sources + tests). */
  capture(error: CapturedError): Promise<BugReport>;
};

/** Default breadcrumb ring-buffer size. */
const DEFAULT_MAX_BREADCRUMBS = 50;

/**
 * Create a background {@link IBugMonitor} over the injected sources + store.
 *
 * @param deps Store, error sources, and tunables. See {@link BugMonitorDeps}.
 * @returns A bug monitor ready to start.
 */
export const createBugMonitor = (deps: BugMonitorDeps): IBugMonitor => {
  const maxBreadcrumbs = deps.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS;
  const breadcrumbs: string[] = [];
  let unsubscribers: Array<() => void> = [];
  let started = false;

  const addBreadcrumb = (action: string): void => {
    breadcrumbs.push(action);
    if (breadcrumbs.length > maxBreadcrumbs) breadcrumbs.shift();
  };

  const capture: IBugMonitor['capture'] = async (error) => {
    const report = await deps.store.record({
      source: 'sentry',
      title: error.title,
      message: error.message,
      stack: error.stack,
      breadcrumbs: [...breadcrumbs],
    });
    deps.onReport?.(report);
    return report;
  };

  const reportFromUser: IBugMonitor['reportFromUser'] = async (input) => {
    const report = await deps.store.record({
      source: 'user',
      title: input.title,
      message: input.message,
      description: input.description,
      breadcrumbs: [...breadcrumbs],
    });
    deps.onReport?.(report);
    return report;
  };

  const start = (): void => {
    if (started) return;
    started = true;
    unsubscribers = (deps.sources ?? []).map((source) => source.subscribe((error) => void capture(error)));
  };

  const stop = (): void => {
    for (const unsub of unsubscribers) unsub();
    unsubscribers = [];
    started = false;
  };

  return { start, stop, addBreadcrumb, reportFromUser, capture };
};

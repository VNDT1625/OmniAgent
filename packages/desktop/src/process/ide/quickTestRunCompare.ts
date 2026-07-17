/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CoverageFunction, RuntimeTrace, TraceEvent } from './quickTestTracer';

export type RunDiffStatus = 'unchanged' | 'changed' | 'added' | 'removed';

export type InteractionSnapshot = {
  kind: 'click' | 'input' | 'navigate';
  target: string;
  value: string;
  offsetMs: number;
};

export type InteractionStepDiff = {
  status: RunDiffStatus;
  baselineIndex: number | null;
  currentIndex: number | null;
  baseline: InteractionSnapshot | null;
  current: InteractionSnapshot | null;
};

export type ErrorSnapshot = {
  fingerprint: string;
  kind: 'console' | 'exception' | 'network';
  message: string;
  count: number;
};

export type NetworkRequestSnapshot = {
  method: string;
  url: string;
  status: number;
  error: string | null;
  responseBodyPreview: string | null;
};

export type NetworkRequestDiff = {
  status: Exclude<RunDiffStatus, 'unchanged'>;
  key: string;
  occurrence: number;
  statusChanged: boolean;
  bodyChanged: boolean;
  baseline: NetworkRequestSnapshot | null;
  current: NetworkRequestSnapshot | null;
};

export type DurationDiff = {
  baselineMs: number;
  currentMs: number;
  deltaMs: number;
  deltaPercent: number | null;
};

export type CoverageFunctionSnapshot = CoverageFunction;

export type CoverageFunctionDiff = {
  status: Exclude<RunDiffStatus, 'unchanged'>;
  key: string;
  baseline: CoverageFunctionSnapshot | null;
  current: CoverageFunctionSnapshot | null;
  callCountDelta: number;
};

export type CoverageFileSnapshot = {
  file: string;
  functionCount: number;
  callCount: number;
};

export type CoverageFileDiff = {
  status: Exclude<RunDiffStatus, 'unchanged'>;
  file: string;
  baseline: CoverageFileSnapshot | null;
  current: CoverageFileSnapshot | null;
  callCountDelta: number;
};

export type QuickTestRunDiffSummary = {
  interactionChanges: number;
  newErrors: number;
  resolvedErrors: number;
  networkChanges: number;
  coverageFunctionChanges: number;
  coverageFileChanges: number;
  durationDeltaMs: number;
  hasRegressionSignals: boolean;
  truncated: boolean;
};

export type QuickTestRunDiff = {
  baseline: { platform: RuntimeTrace['platform']; startedAt: number; eventCount: number };
  current: { platform: RuntimeTrace['platform']; startedAt: number; eventCount: number };
  interactions: InteractionStepDiff[];
  errors: { added: ErrorSnapshot[]; resolved: ErrorSnapshot[] };
  network: NetworkRequestDiff[];
  duration: DurationDiff;
  coverage: { functions: CoverageFunctionDiff[]; files: CoverageFileDiff[] };
  summary: QuickTestRunDiffSummary;
};

export type CompareQuickTestRunsOptions = {
  maxInteractionSteps?: number;
  maxChanges?: number;
  maxCoverageEntries?: number;
  maxBodyPreviewChars?: number;
};

const DEFAULT_MAX_INTERACTION_STEPS = 350;
const DEFAULT_MAX_CHANGES = 200;
const DEFAULT_MAX_COVERAGE_ENTRIES = 2_000;
const DEFAULT_MAX_BODY_PREVIEW_CHARS = 500;

type NormalizedOptions = {
  maxInteractionSteps: number;
  maxChanges: number;
  maxCoverageEntries: number;
  maxBodyPreviewChars: number;
};

type IndexedInteraction = { index: number; snapshot: InteractionSnapshot };
type NetworkEvent = Extract<TraceEvent, { kind: 'network' }>;

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(1, Math.floor(value)));
}

function normalizeOptions(options: CompareQuickTestRunsOptions): NormalizedOptions {
  return {
    maxInteractionSteps: boundedInteger(options.maxInteractionSteps, DEFAULT_MAX_INTERACTION_STEPS, 1_000),
    maxChanges: boundedInteger(options.maxChanges, DEFAULT_MAX_CHANGES, 1_000),
    maxCoverageEntries: boundedInteger(options.maxCoverageEntries, DEFAULT_MAX_COVERAGE_ENTRIES, 10_000),
    maxBodyPreviewChars: boundedInteger(options.maxBodyPreviewChars, DEFAULT_MAX_BODY_PREVIEW_CHARS, 4_000),
  };
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}

function interactionSnapshot(event: TraceEvent, startedAt: number): InteractionSnapshot | null {
  if (event.kind === 'click') {
    return { kind: event.kind, target: event.selector, value: event.text, offsetMs: Math.max(0, event.at - startedAt) };
  }
  if (event.kind === 'input') {
    return {
      kind: event.kind,
      target: event.selector,
      value: event.value,
      offsetMs: Math.max(0, event.at - startedAt),
    };
  }
  if (event.kind === 'navigate') {
    return { kind: event.kind, target: event.url, value: event.url, offsetMs: Math.max(0, event.at - startedAt) };
  }
  return null;
}

function collectInteractions(trace: RuntimeTrace, limit: number): { items: IndexedInteraction[]; truncated: boolean } {
  const items: IndexedInteraction[] = [];
  let total = 0;
  for (const event of trace.events) {
    const snapshot = interactionSnapshot(event, trace.startedAt);
    if (!snapshot) continue;
    if (items.length < limit) items.push({ index: total, snapshot });
    total += 1;
  }
  return { items, truncated: total > limit };
}

function interactionIdentity(value: InteractionSnapshot): string {
  return `${value.kind}\u0000${value.target}`;
}

function interactionEqual(baseline: InteractionSnapshot, current: InteractionSnapshot): boolean {
  return interactionIdentity(baseline) === interactionIdentity(current) && baseline.value === current.value;
}

function alignInteractions(baseline: IndexedInteraction[], current: IndexedInteraction[]): InteractionStepDiff[] {
  const columns = current.length + 1;
  const costs = new Uint16Array((baseline.length + 1) * columns);
  for (let row = 0; row <= baseline.length; row += 1) costs[row * columns] = row;
  for (let column = 0; column <= current.length; column += 1) costs[column] = column;

  for (let row = 1; row <= baseline.length; row += 1) {
    for (let column = 1; column <= current.length; column += 1) {
      const replacement =
        costs[(row - 1) * columns + column - 1] +
        (interactionIdentity(baseline[row - 1].snapshot) === interactionIdentity(current[column - 1].snapshot) ? 0 : 1);
      const removal = costs[(row - 1) * columns + column] + 1;
      const addition = costs[row * columns + column - 1] + 1;
      costs[row * columns + column] = Math.min(replacement, removal, addition);
    }
  }

  const aligned: InteractionStepDiff[] = [];
  let row = baseline.length;
  let column = current.length;
  while (row > 0 || column > 0) {
    const baselineItem = row > 0 ? baseline[row - 1] : null;
    const currentItem = column > 0 ? current[column - 1] : null;
    const replacementCost =
      baselineItem && currentItem
        ? costs[(row - 1) * columns + column - 1] +
          (interactionIdentity(baselineItem.snapshot) === interactionIdentity(currentItem.snapshot) ? 0 : 1)
        : Number.POSITIVE_INFINITY;

    if (baselineItem && currentItem && costs[row * columns + column] === replacementCost) {
      aligned.push({
        status: interactionEqual(baselineItem.snapshot, currentItem.snapshot) ? 'unchanged' : 'changed',
        baselineIndex: baselineItem.index,
        currentIndex: currentItem.index,
        baseline: baselineItem.snapshot,
        current: currentItem.snapshot,
      });
      row -= 1;
      column -= 1;
      continue;
    }
    if (baselineItem && costs[row * columns + column] === costs[(row - 1) * columns + column] + 1) {
      aligned.push({
        status: 'removed',
        baselineIndex: baselineItem.index,
        currentIndex: null,
        baseline: baselineItem.snapshot,
        current: null,
      });
      row -= 1;
      continue;
    }
    if (!currentItem) break;
    aligned.push({
      status: 'added',
      baselineIndex: null,
      currentIndex: currentItem.index,
      baseline: null,
      current: currentItem.snapshot,
    });
    column -= 1;
  }
  return aligned.toReversed();
}

function errorSnapshot(event: TraceEvent): Omit<ErrorSnapshot, 'count'> | null {
  if (event.kind === 'exception') {
    const location = event.url ? `${event.url}:${event.line ?? 0}` : '';
    return {
      fingerprint: `exception\u0000${event.message}\u0000${location}`,
      kind: 'exception',
      message: event.message,
    };
  }
  if (event.kind === 'console' && event.level === 'error') {
    return { fingerprint: `console\u0000${event.message}`, kind: 'console', message: event.message };
  }
  if (event.kind === 'network' && (event.status >= 400 || Boolean(event.error))) {
    const message = event.error || `${event.method.toUpperCase()} ${event.url} returned ${event.status}`;
    return {
      fingerprint: `network\u0000${event.method.toUpperCase()}\u0000${event.url}\u0000${event.status}\u0000${event.error ?? ''}`,
      kind: 'network',
      message,
    };
  }
  return null;
}

function collectErrors(trace: RuntimeTrace): Map<string, ErrorSnapshot> {
  const errors = new Map<string, ErrorSnapshot>();
  for (const event of trace.events) {
    const snapshot = errorSnapshot(event);
    if (!snapshot) continue;
    const existing = errors.get(snapshot.fingerprint);
    errors.set(snapshot.fingerprint, { ...snapshot, count: (existing?.count ?? 0) + 1 });
  }
  return errors;
}

function compareErrors(baseline: RuntimeTrace, current: RuntimeTrace, limit: number) {
  const baselineErrors = collectErrors(baseline);
  const currentErrors = collectErrors(current);
  const added = [...currentErrors.entries()]
    .filter(([key]) => !baselineErrors.has(key))
    .map(([, value]) => value)
    .toSorted((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  const resolved = [...baselineErrors.entries()]
    .filter(([key]) => !currentErrors.has(key))
    .map(([, value]) => value)
    .toSorted((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  return {
    added: added.slice(0, limit),
    resolved: resolved.slice(0, limit),
    totalAdded: added.length,
    totalResolved: resolved.length,
    truncated: added.length > limit || resolved.length > limit,
  };
}

function networkSnapshot(event: NetworkEvent, bodyLimit: number): NetworkRequestSnapshot {
  return {
    method: event.method.toUpperCase(),
    url: event.url,
    status: event.status,
    error: event.error ?? null,
    responseBodyPreview: event.responseBody === undefined ? null : truncate(event.responseBody, bodyLimit),
  };
}

function collectNetwork(trace: RuntimeTrace): Map<string, NetworkEvent[]> {
  const grouped = new Map<string, NetworkEvent[]>();
  for (const event of trace.events) {
    if (event.kind !== 'network') continue;
    const key = `${event.method.toUpperCase()} ${event.url}`;
    const group = grouped.get(key) ?? [];
    group.push(event);
    grouped.set(key, group);
  }
  return grouped;
}

function compareNetwork(baseline: RuntimeTrace, current: RuntimeTrace, options: NormalizedOptions) {
  const baselineGroups = collectNetwork(baseline);
  const currentGroups = collectNetwork(current);
  const keys = [...new Set([...baselineGroups.keys(), ...currentGroups.keys()])].toSorted((left, right) =>
    left.localeCompare(right)
  );
  const changes: NetworkRequestDiff[] = [];
  let totalChanges = 0;
  let hasRegression = false;

  for (const key of keys) {
    const baselineEvents = baselineGroups.get(key) ?? [];
    const currentEvents = currentGroups.get(key) ?? [];
    const occurrences = Math.max(baselineEvents.length, currentEvents.length);
    for (let occurrence = 0; occurrence < occurrences; occurrence += 1) {
      const before = baselineEvents[occurrence];
      const after = currentEvents[occurrence];
      const statusChanged = Boolean(before && after && before.status !== after.status);
      const bodyChanged = Boolean(before && after && before.responseBody !== after.responseBody);
      const errorChanged = Boolean(before && after && before.error !== after.error);
      if (before && after && !statusChanged && !bodyChanged && !errorChanged) continue;
      totalChanges += 1;
      if (after && after.status >= 400 && (!before || before.status < 400)) hasRegression = true;
      if (changes.length >= options.maxChanges) continue;
      changes.push({
        status: !before ? 'added' : !after ? 'removed' : 'changed',
        key,
        occurrence: occurrence + 1,
        statusChanged,
        bodyChanged,
        baseline: before ? networkSnapshot(before, options.maxBodyPreviewChars) : null,
        current: after ? networkSnapshot(after, options.maxBodyPreviewChars) : null,
      });
    }
  }
  return { changes, totalChanges, hasRegression, truncated: totalChanges > changes.length };
}

function coverageKey(value: CoverageFunction): string {
  return `${value.file}\u0000${value.line}\u0000${value.functionName}`;
}

function collectCoverage(
  trace: RuntimeTrace,
  limit: number
): { values: Map<string, CoverageFunction>; truncated: boolean } {
  const source = trace.coverage ?? [];
  const values = new Map<string, CoverageFunction>();
  for (const value of source.slice(0, limit)) {
    const key = coverageKey(value);
    const existing = values.get(key);
    values.set(key, { ...value, callCount: (existing?.callCount ?? 0) + value.callCount });
  }
  return { values, truncated: source.length > limit };
}

function aggregateFiles(values: Map<string, CoverageFunction>): Map<string, CoverageFileSnapshot> {
  const files = new Map<string, CoverageFileSnapshot>();
  for (const value of values.values()) {
    const existing = files.get(value.file);
    files.set(value.file, {
      file: value.file,
      functionCount: (existing?.functionCount ?? 0) + 1,
      callCount: (existing?.callCount ?? 0) + value.callCount,
    });
  }
  return files;
}

function compareCoverage(baseline: RuntimeTrace, current: RuntimeTrace, options: NormalizedOptions) {
  const before = collectCoverage(baseline, options.maxCoverageEntries);
  const after = collectCoverage(current, options.maxCoverageEntries);
  const keys = [...new Set([...before.values.keys(), ...after.values.keys()])].toSorted((left, right) =>
    left.localeCompare(right)
  );
  const functions: CoverageFunctionDiff[] = [];
  for (const key of keys) {
    const baselineValue = before.values.get(key) ?? null;
    const currentValue = after.values.get(key) ?? null;
    if (baselineValue?.callCount === currentValue?.callCount) continue;
    if (functions.length >= options.maxChanges) continue;
    functions.push({
      status: !baselineValue ? 'added' : !currentValue ? 'removed' : 'changed',
      key,
      baseline: baselineValue,
      current: currentValue,
      callCountDelta: (currentValue?.callCount ?? 0) - (baselineValue?.callCount ?? 0),
    });
  }

  const baselineFiles = aggregateFiles(before.values);
  const currentFiles = aggregateFiles(after.values);
  const fileKeys = [...new Set([...baselineFiles.keys(), ...currentFiles.keys()])].toSorted((left, right) =>
    left.localeCompare(right)
  );
  const files: CoverageFileDiff[] = [];
  for (const file of fileKeys) {
    const baselineValue = baselineFiles.get(file) ?? null;
    const currentValue = currentFiles.get(file) ?? null;
    if (
      baselineValue?.callCount === currentValue?.callCount &&
      baselineValue?.functionCount === currentValue?.functionCount
    )
      continue;
    if (files.length >= options.maxChanges) continue;
    files.push({
      status: !baselineValue ? 'added' : !currentValue ? 'removed' : 'changed',
      file,
      baseline: baselineValue,
      current: currentValue,
      callCountDelta: (currentValue?.callCount ?? 0) - (baselineValue?.callCount ?? 0),
    });
  }
  const totalFunctionChanges = keys.filter(
    (key) => before.values.get(key)?.callCount !== after.values.get(key)?.callCount
  ).length;
  const totalFileChanges = fileKeys.filter((file) => {
    const baselineValue = baselineFiles.get(file);
    const currentValue = currentFiles.get(file);
    return (
      baselineValue?.callCount !== currentValue?.callCount ||
      baselineValue?.functionCount !== currentValue?.functionCount
    );
  }).length;
  return {
    functions,
    files,
    totalFunctionChanges,
    totalFileChanges,
    truncated:
      before.truncated || after.truncated || totalFunctionChanges > functions.length || totalFileChanges > files.length,
  };
}

function duration(trace: RuntimeTrace): number {
  return Math.max(0, trace.stoppedAt - trace.startedAt);
}

/** Compare a baseline and current Quick Test trace without performing IO. */
export function compareQuickTestRuns(
  baseline: RuntimeTrace,
  current: RuntimeTrace,
  rawOptions: CompareQuickTestRunsOptions = {}
): QuickTestRunDiff {
  const options = normalizeOptions(rawOptions);
  const baselineInteractions = collectInteractions(baseline, options.maxInteractionSteps);
  const currentInteractions = collectInteractions(current, options.maxInteractionSteps);
  const interactions = alignInteractions(baselineInteractions.items, currentInteractions.items);
  const errors = compareErrors(baseline, current, options.maxChanges);
  const network = compareNetwork(baseline, current, options);
  const coverage = compareCoverage(baseline, current, options);
  const baselineMs = duration(baseline);
  const currentMs = duration(current);
  const deltaMs = currentMs - baselineMs;
  const interactionChanges = interactions.filter((value) => value.status !== 'unchanged').length;
  const truncated =
    baselineInteractions.truncated ||
    currentInteractions.truncated ||
    errors.truncated ||
    network.truncated ||
    coverage.truncated;

  return {
    baseline: { platform: baseline.platform, startedAt: baseline.startedAt, eventCount: baseline.events.length },
    current: { platform: current.platform, startedAt: current.startedAt, eventCount: current.events.length },
    interactions,
    errors: { added: errors.added, resolved: errors.resolved },
    network: network.changes,
    duration: {
      baselineMs,
      currentMs,
      deltaMs,
      deltaPercent: baselineMs === 0 ? null : Math.round((deltaMs / baselineMs) * 10_000) / 100,
    },
    coverage: { functions: coverage.functions, files: coverage.files },
    summary: {
      interactionChanges,
      newErrors: errors.totalAdded,
      resolvedErrors: errors.totalResolved,
      networkChanges: network.totalChanges,
      coverageFunctionChanges: coverage.totalFunctionChanges,
      coverageFileChanges: coverage.totalFileChanges,
      durationDeltaMs: deltaMs,
      hasRegressionSignals: errors.totalAdded > 0 || network.hasRegression,
      truncated,
    },
  };
}

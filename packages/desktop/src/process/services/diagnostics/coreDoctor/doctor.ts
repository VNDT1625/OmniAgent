/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CoreAdapter, DetectedCoreTarget } from '@process/experimentalCore/adapters/coreAdapter';
import { validateAcpCatalog } from '@process/experimentalCore/adapters/acpCompatibility';
import { summarizeCoreTelemetry } from '../coreTelemetry';
import type { CoreTelemetryEvent } from '../coreTelemetry';
import type { CoreDoctorCheck, CoreDoctorReport } from './types';

const rate = (part: number, total: number): number => (total === 0 ? 0 : part / total);

const percentile95 = (values: number[]): number | undefined => {
  if (values.length === 0) return undefined;
  const sorted = values.toSorted((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
};

/** Pure, renderer-safe report data. It never exposes commands, paths, prompts, output, credentials or stderr. */
export const buildCoreDoctorReport = (input: {
  targets: DetectedCoreTarget[];
  adapters: CoreAdapter[];
  telemetry: CoreTelemetryEvent[];
  generatedAt?: number;
  stalledAfterMs?: number;
}): CoreDoctorReport => {
  const generatedAt = input.generatedAt ?? Date.now();
  const stalledAfterMs = input.stalledAfterMs ?? 5 * 60_000;
  const checks: CoreDoctorCheck[] = [];
  const targetIds = new Set<string>();
  for (const target of input.targets) {
    if (targetIds.has(target.id)) {
      checks.push({
        id: 'target-duplicate',
        status: 'error',
        targetId: target.id,
        summary: 'Target ID is duplicated.',
      });
    }
    targetIds.add(target.id);
    const adapter = input.adapters.find((candidate) => candidate.protocol === target.protocol);
    if (target.available && !adapter) {
      checks.push({
        id: 'adapter-missing',
        status: 'error',
        targetId: target.id,
        summary: `No direct adapter is registered for protocol ${target.protocol}.`,
      });
    } else if (!target.detected) {
      checks.push({
        id: 'target-not-detected',
        status: 'warning',
        targetId: target.id,
        summary: 'Executable is not detected.',
      });
    } else if (!target.available) {
      checks.push({
        id: 'target-disabled',
        status: 'warning',
        targetId: target.id,
        summary: 'Target is detected but disabled.',
      });
    } else {
      checks.push({ id: 'target-ready', status: 'pass', targetId: target.id, summary: 'Direct adapter is ready.' });
    }
  }
  for (const issue of validateAcpCatalog(input.targets)) {
    checks.push({ id: 'acp-catalog', status: issue.severity, targetId: issue.targetId, summary: issue.message });
  }

  const metrics = summarizeCoreTelemetry(input.telemetry);
  for (const run of metrics) {
    if (!run.terminalState && generatedAt - run.startedAt > stalledAfterMs) {
      checks.push({
        id: 'run-stalled',
        status: 'warning',
        targetId: run.targetId,
        summary: 'A run has no terminal event.',
      });
    }
  }
  const completed = metrics.filter((item) => item.terminalState === 'completed').length;
  const retried = metrics.filter((item) => item.retryCount > 0).length;
  const toolCalls = metrics.reduce((sum, item) => sum + item.toolCallCount, 0);
  const toolFailures = metrics.reduce((sum, item) => sum + item.toolFailureCount, 0);
  const failed = metrics.filter((item) => item.terminalState === 'failed').length;
  if (metrics.length > 0 && rate(failed, metrics.length) >= 0.5) {
    checks.push({ id: 'failure-rate', status: 'error', summary: 'At least half of recent runs failed.' });
  }

  return {
    generatedAt,
    status: checks.some((check) => check.status === 'error')
      ? 'unhealthy'
      : checks.some((check) => check.status === 'warning')
        ? 'degraded'
        : 'healthy',
    checks,
    metrics: {
      runCount: metrics.length,
      completionRate: rate(completed, metrics.length),
      retryRate: rate(retried, metrics.length),
      startupP95Ms: percentile95(metrics.flatMap((item) => (item.startupMs === undefined ? [] : [item.startupMs]))),
      toolFailureRate: rate(toolFailures, toolCalls),
      firstTokenP95Ms: percentile95(
        metrics.flatMap((item) => (item.firstTokenMs === undefined ? [] : [item.firstTokenMs]))
      ),
      completionP95Ms: percentile95(
        metrics.flatMap((item) => (item.completionMs === undefined ? [] : [item.completionMs]))
      ),
    },
  };
};

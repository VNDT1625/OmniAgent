/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { redactTelemetryText, sanitizeTelemetryAttributes } from './redaction';
import type {
  CoreRunMetrics,
  CoreTelemetryEvent,
  CoreTelemetryEventKind,
  CoreTelemetryRunIdentity,
  CoreTelemetrySink,
} from './types';

type ActiveRun = CoreRunMetrics & { terminal: boolean };

export class CoreTelemetryRecorder {
  private readonly runs = new Map<string, ActiveRun>();
  private readonly initialized: Promise<void>;

  public constructor(
    private readonly sink: CoreTelemetrySink,
    private readonly now: () => number = Date.now
  ) {
    this.initialized = sink.initialize();
  }

  public async startRun(identity: CoreTelemetryRunIdentity, attributes?: Record<string, unknown>): Promise<void> {
    if (this.runs.has(identity.runId)) return;
    const startedAt = this.now();
    this.runs.set(identity.runId, {
      ...identity,
      startedAt,
      retryCount: 0,
      toolCallCount: 0,
      toolFailureCount: 0,
      terminal: false,
    });
    await this.record(identity, 'run-started', attributes);
  }

  public async startupCompleted(identity: CoreTelemetryRunIdentity, elapsedMs: number): Promise<void> {
    await this.record({ ...identity, startedAt: this.now() - Math.max(0, elapsedMs) }, 'startup-completed');
  }

  public async firstToken(runId: string): Promise<void> {
    const run = this.active(runId);
    if (run.firstTokenMs !== undefined) return;
    run.firstTokenMs = Math.max(0, this.now() - run.startedAt);
    await this.record(run, 'first-token');
  }

  public async retry(runId: string, reason?: string): Promise<void> {
    const run = this.active(runId);
    run.retryCount += 1;
    await this.record(run, 'retry', reason ? { retryReason: reason } : undefined, { attempt: run.retryCount + 1 });
  }

  public async toolStarted(runId: string, tool: string): Promise<void> {
    const run = this.active(runId);
    run.toolCallCount += 1;
    await this.record(run, 'tool-started', undefined, { tool: redactTelemetryText(tool) });
  }

  public async toolCompleted(runId: string, tool: string, outcome: 'success' | 'error'): Promise<void> {
    const run = this.active(runId);
    if (outcome === 'error') run.toolFailureCount += 1;
    await this.record(run, 'tool-completed', undefined, { tool: redactTelemetryText(tool), outcome });
  }

  public complete(runId: string): Promise<void> {
    return this.finish(runId, 'completed');
  }

  public cancel(runId: string, reason?: string): Promise<void> {
    return this.finish(runId, 'cancelled', reason ? { reason } : undefined);
  }

  public fail(runId: string, errorCode?: string): Promise<void> {
    return this.finish(runId, 'failed', errorCode ? { errorCode } : undefined);
  }

  public snapshot(runId: string): CoreRunMetrics | undefined {
    const run = this.runs.get(runId);
    if (!run) return undefined;
    const { terminal: _terminal, ...metrics } = run;
    return structuredClone(metrics);
  }

  private active(runId: string): ActiveRun {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Telemetry run "${runId}" has not started.`);
    if (run.terminal) throw new Error(`Telemetry run "${runId}" is already terminal.`);
    return run;
  }

  private async finish(
    runId: string,
    state: Extract<CoreTelemetryEventKind, 'completed' | 'cancelled' | 'failed'>,
    attributes?: Record<string, unknown>
  ): Promise<void> {
    const run = this.active(runId);
    run.completionMs = Math.max(0, this.now() - run.startedAt);
    run.terminalState = state;
    run.terminal = true;
    await this.record(run, state, attributes);
  }

  private async record(
    identity: CoreTelemetryRunIdentity & { startedAt?: number },
    kind: CoreTelemetryEventKind,
    attributes?: Record<string, unknown>,
    fields: Pick<CoreTelemetryEvent, 'attempt' | 'tool' | 'outcome'> = {}
  ): Promise<void> {
    await this.initialized;
    const timestamp = this.now();
    await this.sink.append({
      eventId: randomUUID(),
      runId: identity.runId,
      sessionId: identity.sessionId,
      targetId: identity.targetId,
      kind,
      timestamp,
      elapsedMs: identity.startedAt === undefined ? 0 : Math.max(0, timestamp - identity.startedAt),
      ...fields,
      attributes: sanitizeTelemetryAttributes(attributes),
    });
  }
}

export const summarizeCoreTelemetry = (events: CoreTelemetryEvent[]): CoreRunMetrics[] => {
  const runs = new Map<string, CoreRunMetrics>();
  for (const event of events) {
    const metrics = runs.get(event.runId) ?? {
      runId: event.runId,
      sessionId: event.sessionId,
      targetId: event.targetId,
      startedAt: event.kind === 'run-started' ? event.timestamp : event.timestamp - event.elapsedMs,
      retryCount: 0,
      toolCallCount: 0,
      toolFailureCount: 0,
    };
    if (event.kind === 'startup-completed' && metrics.startupMs === undefined) metrics.startupMs = event.elapsedMs;
    if (event.kind === 'first-token' && metrics.firstTokenMs === undefined) metrics.firstTokenMs = event.elapsedMs;
    if (event.kind === 'retry') metrics.retryCount += 1;
    if (event.kind === 'tool-started') metrics.toolCallCount += 1;
    if (event.kind === 'tool-completed' && event.outcome === 'error') metrics.toolFailureCount += 1;
    if (event.kind === 'completed' || event.kind === 'cancelled' || event.kind === 'failed') {
      metrics.completionMs = event.elapsedMs;
      metrics.terminalState = event.kind;
    }
    runs.set(event.runId, metrics);
  }
  return [...runs.values()];
};

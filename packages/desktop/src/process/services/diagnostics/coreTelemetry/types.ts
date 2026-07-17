/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

export type CoreTelemetryEventKind =
  | 'run-started'
  | 'startup-completed'
  | 'first-token'
  | 'retry'
  | 'tool-started'
  | 'tool-completed'
  | 'completed'
  | 'cancelled'
  | 'failed';

export type CoreTelemetryEvent = {
  eventId: string;
  runId: string;
  sessionId: string;
  targetId: string;
  kind: CoreTelemetryEventKind;
  timestamp: number;
  elapsedMs: number;
  attempt?: number;
  tool?: string;
  outcome?: 'success' | 'error';
  attributes?: Record<string, unknown>;
};

export type CoreRunMetrics = {
  runId: string;
  sessionId: string;
  targetId: string;
  startedAt: number;
  startupMs?: number;
  firstTokenMs?: number;
  completionMs?: number;
  retryCount: number;
  toolCallCount: number;
  toolFailureCount: number;
  terminalState?: 'completed' | 'cancelled' | 'failed';
};

export type CoreTelemetrySink = {
  initialize(): Promise<void>;
  append(event: CoreTelemetryEvent): Promise<void>;
  query(filter?: { runId?: string; sessionId?: string; limit?: number }): Promise<CoreTelemetryEvent[]>;
};

export type CoreTelemetryRunIdentity = Pick<CoreTelemetryEvent, 'runId' | 'sessionId' | 'targetId'>;

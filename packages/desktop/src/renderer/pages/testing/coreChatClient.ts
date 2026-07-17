/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { bridge } from '@office-ai/platform';

export type CoreTargetKind = 'builtin' | 'acp' | 'cli' | 'remote';
export type CorePermissionMode = 'read-only' | 'workspace-write' | 'full-access';
export type CoreSessionStatus = 'idle' | 'running' | 'completed' | 'interrupted' | 'error' | 'cancelled';
export type CoreSessionMessage = { role: 'user' | 'assistant'; text: string; timestamp: number };
export type CoreSessionTransition = {
  fromTargetId: string;
  toTargetId: string;
  fromModelKey?: string;
  toModelKey?: string;
  timestamp: number;
};
export type CoreSession = {
  id: string;
  parentId?: string;
  targetId: string;
  workspace: string;
  modelKey?: string;
  companyId?: string;
  surface?: string;
  agentId?: string;
  personalId?: string;
  permissionScopes?: string[];
  capabilityGrants?: string[];
  availableCapabilities?: string[];
  modelCapabilities?: string[];
  permissionMode: CorePermissionMode;
  status: CoreSessionStatus;
  createdAt: number;
  updatedAt: number;
  messages: CoreSessionMessage[];
  transitions?: CoreSessionTransition[];
  lastError?: string;
};
export type CoreModel = {
  key: string;
  modelId: string;
  label: string;
  providerId?: string;
  isDefault: boolean;
};
export type CoreTarget = {
  id: string;
  name: string;
  kind: CoreTargetKind;
  available: boolean;
  detail?: string;
  models: CoreModel[];
  defaultModelKey?: string;
};
export type CoreEvent = {
  requestId: string;
  sessionId: string;
  targetId: string;
  type:
    | 'started'
    | 'delta'
    | 'status'
    | 'thinking'
    | 'step'
    | 'tool-call'
    | 'tool-result'
    | 'permission'
    | 'orchestration-created'
    | 'completed'
    | 'error'
    | 'cancelled';
  timestamp: number;
  sequence: number;
  text?: string;
  mode?: 'append' | 'replace';
  permissionId?: string;
  tool?: string;
  callId?: string;
  phase?: 'requested' | 'running';
  outcome?: 'success' | 'error';
  workspace?: string;
  detail?: string;
  orchestrationKind?: 'team' | 'company';
  orchestrationId?: string;
};

export type CoreRunSnapshot = {
  requestId: string;
  sessionId: string;
  targetId: string;
  startedAt: number;

  partialText: string;
  events: CoreEvent[];
  pendingPermissionIds: string[];
};

export type CoreTelemetryEvent = {
  eventId: string;
  runId: string;
  sessionId: string;
  targetId: string;
  kind:
    | 'run-started'
    | 'startup-completed'
    | 'first-token'
    | 'retry'
    | 'tool-started'
    | 'tool-completed'
    | 'completed'
    | 'cancelled'
    | 'failed';
  timestamp: number;
  elapsedMs: number;
  attempt?: number;
  tool?: string;
  outcome?: 'success' | 'error';
  attributes?: Record<string, unknown>;
};

export type CoreDoctorReport = {
  generatedAt: number;
  status: 'healthy' | 'degraded' | 'unhealthy';
  checks: Array<{
    id: string;
    status: 'pass' | 'warning' | 'error';
    summary: string;
    targetId?: string;
  }>;
  metrics: {
    runCount: number;
    startupP95Ms?: number;
    completionRate: number;
    retryRate: number;
    toolFailureRate: number;
    firstTokenP95Ms?: number;
    completionP95Ms?: number;
  };
};

const CORE_CALL_TIMEOUT_MS = 6000;

/** Bound IPC calls so a stale/unwired Electron Main process cannot leave the UI spinning forever. */
export const withCoreTimeout = <T>(promise: Promise<T>, label: string, timeoutMs = CORE_CALL_TIMEOUT_MS): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_resolve, reject) =>
      setTimeout(
        () => reject(new Error(`The experimental core bridge did not respond (${label}). Restart the desktop app.`)),
        timeoutMs
      )
    ),
  ]);

const channels = {
  listTargets: bridge.buildProvider<CoreTarget[], void>('experimental-core.list-targets'),
  listModels: bridge.buildProvider<CoreModel[], { targetId: string; workspace: string }>(
    'experimental-core.list-models'
  ),
  listSessions: bridge.buildProvider<CoreSession[], void>('experimental-core.list-sessions'),

  listActiveRuns: bridge.buildProvider<CoreRunSnapshot[], void>('experimental-core.list-active-runs'),
  replayEvents: bridge.buildProvider<
    CoreEvent[],
    { sessionId?: string; requestId?: string; afterSequence?: number; limit?: number }
  >('experimental-core.replay-events'),
  resumeInterrupted: bridge.buildProvider<
    { requestId: string; sessionId: string },
    { sessionId: string; requestId: string }
  >('experimental-core.resume-interrupted'),
  forkSession: bridge.buildProvider<CoreSession, { sessionId: string }>('experimental-core.fork-session'),
  start: bridge.buildProvider<
    { requestId: string; sessionId: string },
    {
      requestId: string;
      sessionId?: string;
      targetId: string;
      prompt: string;
      workspace?: string;
      modelKey?: string;
      companyId?: string;
      surface?: string;
      agentId?: string;
      personalId?: string;
      permissionScopes?: string[];
      capabilityGrants?: string[];
      availableCapabilities?: string[];
      modelCapabilities?: string[];
      permissionMode?: CorePermissionMode;
    }
  >('experimental-core.start'),
  cancel: bridge.buildProvider<boolean, { requestId: string }>('experimental-core.cancel'),
  resolvePermission: bridge.buildProvider<
    boolean,
    { permissionId: string; approved: boolean; lifetime?: 'allow-once' | 'session' | 'persistent' }
  >('experimental-core.resolve-permission'),
  queryTelemetry: bridge.buildProvider<CoreTelemetryEvent[], { runId?: string; sessionId?: string; limit?: number }>(
    'experimental-core.query-telemetry'
  ),
  doctor: bridge.buildProvider<CoreDoctorReport, { limit?: number }>('experimental-core.doctor'),
  event: bridge.buildEmitter<CoreEvent>('experimental-core.event'),
};

export const coreChatClient = {
  listTargets: (): Promise<CoreTarget[]> => withCoreTimeout(channels.listTargets.invoke(), 'listTargets'),
  listModels: (targetId: string, workspace: string): Promise<CoreModel[]> =>
    withCoreTimeout(channels.listModels.invoke({ targetId, workspace }), 'listModels', 20_000),
  listSessions: (): Promise<CoreSession[]> => withCoreTimeout(channels.listSessions.invoke(), 'listSessions'),

  listActiveRuns: (): Promise<CoreRunSnapshot[]> => withCoreTimeout(channels.listActiveRuns.invoke(), 'listActiveRuns'),
  replayEvents: (query: {
    sessionId?: string;
    requestId?: string;
    afterSequence?: number;
    limit?: number;
  }): Promise<CoreEvent[]> => withCoreTimeout(channels.replayEvents.invoke(query), 'replayEvents'),
  resumeInterrupted: (sessionId: string, requestId: string): Promise<{ requestId: string; sessionId: string }> =>
    withCoreTimeout(channels.resumeInterrupted.invoke({ sessionId, requestId }), 'resumeInterrupted'),
  forkSession: (sessionId: string): Promise<CoreSession> =>
    withCoreTimeout(channels.forkSession.invoke({ sessionId }), 'forkSession'),
  start: (request: {
    requestId: string;
    sessionId?: string;
    targetId: string;
    prompt: string;
    workspace?: string;
    modelKey?: string;
    companyId?: string;
    surface?: string;
    agentId?: string;
    personalId?: string;
    permissionScopes?: string[];
    capabilityGrants?: string[];
    availableCapabilities?: string[];
    modelCapabilities?: string[];
    permissionMode?: CorePermissionMode;
  }): Promise<{ requestId: string; sessionId: string }> => withCoreTimeout(channels.start.invoke(request), 'start'),
  cancel: (requestId: string): Promise<boolean> => withCoreTimeout(channels.cancel.invoke({ requestId }), 'cancel'),
  resolvePermission: (
    permissionId: string,
    approved: boolean,
    lifetime?: 'allow-once' | 'session' | 'persistent'
  ): Promise<boolean> =>
    withCoreTimeout(channels.resolvePermission.invoke({ permissionId, approved, lifetime }), 'resolvePermission'),
  queryTelemetry: (query: { runId?: string; sessionId?: string; limit?: number } = {}): Promise<CoreTelemetryEvent[]> =>
    withCoreTimeout(channels.queryTelemetry.invoke(query), 'queryTelemetry'),
  doctor: (limit?: number): Promise<CoreDoctorReport> =>
    withCoreTimeout(channels.doctor.invoke({ limit }), 'doctor', 20_000),
  onEvent: (listener: (event: CoreEvent) => void): (() => void) => channels.event.on(listener),
};

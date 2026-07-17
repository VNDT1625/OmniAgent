/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExperimentalPermissionMode } from '@process/experimentalCore/experimentalCoreProtocol';

export type CoreScheduleSpec =
  | { kind: 'cron'; expression: string; timezone: string }
  | { kind: 'once'; at: number; timezone: string }
  | { kind: 'interval'; everyMs: number; timezone: string }
  | { kind: 'manual'; timezone: string };
export type CoreScheduleOverlapPolicy = 'skip' | 'queue-one';
export type CoreScheduleMissedRunPolicy = 'skip' | 'run-once';
export type CoreScheduleRunStatus = 'idle' | 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';

export type CoreScheduleRetryPolicy = {
  maxAttempts: number;
  initialDelayMs: number;
  maxDelayMs: number;
  backoffMultiplier: number;
};

/** Immutable execution identity captured when the user saves a schedule. */
export type CoreScheduleTargetSnapshot = {
  targetId: string;
  prompt: string;
  workspace: string;
  modelKey?: string;
  permissionMode: ExperimentalPermissionMode;

  unattendedPermissionPolicy: 'deny' | 'allow-granted';
  surface: string;
  agentId: string;
  personalId: string;
  companyId?: string;
  sessionId?: string;
  permissionScopes: string[];
  capabilityGrants: string[];
  availableCapabilities: string[];
  modelCapabilities: string[];
};

export type CoreScheduleRuntime = {
  nextRunAt: number | null;
  lastRunAt: number | null;
  lastCompletedAt: number | null;
  lastStatus: CoreScheduleRunStatus;
  lastError: string | null;
  activeRunId: string | null;
  consecutiveFailures: number;
};

export type CoreScheduledTask = {
  id: string;
  name: string;
  enabled: boolean;
  schedule: CoreScheduleSpec;
  overlapPolicy: CoreScheduleOverlapPolicy;
  missedRunPolicy: CoreScheduleMissedRunPolicy;
  retry: CoreScheduleRetryPolicy;
  target: CoreScheduleTargetSnapshot;
  /** Compatibility metadata used by the existing Scheduled Tasks UI. */
  legacy?: {
    description?: string;
    scheduleDescription?: string;
    conversationId: string;
    conversationTitle?: string;
    agentType: string;
    createdBy: 'user' | 'agent';
    executionMode?: 'existing' | 'new_conversation';
    agentConfig?: {
      backend: string;
      name: string;
      cli_path?: string;
      is_preset?: boolean;
      custom_agent_id?: string;
      preset_agent_type?: string;
      mode?: string;
      model_id?: string;
      config_options?: Record<string, string>;
      workspace?: string;
    };
  };
  runtime: CoreScheduleRuntime;
  createdAt: number;
  updatedAt: number;
};

export type CoreScheduleAuditKind =
  | 'schedule.created'
  | 'schedule.updated'
  | 'schedule.removed'
  | 'schedule.armed'
  | 'run.started'
  | 'run.retrying'
  | 'run.completed'
  | 'run.failed'
  | 'run.cancelled'
  | 'run.interrupted'
  | 'run.skipped.missed'
  | 'run.skipped.overlap'
  | 'run.queued';

export type CoreScheduleAuditEvent = {
  id: string;
  taskId: string;
  runId?: string;
  kind: CoreScheduleAuditKind;
  timestamp: number;
  attempt?: number;
  detail?: string;
};

export type CoreScheduleDraft = Omit<CoreScheduledTask, 'id' | 'runtime' | 'createdAt' | 'updatedAt'> & {
  id?: string;
};

export type CoreScheduleRunInput = {
  runId: string;
  taskId: string;
  scheduledFor: number;
  attempt: number;
  target: CoreScheduleTargetSnapshot;
  signal: AbortSignal;
};

export type CoreScheduleRunner = { run(input: CoreScheduleRunInput): Promise<void> };

export type CoreScheduleStore = {
  initialize(): Promise<void>;
  list(): Promise<CoreScheduledTask[]>;
  get(id: string): Promise<CoreScheduledTask | undefined>;
  save(task: CoreScheduledTask): Promise<void>;
  remove(id: string): Promise<void>;
  appendAudit(event: CoreScheduleAuditEvent): Promise<void>;
  listAudit(taskId?: string): Promise<CoreScheduleAuditEvent[]>;
};

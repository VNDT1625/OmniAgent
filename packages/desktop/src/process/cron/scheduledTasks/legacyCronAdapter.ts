/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ICronJob, ICronSchedule, ICreateCronJobParams } from '@/common/adapter/ipcBridge';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CronServiceClient } from '@process/resources/builtinMcp/cronServer';
import type { CoreScheduledTaskService } from './service';
import type { CoreScheduleDraft, CoreScheduledTask } from './types';

export type LegacyCronEvents = {
  created(job: ICronJob): void;
  updated(job: ICronJob): void;
  removed(jobId: string): void;
  executed(event: { job_id: string; status: 'ok' | 'error' | 'skipped' | 'missed'; error?: string }): void;
};

export type LegacyCronAdapterOptions = {
  service: CoreScheduledTaskService;
  skillsDirectory: string;
  defaultWorkspace: string;
  events?: Partial<LegacyCronEvents>;
  timezone?: () => string;
  ready?: Promise<void>;
};

const DEFAULT_RETRY = {
  maxAttempts: 5,
  initialDelayMs: 1_000,
  maxDelayMs: 15_000,
  backoffMultiplier: 2,
} as const;

const normalizeTargetId = (agentType: string, backend?: string): string => {
  const raw = agentType.replace(/^cli:/u, '').replace(/^preset:/u, '');
  if (raw === 'aionrs' || raw === 'tomni' || raw === 'tomny') return 'tomny';
  if (raw === 'acp') return backend || 'claude';
  if (raw === 'openclaw-gateway') return 'openclaw';
  return raw || backend || 'tomny';
};

const toCoreSchedule = (schedule: ICronSchedule, fallbackTimezone: string): CoreScheduleDraft['schedule'] => {
  if (schedule.kind === 'at') return { kind: 'once', at: schedule.atMs, timezone: fallbackTimezone };
  if (schedule.kind === 'every') return { kind: 'interval', everyMs: schedule.everyMs, timezone: fallbackTimezone };
  if (!schedule.expr.trim()) return { kind: 'manual', timezone: schedule.tz || fallbackTimezone };
  return { kind: 'cron', expression: schedule.expr, timezone: schedule.tz || fallbackTimezone };
};

const toLegacySchedule = (task: CoreScheduledTask): ICronSchedule => {
  if (task.schedule.kind === 'once')
    return { kind: 'at', atMs: task.schedule.at, description: task.legacy?.scheduleDescription || '' };
  if (task.schedule.kind === 'interval')
    return { kind: 'every', everyMs: task.schedule.everyMs, description: task.legacy?.scheduleDescription || '' };
  if (task.schedule.kind === 'manual')
    return { kind: 'cron', expr: '', tz: task.schedule.timezone, description: task.legacy?.scheduleDescription || '' };
  return {
    kind: 'cron',
    expr: task.schedule.expression,
    tz: task.schedule.timezone,
    description: task.legacy?.scheduleDescription || '',
  };
};

const toLegacyStatus = (status: CoreScheduledTask['runtime']['lastStatus']): ICronJob['state']['last_status'] => {
  if (status === 'completed') return 'ok';
  if (status === 'failed' || status === 'cancelled' || status === 'interrupted') return 'error';
  return undefined;
};

const skillPath = (directory: string, jobId: string): string =>
  path.join(directory, createHash('sha256').update(jobId).digest('hex'), 'SKILL.md');

export class LegacyCronAdapter implements CronServiceClient {
  public constructor(private readonly options: LegacyCronAdapterOptions) {}

  private async ready(): Promise<void> {
    await this.options.ready;
  }

  private timezone(): string {
    return this.options.timezone?.() || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  }

  private async toLegacy(task: CoreScheduledTask): Promise<ICronJob> {
    const audit = await this.options.service.listAudit(task.id);
    const runCount = audit.filter((event) => event.kind === 'run.started').length;
    const retryCount = audit.filter((event) => event.kind === 'run.retrying').length;
    const legacy = task.legacy;
    return {
      id: task.id,
      name: task.name,
      description: legacy?.description,
      enabled: task.enabled,
      schedule: toLegacySchedule(task),
      target: {
        payload: { kind: 'message', text: task.target.prompt },
        execution_mode: legacy?.executionMode,
      },
      metadata: {
        conversation_id: legacy?.conversationId || task.target.sessionId || task.id,
        conversation_title: legacy?.conversationTitle,
        agent_type: legacy?.agentType || task.target.targetId,
        created_by: legacy?.createdBy || 'user',
        created_at: task.createdAt,
        updated_at: task.updatedAt,
        agent_config: legacy?.agentConfig,
      },
      state: {
        next_run_at_ms: task.runtime.nextRunAt ?? undefined,
        last_run_at_ms: task.runtime.lastRunAt ?? undefined,
        last_status: toLegacyStatus(task.runtime.lastStatus),
        last_error: task.runtime.lastError ?? undefined,
        run_count: runCount,
        retry_count: retryCount,
        max_retries: Math.max(0, task.retry.maxAttempts - 1),
      },
    };
  }

  private toDraft(params: ICreateCronJobParams, id?: string): CoreScheduleDraft {
    const backend = params.agent_config?.backend;
    const targetId = normalizeTargetId(params.agent_type, backend);
    const workspace = params.agent_config?.workspace?.trim() || this.options.defaultWorkspace;
    const modelId = params.agent_config?.model_id;
    const modelKey =
      params.agent_type === 'aionrs' && backend && modelId
        ? `app-provider:${encodeURIComponent(backend)}:${encodeURIComponent(modelId)}`
        : modelId;
    const fullAccessMode = params.agent_config?.mode;
    const permissionMode =
      fullAccessMode === 'plan' || fullAccessMode === 'read-only' || fullAccessMode === 'ask'
        ? 'read-only'
        : 'full-access';
    return {
      id,
      name: params.name,
      enabled: true,
      schedule: toCoreSchedule(params.schedule, this.timezone()),
      overlapPolicy: 'skip',
      missedRunPolicy: 'run-once',
      retry: { ...DEFAULT_RETRY },
      target: {
        targetId,
        prompt: params.prompt ?? params.message ?? '',
        workspace,
        modelKey,
        permissionMode,
        unattendedPermissionPolicy: permissionMode === 'full-access' ? 'allow-granted' : 'deny',
        surface: permissionMode === 'read-only' ? 'chat' : 'ide',
        agentId: `scheduled:${id || params.conversation_id}`,
        personalId: 'default',
        sessionId: params.execution_mode === 'existing' ? params.conversation_id : undefined,
        permissionScopes: permissionMode === 'full-access' ? ['*', 'workspace.read', 'workspace.write'] : [],
        capabilityGrants: permissionMode === 'full-access' ? ['surface.ide'] : [],
        availableCapabilities: permissionMode === 'full-access' ? ['surface.ide'] : [],
        modelCapabilities: ['tools'],
      },
      legacy: {
        description: params.description,
        scheduleDescription: params.schedule.description,
        conversationId: params.conversation_id,
        conversationTitle: params.conversation_title,
        agentType: params.agent_type,
        createdBy: params.created_by,
        executionMode: params.execution_mode,
        agentConfig: params.agent_config,
      },
    };
  }

  public async listJobs(): Promise<ICronJob[]> {
    await this.ready();
    return Promise.all((await this.options.service.list()).map((task) => this.toLegacy(task)));
  }

  public async listJobsByConversation(params: { conversation_id: string }): Promise<ICronJob[]> {
    const jobs = await this.listJobs();
    return jobs.filter((job) => job.metadata.conversation_id === params.conversation_id);
  }

  public async getJob(params: { job_id: string }): Promise<ICronJob | null> {
    await this.ready();
    const task = await this.options.service.get(params.job_id);
    return task ? this.toLegacy(task) : null;
  }

  public async addJob(params: ICreateCronJobParams): Promise<ICronJob> {
    await this.ready();
    const saved = await this.options.service.save(this.toDraft(params));
    const job = await this.toLegacy(saved);
    this.options.events?.created?.(job);
    return job;
  }

  public async updateJob(params: { job_id: string; updates: Partial<ICronJob> }): Promise<ICronJob> {
    await this.ready();
    const existing = await this.getJob({ job_id: params.job_id });
    if (!existing) throw new Error(`Scheduled task not found: ${params.job_id}`);
    const merged: ICronJob = {
      ...existing,
      ...params.updates,
      target: { ...existing.target, ...params.updates.target },
      metadata: { ...existing.metadata, ...params.updates.metadata },
      state: { ...existing.state, ...params.updates.state },
    };
    const draft = this.toDraft(
      {
        name: merged.name,
        description: merged.description,
        schedule: merged.schedule,
        message: merged.target.payload.text,
        conversation_id: merged.metadata.conversation_id,
        conversation_title: merged.metadata.conversation_title,
        agent_type: merged.metadata.agent_type,
        created_by: merged.metadata.created_by,
        execution_mode: merged.target.execution_mode,
        agent_config: merged.metadata.agent_config,
      },
      params.job_id
    );
    draft.enabled = merged.enabled;
    draft.retry.maxAttempts = Math.max(1, merged.state.max_retries + 1);
    const job = await this.toLegacy(await this.options.service.save(draft));
    this.options.events?.updated?.(job);
    return job;
  }

  public async removeJob(params: { job_id: string }): Promise<void> {
    await this.ready();
    await this.options.service.remove(params.job_id);
    await this.deleteSkill(params);
    this.options.events?.removed?.(params.job_id);
  }

  public async runNow(params: { job_id: string }): Promise<{ conversation_id: string }> {
    await this.ready();
    await this.options.service.runNow(params.job_id);
    const job = await this.getJob(params);
    if (!job) throw new Error(`Scheduled task not found: ${params.job_id}`);
    this.options.events?.updated?.(job);
    this.options.events?.executed?.({
      job_id: job.id,
      status: job.state.last_status || 'ok',
      ...(job.state.last_error ? { error: job.state.last_error } : {}),
    });
    return { conversation_id: job.metadata.conversation_id };
  }

  public async saveSkill(params: { job_id: string; content: string }): Promise<void> {
    await this.ready();
    if (!(await this.options.service.get(params.job_id))) throw new Error(`Scheduled task not found: ${params.job_id}`);
    const file = skillPath(this.options.skillsDirectory, params.job_id);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, params.content, 'utf8');
  }

  public async hasSkill(params: { job_id: string }): Promise<boolean> {
    await this.ready();
    try {
      await readFile(skillPath(this.options.skillsDirectory, params.job_id), 'utf8');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }

  public async deleteSkill(params: { job_id: string }): Promise<void> {
    await this.ready();
    await rm(path.dirname(skillPath(this.options.skillsDirectory, params.job_id)), {
      recursive: true,
      force: true,
    });
  }
}

let configuredAdapter: LegacyCronAdapter | undefined;

export const configureLegacyCronAdapter = (adapter: LegacyCronAdapter): void => {
  configuredAdapter = adapter;
};

export const getLegacyCronAdapter = (): LegacyCronAdapter => {
  if (!configuredAdapter) throw new Error('Tomny Core scheduled task service is not initialized.');
  return configuredAdapter;
};

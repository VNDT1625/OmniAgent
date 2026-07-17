/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { bridge } from '@office-ai/platform';
import { cron } from '@/common/adapter/ipcBridge';
import { app } from 'electron';
import path from 'node:path';

import { registerNativeConversationBridge } from '@process/services/database/nativeConversation';

import { resolveLegacyDatabasePath } from '@process/services/database/runLegacyDatabaseMigrations';
import { createCompanyCoreRunner } from '@process/agentRuntime/companyCoreRunner';
import type { AgentMeshService } from '@process/agentRuntime/agentMesh/service';
import { createElectronContextServices } from '@process/agentRuntime/electronContext';
import {
  bindScheduledCoreRuntime,
  configureLegacyCronAdapter,
  createCoreScheduledTaskIpcHandlers,
  createCoreScheduledTaskService,
  createScheduledCoreRuntimeRunner,
  JsonCoreScheduleStore,
  LegacyCronAdapter,
  type CoreScheduleAuditEvent,
  type CoreScheduleDraft,
  type CoreScheduledTask,
} from '@process/cron/scheduledTasks';
import { createBuiltinSurfaceManifests, createSurfaceRegistry } from '@process/agentRuntime/surfaceRegistry';
import { JsonlDurableEventStore } from '@process/services/agentChat/durability';
import { buildCoreDoctorReport, type CoreDoctorReport } from '@process/services/diagnostics/coreDoctor';
import {
  CoreTelemetryRecorder,
  JsonlCoreTelemetrySink,
  toPublicCoreTelemetryEvent,
  type CoreTelemetryEvent,
} from '@process/services/diagnostics/coreTelemetry';
import { JsonPermissionRepository, PermissionStore } from '@process/services/agentChat/permission';
import { AcpCoreAdapter, CodexAppServerAdapter, TomnyCoreAdapter } from './adapters';
import { detectCoreTargets } from './coreRegistry';
import { createElectronSurfaceCapabilityHosts } from './electronSurfaceCapabilityHosts';
import {
  ExperimentalCoreRuntime,
  type ExperimentalCoreEvent,
  type ExperimentalCoreRunSnapshot,
  type ExperimentalCoreTarget,
} from './experimentalCoreRuntime';
import { JsonCoreSessionStore, type CoreSessionCheckpoint } from './sessionCheckpointStore';
import { createElectronRemoteCoreServices } from './remoteElectronServices';
import { getCronSkillsDir } from '@process/utils/initStorage';

export const EXPERIMENTAL_CORE_CHANNELS = {
  listTargets: 'experimental-core.list-targets',
  listModels: 'experimental-core.list-models',
  listSessions: 'experimental-core.list-sessions',

  listActiveRuns: 'experimental-core.list-active-runs',
  replayEvents: 'experimental-core.replay-events',
  resumeInterrupted: 'experimental-core.resume-interrupted',
  forkSession: 'experimental-core.fork-session',
  start: 'experimental-core.start',
  cancel: 'experimental-core.cancel',
  resolvePermission: 'experimental-core.resolve-permission',
  scheduledList: 'experimental-core.scheduled-list',
  scheduledGet: 'experimental-core.scheduled-get',
  scheduledSave: 'experimental-core.scheduled-save',
  scheduledRemove: 'experimental-core.scheduled-remove',
  scheduledRunNow: 'experimental-core.scheduled-run-now',
  scheduledCancel: 'experimental-core.scheduled-cancel',
  scheduledAudit: 'experimental-core.scheduled-audit',
  queryTelemetry: 'experimental-core.query-telemetry',
  doctor: 'experimental-core.doctor',
  event: 'experimental-core.event',
} as const;

export type CoreTelemetryQuery = { runId?: string; sessionId?: string; limit?: number };

const DEFAULT_TELEMETRY_LIMIT = 200;
const MAX_TELEMETRY_LIMIT = 1_000;

/** Keep renderer diagnostics bounded even when a caller supplies invalid input. */
export const normalizeTelemetryLimit = (limit?: number): number =>
  Math.min(
    MAX_TELEMETRY_LIMIT,
    Math.max(1, Number.isFinite(limit) ? Math.trunc(limit ?? DEFAULT_TELEMETRY_LIMIT) : DEFAULT_TELEMETRY_LIMIT)
  );

const channels = {
  listTargets: bridge.buildProvider<ExperimentalCoreTarget[], void>(EXPERIMENTAL_CORE_CHANNELS.listTargets),
  listModels: bridge.buildProvider<ExperimentalCoreTarget['models'], { targetId: string; workspace: string }>(
    EXPERIMENTAL_CORE_CHANNELS.listModels
  ),
  listSessions: bridge.buildProvider<CoreSessionCheckpoint[], void>(EXPERIMENTAL_CORE_CHANNELS.listSessions),

  listActiveRuns: bridge.buildProvider<ExperimentalCoreRunSnapshot[], void>(EXPERIMENTAL_CORE_CHANNELS.listActiveRuns),
  replayEvents: bridge.buildProvider<
    ExperimentalCoreEvent[],
    { sessionId?: string; requestId?: string; afterSequence?: number; limit?: number }
  >(EXPERIMENTAL_CORE_CHANNELS.replayEvents),
  resumeInterrupted: bridge.buildProvider<
    { requestId: string; sessionId: string },
    { sessionId: string; requestId?: string }
  >(EXPERIMENTAL_CORE_CHANNELS.resumeInterrupted),
  forkSession: bridge.buildProvider<CoreSessionCheckpoint, { sessionId: string }>(
    EXPERIMENTAL_CORE_CHANNELS.forkSession
  ),
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
      permissionMode?: 'read-only' | 'workspace-write' | 'full-access';
    }
  >(EXPERIMENTAL_CORE_CHANNELS.start),
  cancel: bridge.buildProvider<boolean, { requestId: string }>(EXPERIMENTAL_CORE_CHANNELS.cancel),
  resolvePermission: bridge.buildProvider<
    boolean,
    { permissionId: string; approved: boolean; lifetime?: 'allow-once' | 'session' | 'persistent' }
  >(EXPERIMENTAL_CORE_CHANNELS.resolvePermission),
  scheduledList: bridge.buildProvider<CoreScheduledTask[], void>(EXPERIMENTAL_CORE_CHANNELS.scheduledList),
  scheduledGet: bridge.buildProvider<CoreScheduledTask | undefined, { id: string }>(
    EXPERIMENTAL_CORE_CHANNELS.scheduledGet
  ),
  scheduledSave: bridge.buildProvider<CoreScheduledTask, { draft: CoreScheduleDraft }>(
    EXPERIMENTAL_CORE_CHANNELS.scheduledSave
  ),
  scheduledRemove: bridge.buildProvider<void, { id: string }>(EXPERIMENTAL_CORE_CHANNELS.scheduledRemove),
  scheduledRunNow: bridge.buildProvider<void, { id: string }>(EXPERIMENTAL_CORE_CHANNELS.scheduledRunNow),
  scheduledCancel: bridge.buildProvider<boolean, { id: string }>(EXPERIMENTAL_CORE_CHANNELS.scheduledCancel),
  scheduledAudit: bridge.buildProvider<CoreScheduleAuditEvent[], { taskId?: string }>(
    EXPERIMENTAL_CORE_CHANNELS.scheduledAudit
  ),
  queryTelemetry: bridge.buildProvider<CoreTelemetryEvent[], CoreTelemetryQuery>(
    EXPERIMENTAL_CORE_CHANNELS.queryTelemetry
  ),
  doctor: bridge.buildProvider<CoreDoctorReport, { limit?: number }>(EXPERIMENTAL_CORE_CHANNELS.doctor),
  event: bridge.buildEmitter<ExperimentalCoreEvent>(EXPERIMENTAL_CORE_CHANNELS.event),
};

let registered = false;

/** Register the temporary parallel-core IPC surface. */
export const registerExperimentalCoreBridge = (agentMeshService: AgentMeshService): void => {
  if (registered) return;
  registered = true;
  const sessionStore = new JsonCoreSessionStore(
    path.join(app.getPath('userData'), 'tomny-core', 'session-checkpoints.json')
  );
  const eventStore = new JsonlDurableEventStore(path.join(app.getPath('userData'), 'tomny-core', 'events.jsonl'));
  const telemetrySink = new JsonlCoreTelemetrySink(path.join(app.getPath('userData'), 'tomny-core', 'telemetry.jsonl'));
  const telemetry = new CoreTelemetryRecorder(telemetrySink);
  const permissionStore = new PermissionStore(
    new JsonPermissionRepository(path.join(app.getPath('userData'), 'tomny-core', 'permissions.json'))
  );
  const contextServices = createElectronContextServices();
  const capabilityHosts = createElectronSurfaceCapabilityHosts();
  const remoteServices = createElectronRemoteCoreServices(
    contextServices.vault,
    path.join(app.getPath('userData'), 'tomny-core', 'remote-targets.json')
  );
  const surfaceRegistry = createSurfaceRegistry({
    manifests: createBuiltinSurfaceManifests(),
    defaultSurfaceId: 'chat',
  });
  const detectTargets = async () => [...(await detectCoreTargets()), ...(await remoteServices.detectTargets())];
  const adapters = [new TomnyCoreAdapter(), new CodexAppServerAdapter(), new AcpCoreAdapter(), remoteServices.adapter];
  const coreEventListeners = new Set<(event: ExperimentalCoreEvent) => void>();
  const emitCoreEvent = (event: ExperimentalCoreEvent): void => {
    channels.event.emit(event);
    for (const listener of coreEventListeners) listener(event);
  };
  const runtime = new ExperimentalCoreRuntime(emitCoreEvent, {
    detectTargets,
    adapters,
    sessionStore,
    eventStore,
    telemetry,
    permissionStore,
    surfaceRegistry,
    companyRunner: createCompanyCoreRunner(),
    agentMeshService,
    contextComposer: contextServices.composer,
    resolveCapabilityHosts: (serverNames) => capabilityHosts.resolve(serverNames),
  });
  registerNativeConversationBridge({
    filePath: path.join(app.getPath('userData'), 'tomny-core', 'conversations.json'),

    legacyDatabasePath: resolveLegacyDatabasePath(),
    runtime,
    subscribeCore: (listener) => {
      coreEventListeners.add(listener);
      return () => coreEventListeners.delete(listener);
    },
  });
  const scheduledPort = bindScheduledCoreRuntime(runtime, (listener) => {
    coreEventListeners.add(listener);
    return () => coreEventListeners.delete(listener);
  });
  let legacyCronAdapter!: LegacyCronAdapter;
  const scheduledService = createCoreScheduledTaskService({
    store: new JsonCoreScheduleStore(path.join(app.getPath('userData'), 'tomny-core', 'scheduled-tasks.json')),
    runner: createScheduledCoreRuntimeRunner(scheduledPort),
    onAudit: (event) => {
      if (!legacyCronAdapter || !event.kind.startsWith('run.')) return;
      setTimeout(() => {
        void legacyCronAdapter?.getJob({ job_id: event.taskId }).then((job) => {
          if (!job) return;
          cron.onJobUpdated.emit(job);
          if (event.kind === 'run.completed') cron.onJobExecuted.emit({ job_id: event.taskId, status: 'ok' });
          else if (event.kind === 'run.failed' || event.kind === 'run.cancelled' || event.kind === 'run.interrupted')
            cron.onJobExecuted.emit({ job_id: event.taskId, status: 'error', error: event.detail });
          else if (event.kind === 'run.skipped.missed')
            cron.onJobExecuted.emit({ job_id: event.taskId, status: 'missed' });
          else if (event.kind === 'run.skipped.overlap')
            cron.onJobExecuted.emit({ job_id: event.taskId, status: 'skipped' });
        });
      }, 0);
    },
  });
  const scheduledReady = scheduledService.start();
  void scheduledReady.catch((error) => console.error('[TomnyCore] Scheduled task startup failed:', error));
  legacyCronAdapter = new LegacyCronAdapter({
    service: scheduledService,
    ready: scheduledReady,
    skillsDirectory: getCronSkillsDir(),
    defaultWorkspace: app.getPath('home'),
    events: {
      created: (job) => cron.onJobCreated.emit(job),
      updated: (job) => cron.onJobUpdated.emit(job),
      removed: (jobId) => cron.onJobRemoved.emit({ job_id: jobId }),
      executed: (event) => cron.onJobExecuted.emit(event),
    },
  });
  configureLegacyCronAdapter(legacyCronAdapter);
  const scheduledHandlers = createCoreScheduledTaskIpcHandlers(scheduledService);
  channels.listTargets.provider(() => runtime.listTargets());
  channels.listModels.provider(({ targetId, workspace }) => runtime.listModels(targetId, workspace));
  channels.listSessions.provider(() => runtime.listSessions());

  channels.listActiveRuns.provider(() => Promise.resolve(runtime.listActiveRuns()));
  channels.replayEvents.provider((query) => runtime.replayEvents(query));
  channels.resumeInterrupted.provider(({ sessionId, requestId }) => runtime.resumeInterrupted(sessionId, requestId));
  channels.forkSession.provider(({ sessionId }) => runtime.forkSession(sessionId));
  channels.start.provider(
    ({
      requestId,
      sessionId,
      targetId,
      prompt,
      workspace,
      modelKey,
      companyId,
      surface,
      agentId,
      personalId,
      permissionScopes,
      capabilityGrants,
      availableCapabilities,
      modelCapabilities,
      permissionMode,
    }) =>
      Promise.resolve(
        runtime.start(requestId, targetId, prompt, workspace, modelKey, permissionMode, sessionId, companyId, {
          surface,
          agentId,
          personalId,
          permissionScopes,
          capabilityGrants,
          availableCapabilities,
          modelCapabilities,
        })
      )
  );
  channels.cancel.provider(({ requestId }) => runtime.cancel(requestId));
  channels.resolvePermission.provider(({ permissionId, approved, lifetime }) =>
    runtime.resolvePermission(permissionId, approved, lifetime)
  );
  cron.listJobs.provider(() => legacyCronAdapter.listJobs());
  cron.listJobsByConversation.provider((input) => legacyCronAdapter.listJobsByConversation(input));
  cron.getJob.provider((input) => legacyCronAdapter.getJob(input));
  cron.addJob.provider((input) => legacyCronAdapter.addJob(input));
  cron.updateJob.provider((input) => legacyCronAdapter.updateJob(input));
  cron.removeJob.provider((input) => legacyCronAdapter.removeJob(input));
  cron.runNow.provider((input) => legacyCronAdapter.runNow(input));
  cron.saveSkill.provider((input) => legacyCronAdapter.saveSkill(input));
  cron.hasSkill.provider((input) => legacyCronAdapter.hasSkill(input));
  cron.deleteSkill.provider((input) => legacyCronAdapter.deleteSkill(input));
  channels.scheduledList.provider(async () => {
    await scheduledReady;
    return scheduledHandlers.list();
  });
  channels.scheduledGet.provider(async (input) => {
    await scheduledReady;
    return scheduledHandlers.get(input);
  });
  channels.scheduledSave.provider(async (input) => {
    await scheduledReady;
    return scheduledHandlers.save(input);
  });
  channels.scheduledRemove.provider(async (input) => {
    await scheduledReady;
    return scheduledHandlers.remove(input);
  });
  channels.scheduledRunNow.provider(async (input) => {
    await scheduledReady;
    return scheduledHandlers.runNow(input);
  });
  channels.scheduledCancel.provider(async (input) => {
    await scheduledReady;
    return scheduledHandlers.cancel(input);
  });
  channels.scheduledAudit.provider(async (input) => {
    await scheduledReady;
    return scheduledHandlers.listAudit(input);
  });
  channels.queryTelemetry.provider(async (query) =>
    (await telemetrySink.query({ ...query, limit: normalizeTelemetryLimit(query.limit) })).map(
      toPublicCoreTelemetryEvent
    )
  );
  channels.doctor.provider(async ({ limit }) => {
    try {
      const [targets, events] = await Promise.all([
        detectTargets(),
        telemetrySink.query({ limit: normalizeTelemetryLimit(limit) }),
      ]);
      return buildCoreDoctorReport({ targets, adapters, telemetry: events });
    } catch {
      return {
        generatedAt: Date.now(),
        status: 'unhealthy',
        checks: [
          {
            id: 'doctor-unavailable',
            status: 'error',
            summary: 'Core diagnostics could not inspect the local runtime.',
          },
        ],
        metrics: {
          runCount: 0,
          completionRate: 0,
          retryRate: 0,
          toolFailureRate: 0,
        },
      };
    }
  });
};

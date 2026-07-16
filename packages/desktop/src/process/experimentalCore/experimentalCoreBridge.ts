/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { bridge } from '@office-ai/platform';
import { app } from 'electron';
import path from 'node:path';
import { createCompanyCoreRunner } from '@process/agentRuntime/companyCoreRunner';
import {
  ExperimentalCoreRuntime,
  type ExperimentalCoreEvent,
  type ExperimentalCoreTarget,
} from './experimentalCoreRuntime';
import { JsonCoreSessionStore, type CoreSessionCheckpoint } from './sessionCheckpointStore';

export const EXPERIMENTAL_CORE_CHANNELS = {
  listTargets: 'experimental-core.list-targets',
  listModels: 'experimental-core.list-models',
  listSessions: 'experimental-core.list-sessions',
  forkSession: 'experimental-core.fork-session',
  start: 'experimental-core.start',
  cancel: 'experimental-core.cancel',
  resolvePermission: 'experimental-core.resolve-permission',
  event: 'experimental-core.event',
} as const;

const channels = {
  listTargets: bridge.buildProvider<ExperimentalCoreTarget[], void>(EXPERIMENTAL_CORE_CHANNELS.listTargets),
  listModels: bridge.buildProvider<ExperimentalCoreTarget['models'], { targetId: string; workspace: string }>(
    EXPERIMENTAL_CORE_CHANNELS.listModels
  ),
  listSessions: bridge.buildProvider<CoreSessionCheckpoint[], void>(EXPERIMENTAL_CORE_CHANNELS.listSessions),
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
      permissionMode?: 'read-only' | 'workspace-write' | 'full-access';
    }
  >(EXPERIMENTAL_CORE_CHANNELS.start),
  cancel: bridge.buildProvider<boolean, { requestId: string }>(EXPERIMENTAL_CORE_CHANNELS.cancel),
  resolvePermission: bridge.buildProvider<boolean, { permissionId: string; approved: boolean }>(
    EXPERIMENTAL_CORE_CHANNELS.resolvePermission
  ),
  event: bridge.buildEmitter<ExperimentalCoreEvent>(EXPERIMENTAL_CORE_CHANNELS.event),
};

let registered = false;

/** Register the temporary parallel-core IPC surface. */
export const registerExperimentalCoreBridge = (): void => {
  if (registered) return;
  registered = true;
  const sessionStore = new JsonCoreSessionStore(
    path.join(app.getPath('userData'), 'tomny-core', 'session-checkpoints.json')
  );
  const runtime = new ExperimentalCoreRuntime((event) => channels.event.emit(event), {
    sessionStore,
    companyRunner: createCompanyCoreRunner(),
  });
  channels.listTargets.provider(() => runtime.listTargets());
  channels.listModels.provider(({ targetId, workspace }) => runtime.listModels(targetId, workspace));
  channels.listSessions.provider(() => runtime.listSessions());
  channels.forkSession.provider(({ sessionId }) => runtime.forkSession(sessionId));
  channels.start.provider(
    ({ requestId, sessionId, targetId, prompt, workspace, modelKey, companyId, permissionMode }) =>
      Promise.resolve(
        runtime.start(requestId, targetId, prompt, workspace, modelKey, permissionMode, sessionId, companyId)
      )
  );
  channels.cancel.provider(({ requestId }) => runtime.cancel(requestId));
  channels.resolvePermission.provider(({ permissionId, approved }) =>
    Promise.resolve(runtime.resolvePermission(permissionId, approved))
  );
};

/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Renderer-safe client for cloud-authoritative IDE workspace IPC channels. */

import { bridge } from '@office-ai/platform';
import type {
  CloudWorkspaceConnectRequest,
  CloudWorkspaceEditRequest,
  CloudWorkspaceEventEnvelope,
  CloudWorkspaceFileRequest,
  CloudWorkspaceClaimRequest,
  CloudWorkspacePublishProgress,
  CloudWorkspacePullProgress,
  CloudWorkspacePullRequest,
  CloudWorkspacePublishRequest,
  CloudWorkspaceReleaseRequest,
  CloudWorkspaceResult,
  CloudWorkspaceSessionData,
  CloudWorkspaceStatusRequest,
  CloudWorkspaceStatusData,
  CloudWorkspaceTreeRequest,
  CloudWorkspaceWriteRequest,
} from '@process/ide/teamEdit/cloud/cloudWorkspaceBridge';
import type { CloudWorkspaceLeaseClaimResult, CloudWorkspaceOperation } from '@/common/adapter/cloudWorkspaceMapper';
import type { TeamTreeEntry } from '@process/ide/teamEdit/teamSessionHost';
import type { ReplicaConflictResolution, ReplicaSyncStatus } from '@process/ide/teamEdit/cloud/cloudReplicaTypes';

const CLOUD_WORKSPACE_CHANNELS = {
  connect: 'ide.cloud-workspace-connect',
  disconnect: 'ide.cloud-workspace-disconnect',
  status: 'ide.cloud-workspace-status',
  tree: 'ide.cloud-workspace-tree',
  file: 'ide.cloud-workspace-file',
  write: 'ide.cloud-workspace-write',
  edit: 'ide.cloud-workspace-edit',
  claim: 'ide.cloud-workspace-claim',
  release: 'ide.cloud-workspace-release',
  publish: 'ide.cloud-workspace-publish',
  publishStatus: 'ide.cloud-workspace-publish-status',
  pull: 'ide.cloud-workspace-pull',
  pullStatus: 'ide.cloud-workspace-pull-status',
  replicaSync: 'ide.cloud-workspace-replica-sync',
  replicaResolve: 'ide.cloud-workspace-replica-resolve',
  event: 'ide.cloud-workspace-event',
} as const;

const OP_TIMEOUT_MS = 60000;
const PUBLISH_START_TIMEOUT_MS = 60000;
const PUBLISH_STATUS_TIMEOUT_MS = 15000;

const channels = {
  connect: bridge.buildProvider<CloudWorkspaceResult<CloudWorkspaceSessionData>, CloudWorkspaceConnectRequest>(
    CLOUD_WORKSPACE_CHANNELS.connect
  ),
  disconnect: bridge.buildProvider<CloudWorkspaceResult<boolean>, { workspaceId: string }>(
    CLOUD_WORKSPACE_CHANNELS.disconnect
  ),
  status: bridge.buildProvider<CloudWorkspaceResult<CloudWorkspaceStatusData>, CloudWorkspaceStatusRequest>(
    CLOUD_WORKSPACE_CHANNELS.status
  ),
  tree: bridge.buildProvider<CloudWorkspaceResult<TeamTreeEntry[]>, CloudWorkspaceTreeRequest>(
    CLOUD_WORKSPACE_CHANNELS.tree
  ),
  file: bridge.buildProvider<CloudWorkspaceResult<{ relPath: string; content: string }>, CloudWorkspaceFileRequest>(
    CLOUD_WORKSPACE_CHANNELS.file
  ),
  write: bridge.buildProvider<CloudWorkspaceResult<CloudWorkspaceOperation>, CloudWorkspaceWriteRequest>(
    CLOUD_WORKSPACE_CHANNELS.write
  ),
  edit: bridge.buildProvider<CloudWorkspaceResult<CloudWorkspaceOperation>, CloudWorkspaceEditRequest>(
    CLOUD_WORKSPACE_CHANNELS.edit
  ),
  claim: bridge.buildProvider<CloudWorkspaceResult<CloudWorkspaceLeaseClaimResult>, CloudWorkspaceClaimRequest>(
    CLOUD_WORKSPACE_CHANNELS.claim
  ),
  release: bridge.buildProvider<CloudWorkspaceResult<boolean>, CloudWorkspaceReleaseRequest>(
    CLOUD_WORKSPACE_CHANNELS.release
  ),
  publish: bridge.buildProvider<CloudWorkspaceResult<CloudWorkspacePublishProgress>, CloudWorkspacePublishRequest>(
    CLOUD_WORKSPACE_CHANNELS.publish
  ),
  publishStatus: bridge.buildProvider<CloudWorkspaceResult<CloudWorkspacePublishProgress>, { workspaceId: string }>(
    CLOUD_WORKSPACE_CHANNELS.publishStatus
  ),
  pull: bridge.buildProvider<CloudWorkspaceResult<CloudWorkspacePullProgress>, CloudWorkspacePullRequest>(
    CLOUD_WORKSPACE_CHANNELS.pull
  ),
  pullStatus: bridge.buildProvider<CloudWorkspaceResult<CloudWorkspacePullProgress>, { workspaceId: string }>(
    CLOUD_WORKSPACE_CHANNELS.pullStatus
  ),
  replicaSync: bridge.buildProvider<CloudWorkspaceResult<ReplicaSyncStatus>, { workspaceId: string }>(
    CLOUD_WORKSPACE_CHANNELS.replicaSync
  ),
  replicaResolve: bridge.buildProvider<
    CloudWorkspaceResult<ReplicaSyncStatus>,
    { workspaceId: string; conflictId: string; resolution: ReplicaConflictResolution; mergedContent?: string }
  >(CLOUD_WORKSPACE_CHANNELS.replicaResolve),
  event: bridge.buildEmitter<CloudWorkspaceEventEnvelope>(CLOUD_WORKSPACE_CHANNELS.event),
};

class CloudWorkspaceTimeoutError extends Error {
  constructor(channel: string, timeoutMs: number) {
    super(`[cloudWorkspaceClient] No reply on "${channel}" after ${Math.round(timeoutMs / 1000)}s.`);
    this.name = 'CloudWorkspaceTimeoutError';
  }
}

const withTimeout = <T>(channel: string, call: () => Promise<T>, timeoutMs = OP_TIMEOUT_MS): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new CloudWorkspaceTimeoutError(channel, timeoutMs));
    }, timeoutMs);
    call().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    );
  });

export const cloudWorkspaceClient = {
  connect: (req: CloudWorkspaceConnectRequest): Promise<CloudWorkspaceResult<CloudWorkspaceSessionData>> =>
    withTimeout(CLOUD_WORKSPACE_CHANNELS.connect, () => channels.connect.invoke(req)),
  disconnect: (workspaceId: string): Promise<CloudWorkspaceResult<boolean>> =>
    withTimeout(CLOUD_WORKSPACE_CHANNELS.disconnect, () => channels.disconnect.invoke({ workspaceId }), 15000),
  status: (workspaceId?: string): Promise<CloudWorkspaceResult<CloudWorkspaceStatusData>> =>
    withTimeout(CLOUD_WORKSPACE_CHANNELS.status, () => channels.status.invoke({ workspaceId }), 15000),
  tree: (workspaceId: string, dir: string): Promise<CloudWorkspaceResult<TeamTreeEntry[]>> =>
    withTimeout(CLOUD_WORKSPACE_CHANNELS.tree, () => channels.tree.invoke({ workspaceId, dir }), 15000),
  file: (workspaceId: string, relPath: string): Promise<CloudWorkspaceResult<{ relPath: string; content: string }>> =>
    withTimeout(CLOUD_WORKSPACE_CHANNELS.file, () => channels.file.invoke({ workspaceId, relPath }), 20000),
  write: (workspaceId: string, relPath: string, data: string): Promise<CloudWorkspaceResult<CloudWorkspaceOperation>> =>
    withTimeout(CLOUD_WORKSPACE_CHANNELS.write, () => channels.write.invoke({ workspaceId, relPath, data }), 20000),
  edit: (
    workspaceId: string,
    relPath: string,
    oldText: string,
    newText: string
  ): Promise<CloudWorkspaceResult<CloudWorkspaceOperation>> =>
    withTimeout(
      CLOUD_WORKSPACE_CHANNELS.edit,
      () => channels.edit.invoke({ workspaceId, relPath, oldText, newText }),
      20000
    ),
  claim: (
    workspaceId: string,
    relPath: string,
    intent?: string
  ): Promise<CloudWorkspaceResult<CloudWorkspaceLeaseClaimResult>> =>
    withTimeout(CLOUD_WORKSPACE_CHANNELS.claim, () => channels.claim.invoke({ workspaceId, relPath, intent }), 10000),
  release: (workspaceId: string, relPath: string): Promise<CloudWorkspaceResult<boolean>> =>
    withTimeout(CLOUD_WORKSPACE_CHANNELS.release, () => channels.release.invoke({ workspaceId, relPath }), 10000),
  publish: (workspaceId: string, rootPath: string): Promise<CloudWorkspaceResult<CloudWorkspacePublishProgress>> =>
    withTimeout(
      CLOUD_WORKSPACE_CHANNELS.status,
      async () => {
        const res = await channels.status.invoke({ workspaceId, publishRootPath: rootPath });
        if (res.ok === false) return res;
        return {
          ok: true,
          data: res.data.publishProgress ?? {
            uploaded: 0,
            skipped: 0,
            failed: 1,
            totalBytes: 0,
            errors: [{ path: '.', error: 'Publish did not start.' }],
            running: false,
            done: true,
            totalDiscovered: 0,
          },
        };
      },
      PUBLISH_START_TIMEOUT_MS
    ),
  publishStatus: (workspaceId: string): Promise<CloudWorkspaceResult<CloudWorkspacePublishProgress>> =>
    withTimeout(
      CLOUD_WORKSPACE_CHANNELS.publishStatus,
      () => channels.publishStatus.invoke({ workspaceId }),
      PUBLISH_STATUS_TIMEOUT_MS
    ),
  pull: (workspaceId: string, rootPath: string): Promise<CloudWorkspaceResult<CloudWorkspacePullProgress>> =>
    withTimeout(CLOUD_WORKSPACE_CHANNELS.pull, () => channels.pull.invoke({ workspaceId, rootPath }), 20000),
  pullStatus: (workspaceId: string): Promise<CloudWorkspaceResult<CloudWorkspacePullProgress>> =>
    withTimeout(CLOUD_WORKSPACE_CHANNELS.pullStatus, () => channels.pullStatus.invoke({ workspaceId }), 15000),
  replicaSync: (workspaceId: string): Promise<CloudWorkspaceResult<ReplicaSyncStatus>> =>
    withTimeout(CLOUD_WORKSPACE_CHANNELS.replicaSync, () => channels.replicaSync.invoke({ workspaceId }), 120000),
  replicaResolve: (
    workspaceId: string,
    conflictId: string,
    resolution: ReplicaConflictResolution,
    mergedContent?: string
  ): Promise<CloudWorkspaceResult<ReplicaSyncStatus>> =>
    withTimeout(
      CLOUD_WORKSPACE_CHANNELS.replicaResolve,
      () => channels.replicaResolve.invoke({ workspaceId, conflictId, resolution, mergedContent }),
      120000
    ),

  onEvent: (listener: (event: CloudWorkspaceEventEnvelope['event']) => void): (() => void) =>
    channels.event.on((envelope) => listener(envelope.event)),
};

export type {
  CloudWorkspacePublishProgress,
  CloudWorkspacePullProgress,
  CloudWorkspaceSessionData,
  CloudWorkspaceStatusData,
} from '@process/ide/teamEdit/cloud/cloudWorkspaceBridge';

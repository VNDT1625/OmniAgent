/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Renderer-safe client for cloud-authoritative IDE workspace IPC channels. */

import { bridge } from '@office-ai/platform';
import type {
  CloudWorkspaceConnectRequest,
  CloudWorkspaceEditRequest,
  CloudWorkspaceFileRequest,
  CloudWorkspaceResult,
  CloudWorkspaceSessionData,
  CloudWorkspaceStatusData,
  CloudWorkspaceTreeRequest,
  CloudWorkspaceWriteRequest,
} from '@process/ide/teamEdit/cloud/cloudWorkspaceBridge';
import type { CloudWorkspaceOperation } from '@/common/adapter/cloudWorkspaceMapper';
import type { TeamTreeEntry } from '@process/ide/teamEdit/teamSessionHost';

const CLOUD_WORKSPACE_CHANNELS = {
  connect: 'ide.cloud-workspace-connect',
  disconnect: 'ide.cloud-workspace-disconnect',
  status: 'ide.cloud-workspace-status',
  tree: 'ide.cloud-workspace-tree',
  file: 'ide.cloud-workspace-file',
  write: 'ide.cloud-workspace-write',
  edit: 'ide.cloud-workspace-edit',
} as const;

const OP_TIMEOUT_MS = 60000;

const channels = {
  connect: bridge.buildProvider<CloudWorkspaceResult<CloudWorkspaceSessionData>, CloudWorkspaceConnectRequest>(
    CLOUD_WORKSPACE_CHANNELS.connect
  ),
  disconnect: bridge.buildProvider<CloudWorkspaceResult<boolean>, { workspaceId: string }>(
    CLOUD_WORKSPACE_CHANNELS.disconnect
  ),
  status: bridge.buildProvider<CloudWorkspaceResult<CloudWorkspaceStatusData>, { workspaceId?: string }>(
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
};

export type {
  CloudWorkspaceSessionData,
  CloudWorkspaceStatusData,
} from '@process/ide/teamEdit/cloud/cloudWorkspaceBridge';

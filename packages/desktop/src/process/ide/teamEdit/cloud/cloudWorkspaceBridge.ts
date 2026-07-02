/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Renderer-facing IPC bridge for cloud-authoritative IDE workspaces. */

import { randomUUID } from 'node:crypto';
import { bridge } from '@office-ai/platform';
import type {
  CloudWorkspaceManifest,
  CloudWorkspaceRelayConfig,
  CloudWorkspaceSyncState,
} from '@/common/adapter/cloudWorkspaceMapper';
import {
  normalizeCloudPath,
  normalizeRelayBaseUrl,
  type CloudWorkspaceOperation,
} from '@/common/adapter/cloudWorkspaceMapper';
import type { ISessionMcpServer } from '@/common/config/storage';
import { createCloudWorkspaceFileAdapter, createCloudWorkspaceRelayClient } from './cloudWorkspaceRelay';
import { clearRemoteIdeMcpSession, ensureCloudIdeMcpRegistered, type RemoteIdeMcpBackend } from '../remoteIdeMcp';
import type { TeamTreeEntry } from '../teamSessionHost';

export const CLOUD_WORKSPACE_CHANNELS = {
  connect: 'ide.cloud-workspace-connect',
  disconnect: 'ide.cloud-workspace-disconnect',
  status: 'ide.cloud-workspace-status',
  tree: 'ide.cloud-workspace-tree',
  file: 'ide.cloud-workspace-file',
  write: 'ide.cloud-workspace-write',
  edit: 'ide.cloud-workspace-edit',
} as const;

export type CloudWorkspaceResult<T> = { ok: true; data: T } | { ok: false; error: string };

export type CloudWorkspaceConnectRequest = {
  relayBaseUrl: string;
  workspaceId: string;
  token: string;
  displayName?: string;
};

export type CloudWorkspaceSessionData = {
  config: CloudWorkspaceRelayConfig;
  manifest: CloudWorkspaceManifest;
  state: CloudWorkspaceSyncState;
  workspacePath: string;
  remoteMcpServer: ISessionMcpServer;
};

export type CloudWorkspaceStatusData = {
  connected: boolean;
  config?: CloudWorkspaceRelayConfig;
  manifest?: CloudWorkspaceManifest;
  state?: CloudWorkspaceSyncState;
  workspacePath?: string;
  remoteMcpServer?: ISessionMcpServer;
};

export type CloudWorkspaceTreeRequest = { workspaceId: string; dir: string };
export type CloudWorkspaceFileRequest = { workspaceId: string; relPath: string };
export type CloudWorkspaceWriteRequest = { workspaceId: string; relPath: string; data: string };
export type CloudWorkspaceEditRequest = {
  workspaceId: string;
  relPath: string;
  oldText: string;
  newText: string;
};

type ActiveCloudWorkspace = CloudWorkspaceSessionData & {
  relay: ReturnType<typeof createCloudWorkspaceRelayClient>;
  adapter: ReturnType<typeof createCloudWorkspaceFileAdapter>;
};

export const cloudWorkspaceChannels = {
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

const sessions = new Map<string, ActiveCloudWorkspace>();

const toError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const requireSession = (workspaceId: string): ActiveCloudWorkspace => {
  const session = sessions.get(workspaceId);
  if (!session) throw new Error(`Cloud workspace is not connected: ${workspaceId}.`);
  return session;
};

const createMcpBackend = (
  relay: ReturnType<typeof createCloudWorkspaceRelayClient>,
  adapter: ReturnType<typeof createCloudWorkspaceFileAdapter>
): RemoteIdeMcpBackend => ({
  listDir: async (dir) => adapter.listDir(dir).map((entry) => ({ name: entry.name, isDir: entry.isDir })),
  readFile: (relPath) => adapter.readFile(relPath),
  writeFile: async (relPath, content) => {
    const op = await adapter.writeFile(relPath, content);
    return `Wrote ${normalizeCloudPath(relPath)} to cloud workspace at seq ${op.seq ?? relay.getState().lastAppliedSeq}.`;
  },
  editFile: async (relPath, oldText, newText) => {
    const op = await adapter.editFile(relPath, oldText, newText);
    return `Edited ${normalizeCloudPath(relPath)} in cloud workspace at seq ${op.seq ?? relay.getState().lastAppliedSeq}.`;
  },
  status: async () =>
    JSON.stringify(
      {
        state: relay.getState(),
        manifest: relay.getManifest(),
      },
      null,
      2
    ),
});

const normalizeConnectRequest = (req: CloudWorkspaceConnectRequest): CloudWorkspaceRelayConfig => {
  const workspaceId = req.workspaceId.trim();
  const token = req.token.trim();
  if (!workspaceId) throw new Error('workspaceId is required.');
  if (!token) throw new Error('token is required.');
  return {
    relayBaseUrl: normalizeRelayBaseUrl(req.relayBaseUrl),
    workspaceId,
    token,
    clientId: randomUUID(),
    displayName: req.displayName?.trim() || 'AionUi',
  };
};

export function registerCloudWorkspaceBridge(): void {
  cloudWorkspaceChannels.connect.provider(async (req): Promise<CloudWorkspaceResult<CloudWorkspaceSessionData>> => {
    try {
      const config = normalizeConnectRequest(req);
      const existing = sessions.get(config.workspaceId);
      if (existing) {
        existing.relay.close();
        clearRemoteIdeMcpSession(existing.config.relayBaseUrl, existing.config.token);
      }
      const relay = createCloudWorkspaceRelayClient(config);
      const adapter = createCloudWorkspaceFileAdapter(relay);
      const manifest = await relay.fetchManifest();
      await relay.connect();
      const remoteIde = await ensureCloudIdeMcpRegistered({
        kind: 'cloud',
        baseUrl: config.relayBaseUrl,
        token: config.token,
        repoName: config.workspaceId,
        backend: createMcpBackend(relay, adapter),
      });
      const data: CloudWorkspaceSessionData = {
        config,
        manifest,
        state: relay.getState(),
        workspacePath: remoteIde.workspacePath,
        remoteMcpServer: remoteIde.server,
      };
      sessions.set(config.workspaceId, { ...data, relay, adapter });
      return { ok: true, data };
    } catch (error) {
      return { ok: false, error: toError(error) };
    }
  });

  cloudWorkspaceChannels.disconnect.provider(async (req): Promise<CloudWorkspaceResult<boolean>> => {
    try {
      const session = sessions.get(req.workspaceId);
      if (session) {
        session.relay.close();
        clearRemoteIdeMcpSession(session.config.relayBaseUrl, session.config.token);
        sessions.delete(req.workspaceId);
      }
      return { ok: true, data: true };
    } catch (error) {
      return { ok: false, error: toError(error) };
    }
  });

  cloudWorkspaceChannels.status.provider(async (req): Promise<CloudWorkspaceResult<CloudWorkspaceStatusData>> => {
    try {
      const session = req.workspaceId ? sessions.get(req.workspaceId) : sessions.values().next().value;
      if (!session) return { ok: true, data: { connected: false } };
      return {
        ok: true,
        data: {
          connected: true,
          config: session.config,
          manifest: session.relay.getManifest() ?? session.manifest,
          state: session.relay.getState(),
          workspacePath: session.workspacePath,
          remoteMcpServer: session.remoteMcpServer,
        },
      };
    } catch (error) {
      return { ok: false, error: toError(error) };
    }
  });

  cloudWorkspaceChannels.tree.provider(async (req): Promise<CloudWorkspaceResult<TeamTreeEntry[]>> => {
    try {
      const session = requireSession(req.workspaceId);
      return {
        ok: true,
        data: session.adapter.listDir(req.dir).map((entry) => ({ name: entry.name, isDir: entry.isDir })),
      };
    } catch (error) {
      return { ok: false, error: toError(error) };
    }
  });

  cloudWorkspaceChannels.file.provider(
    async (req): Promise<CloudWorkspaceResult<{ relPath: string; content: string }>> => {
      try {
        const session = requireSession(req.workspaceId);
        const relPath = normalizeCloudPath(req.relPath);
        return { ok: true, data: { relPath, content: await session.adapter.readFile(relPath) } };
      } catch (error) {
        return { ok: false, error: toError(error) };
      }
    }
  );

  cloudWorkspaceChannels.write.provider(async (req): Promise<CloudWorkspaceResult<CloudWorkspaceOperation>> => {
    try {
      const session = requireSession(req.workspaceId);
      return { ok: true, data: await session.adapter.writeFile(req.relPath, req.data) };
    } catch (error) {
      return { ok: false, error: toError(error) };
    }
  });

  cloudWorkspaceChannels.edit.provider(async (req): Promise<CloudWorkspaceResult<CloudWorkspaceOperation>> => {
    try {
      const session = requireSession(req.workspaceId);
      return { ok: true, data: await session.adapter.editFile(req.relPath, req.oldText, req.newText) };
    } catch (error) {
      return { ok: false, error: toError(error) };
    }
  });

  console.log('[cloudWorkspaceBridge] registered channels:', Object.values(CLOUD_WORKSPACE_CHANNELS).join(', '));
}

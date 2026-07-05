/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Renderer-facing IPC bridge for cloud-authoritative IDE workspaces. */

import { randomUUID } from 'node:crypto';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { bridge } from '@office-ai/platform';
import type {
  CloudWorkspaceManifest,
  CloudWorkspaceRelayConfig,
  CloudWorkspaceSyncState,
} from '@/common/adapter/cloudWorkspaceMapper';
import {
  type CloudWorkspaceFileLease,
  type CloudWorkspaceLeaseClaimResult,
  normalizeCloudPath,
  normalizeRelayBaseUrl,
  type CloudWorkspaceOperation,
} from '@/common/adapter/cloudWorkspaceMapper';
import type { ISessionMcpServer } from '@/common/config/storage';
import { createCloudWorkspaceFileAdapter, createCloudWorkspaceRelayClient } from './cloudWorkspaceRelay';
import { clearRemoteIdeMcpSession, ensureCloudIdeMcpRegistered, type RemoteIdeMcpBackend } from '../remoteIdeMcp';
import { resolveWithinRepo, type TeamTreeEntry } from '../teamSessionHost';

export const CLOUD_WORKSPACE_CHANNELS = {
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
  event: 'ide.cloud-workspace-event',
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
  cachePath: string;
  remoteMcpServer: ISessionMcpServer;
};

export type CloudWorkspaceStatusData = {
  connected: boolean;
  config?: CloudWorkspaceRelayConfig;
  manifest?: CloudWorkspaceManifest;
  state?: CloudWorkspaceSyncState;
  workspacePath?: string;
  cachePath?: string;
  remoteMcpServer?: ISessionMcpServer;
  publishProgress?: CloudWorkspacePublishProgress;
};
export type CloudWorkspaceStatusRequest = { workspaceId?: string; publishRootPath?: string };

export type CloudWorkspaceTreeRequest = { workspaceId: string; dir: string };
export type CloudWorkspaceFileRequest = { workspaceId: string; relPath: string };
export type CloudWorkspaceWriteRequest = { workspaceId: string; relPath: string; data: string };
export type CloudWorkspaceEditRequest = {
  workspaceId: string;
  relPath: string;
  oldText: string;
  newText: string;
};
export type CloudWorkspaceClaimRequest = { workspaceId: string; relPath: string; intent?: string };
export type CloudWorkspaceReleaseRequest = { workspaceId: string; relPath: string };
export type CloudWorkspacePublishRequest = { workspaceId: string; rootPath: string };
export type CloudWorkspacePullRequest = { workspaceId: string; rootPath: string };
export type CloudWorkspacePublishResult = {
  uploaded: number;
  skipped: number;
  failed: number;
  totalBytes: number;
  errors: Array<{ path: string; error: string }>;
};
export type CloudWorkspacePublishProgress = CloudWorkspacePublishResult & {
  running: boolean;
  done: boolean;
  totalDiscovered: number;
  currentPath?: string;
  startedAt?: number;
  finishedAt?: number;
};
export type CloudWorkspacePullProgress = CloudWorkspacePublishProgress;
export type CloudWorkspaceEvent =
  | {
      kind: 'state';
      workspaceId: string;
      state: CloudWorkspaceSyncState;
      manifest?: CloudWorkspaceManifest;
    }
  | {
      kind: 'operation';
      workspaceId: string;
      operation: CloudWorkspaceOperation;
      manifest: CloudWorkspaceManifest;
    }
  | {
      kind: 'leases';
      workspaceId: string;
      leases: CloudWorkspaceFileLease[];
    }
  | {
      kind: 'error';
      workspaceId: string;
      error: string;
    };
export type CloudWorkspaceEventEnvelope = { event: CloudWorkspaceEvent };

type ActiveCloudWorkspace = CloudWorkspaceSessionData & {
  relay: ReturnType<typeof createCloudWorkspaceRelayClient>;
  adapter: ReturnType<typeof createCloudWorkspaceFileAdapter>;
  cacheSeq?: number;
  syncingCache?: boolean;
};

export const cloudWorkspaceChannels = {
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
  event: bridge.buildEmitter<CloudWorkspaceEventEnvelope>(CLOUD_WORKSPACE_CHANNELS.event),
};

const sessions = new Map<string, ActiveCloudWorkspace>();

const toError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const requireSession = (workspaceId: string): ActiveCloudWorkspace => {
  const session = sessions.get(workspaceId);
  if (!session) throw new Error(`Cloud workspace is not connected: ${workspaceId}.`);
  return session;
};

const PUBLISH_EXCLUDED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'out',
  'build',
  '.next',
  '.nuxt',
  'coverage',
  '.cache',
  '.turbo',
  '.vite',
  'target',
]);
const PUBLISH_EXCLUDED_FILES = new Set(['.env', '.env.local', '.env.development', '.env.production', '.env.test']);
const PUBLISH_MAX_FILE_BYTES = 1024 * 1024;
const PUBLISH_MAX_FILES = 2000;
const publishJobs = new Map<string, CloudWorkspacePublishProgress>();
const pullJobs = new Map<string, CloudWorkspacePullProgress>();

const toPosixRel = (rootPath: string, absPath: string): string => {
  const rel = path.relative(rootPath, absPath).replace(/\\/g, '/');
  return normalizeCloudPath(rel);
};

const isExcludedPublishFile = (name: string): boolean => PUBLISH_EXCLUDED_FILES.has(name) || name.startsWith('.env.');

export const isCloudWorkspaceBinaryBuffer = (content: Buffer): boolean => {
  const sample = content.subarray(0, Math.min(content.length, 8000));
  return sample.includes(0);
};

export const collectCloudWorkspacePublishFiles = async (rootPath: string): Promise<string[]> => {
  const root = path.resolve(rootPath);
  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    if (files.length >= PUBLISH_MAX_FILES) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (files.length >= PUBLISH_MAX_FILES) return;
      if (entry.isDirectory() && PUBLISH_EXCLUDED_DIRS.has(entry.name)) continue;
      if (entry.isFile() && isExcludedPublishFile(entry.name)) continue;
      const abs = resolveWithinRepo(root, path.relative(root, path.join(dir, entry.name)));
      if (entry.isDirectory()) {
        await visit(abs);
        continue;
      }
      if (entry.isFile()) files.push(abs);
    }
  };
  await visit(root);
  return files;
};

const createPublishProgress = (): CloudWorkspacePublishProgress => ({
  uploaded: 0,
  skipped: 0,
  failed: 0,
  totalBytes: 0,
  errors: [],
  running: true,
  done: false,
  totalDiscovered: 0,
  startedAt: Date.now(),
});

const publishLocalWorkspace = async (
  session: ActiveCloudWorkspace,
  rootPath: string,
  progress: CloudWorkspacePublishProgress
): Promise<CloudWorkspacePublishProgress> => {
  const workspaceId = session.config.workspaceId;
  publishJobs.set(workspaceId, progress);

  const visit = async (dir: string): Promise<void> => {
    if (progress.totalDiscovered >= PUBLISH_MAX_FILES) return;
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (progress.totalDiscovered >= PUBLISH_MAX_FILES) return;
      if (entry.isDirectory() && PUBLISH_EXCLUDED_DIRS.has(entry.name)) continue;
      if (entry.isFile() && isExcludedPublishFile(entry.name)) continue;
      const abs = resolveWithinRepo(rootPath, path.relative(rootPath, path.join(dir, entry.name)));
      if (entry.isDirectory()) {
        await visit(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      progress.totalDiscovered += 1;
      await publishOne(abs);
    }
  };

  const publishOne = async (absPath: string): Promise<void> => {
    const relPath = toPosixRel(rootPath, absPath);
    progress.currentPath = relPath;
    try {
      const stat = await fsp.stat(absPath);
      if (stat.size > PUBLISH_MAX_FILE_BYTES) {
        progress.skipped += 1;
        return;
      }
      const bytes = await fsp.readFile(absPath);
      if (isCloudWorkspaceBinaryBuffer(bytes)) {
        progress.skipped += 1;
        return;
      }
      const content = bytes.toString('utf-8');
      const hash = await session.relay.uploadBlob(content);
      await session.relay.appendOperation({
        id: randomUUID(),
        type: 'file.write',
        path: relPath,
        hash,
        size: content.length,
      });
      progress.uploaded += 1;
      progress.totalBytes += bytes.byteLength;
    } catch (error) {
      progress.failed += 1;
      if (progress.errors.length < 20) progress.errors.push({ path: relPath, error: toError(error) });
    }
  };

  try {
    await visit(rootPath);
  } finally {
    progress.running = false;
    progress.done = true;
    progress.currentPath = undefined;
    progress.finishedAt = Date.now();
  }

  return progress;
};

const startPublishLocalWorkspace = (session: ActiveCloudWorkspace, rootPath: string): CloudWorkspacePublishProgress => {
  const existing = publishJobs.get(session.config.workspaceId);
  if (existing?.running) return existing;
  const progress = createPublishProgress();
  publishJobs.set(session.config.workspaceId, progress);
  void publishLocalWorkspace(session, rootPath, progress).catch((error) => {
    const current = publishJobs.get(session.config.workspaceId) ?? progress;
    current.running = false;
    current.done = true;
    current.failed += 1;
    current.finishedAt = Date.now();
    if (current.errors.length < 20) current.errors.push({ path: '.', error: toError(error) });
    publishJobs.set(session.config.workspaceId, current);
  });
  return progress;
};

const pullCloudWorkspace = async (
  session: ActiveCloudWorkspace,
  rootPath: string,
  progress: CloudWorkspacePullProgress
): Promise<CloudWorkspacePullProgress> => {
  const workspaceId = session.config.workspaceId;
  pullJobs.set(workspaceId, progress);
  const manifest = session.relay.getManifest() ?? session.manifest;
  const files = Object.values(manifest.files)
    .filter((file) => !file.deleted)
    .map((file) => normalizeCloudPath(file.path))
    .toSorted((a, b) => a.localeCompare(b));
  progress.totalDiscovered = files.length;

  try {
    await fsp.mkdir(rootPath, { recursive: true });
    for (const relPath of files) {
      progress.currentPath = relPath;
      try {
        const content = await session.adapter.readFile(relPath);
        const abs = resolveWithinRepo(rootPath, relPath);
        // Sequential by design: pull should stay predictable and avoid relay bursts.
        // eslint-disable-next-line no-await-in-loop
        await fsp.mkdir(path.dirname(abs), { recursive: true });
        // eslint-disable-next-line no-await-in-loop
        await fsp.writeFile(abs, content, 'utf-8');
        progress.uploaded += 1;
        progress.totalBytes += Buffer.byteLength(content, 'utf-8');
      } catch (error) {
        progress.failed += 1;
        if (progress.errors.length < 20) progress.errors.push({ path: relPath, error: toError(error) });
      }
    }
  } finally {
    progress.running = false;
    progress.done = true;
    progress.currentPath = undefined;
    progress.finishedAt = Date.now();
    pullJobs.set(workspaceId, progress);
  }

  return progress;
};

const startPullCloudWorkspace = (session: ActiveCloudWorkspace, rootPath: string): CloudWorkspacePullProgress => {
  const existing = pullJobs.get(session.config.workspaceId);
  if (existing?.running) return existing;
  const progress = createPublishProgress();
  pullJobs.set(session.config.workspaceId, progress);
  void pullCloudWorkspace(session, rootPath, progress).catch((error) => {
    const current = pullJobs.get(session.config.workspaceId) ?? progress;
    current.running = false;
    current.done = true;
    current.failed += 1;
    current.finishedAt = Date.now();
    if (current.errors.length < 20) current.errors.push({ path: '.', error: toError(error) });
    pullJobs.set(session.config.workspaceId, current);
  });
  return progress;
};

const createMcpBackend = (
  relay: ReturnType<typeof createCloudWorkspaceRelayClient>,
  adapter: ReturnType<typeof createCloudWorkspaceFileAdapter>
): RemoteIdeMcpBackend => ({
  listDir: async (dir) => adapter.listDir(dir).map((entry) => ({ name: entry.name, isDir: entry.isDir })),
  listFiles: async () =>
    Object.values(relay.getManifest()?.files ?? {})
      .filter((file) => !file.deleted)
      .map((file) => normalizeCloudPath(file.path))
      .toSorted((a, b) => a.localeCompare(b)),
  readFile: (relPath) => adapter.readFile(relPath),
  writeFile: async (relPath, content) => {
    const op = await adapter.writeFile(relPath, content);
    return `Wrote ${normalizeCloudPath(relPath)} to cloud workspace at seq ${op.seq ?? relay.getState().lastAppliedSeq}.`;
  },
  editFile: async (relPath, oldText, newText) => {
    const op = await adapter.editFile(relPath, oldText, newText);
    return `Edited ${normalizeCloudPath(relPath)} in cloud workspace at seq ${op.seq ?? relay.getState().lastAppliedSeq}.`;
  },
  claimFile: async (relPath, intent) => {
    const pathValue = normalizeCloudPath(relPath);
    const claim = await adapter.claimFile(pathValue, intent);
    if (!claim.ok)
      return `Cannot claim ${pathValue}; held by ${claim.lease.name || claim.lease.clientId} until ${new Date(
        claim.lease.expiresAt
      ).toISOString()}.`;
    return `${claim.renewed ? 'Renewed' : 'Claimed'} ${pathValue} for ${claim.lease.name || claim.lease.clientId} until ${new Date(
      claim.lease.expiresAt
    ).toISOString()}.`;
  },
  releaseFile: async (relPath) => {
    const pathValue = normalizeCloudPath(relPath);
    const released = await adapter.releaseFile(pathValue);
    return released ? `Released ${pathValue}.` : `No cloud lease held by this client for ${pathValue}.`;
  },
  status: async () =>
    JSON.stringify(
      {
        state: relay.getState(),
        manifest: relay.getManifest(),
        leases: adapter.listLeases(),
      },
      null,
      2
    ),
});

const syncCloudCache = async (session: ActiveCloudWorkspace): Promise<void> => {
  if (session.syncingCache) return;
  const manifest = session.relay.getManifest() ?? session.manifest;
  if (session.cacheSeq === manifest.seq) return;
  session.syncingCache = true;
  try {
    await fsp.mkdir(session.cachePath, { recursive: true });
    await fsp.writeFile(
      path.join(session.cachePath, 'CLOUD_WORKSPACE.md'),
      [
        '# Cloud Workspace Cache',
        '',
        'This folder is a local materialized cache for IDE panels.',
        'The cloud relay is the source of truth. Editor saves are routed back through cloud leases.',
        '',
      ].join('\n'),
      'utf-8'
    );
    const previous = session.manifest;
    for (const file of Object.values(previous.files)) {
      if (!manifest.files[normalizeCloudPath(file.path)] || manifest.files[normalizeCloudPath(file.path)]?.deleted) {
        const abs = resolveWithinRepo(session.cachePath, file.path);
        // eslint-disable-next-line no-await-in-loop
        await fsp.rm(abs, { force: true }).catch((): undefined => undefined);
      }
    }
    const files = Object.values(manifest.files)
      .filter((file) => !file.deleted)
      .filter((file) => previous.files[normalizeCloudPath(file.path)]?.hash !== file.hash)
      .map((file) => normalizeCloudPath(file.path))
      .toSorted((a, b) => a.localeCompare(b));
    for (const relPath of files) {
      const abs = resolveWithinRepo(session.cachePath, relPath);
      // Sequential by design: sync should be steady and not fan out relay reads.
      // eslint-disable-next-line no-await-in-loop
      await fsp.mkdir(path.dirname(abs), { recursive: true });
      // eslint-disable-next-line no-await-in-loop
      const content = await session.adapter.readFile(relPath);
      // eslint-disable-next-line no-await-in-loop
      await fsp.writeFile(abs, content, 'utf-8');
    }
    session.manifest = manifest;
    session.cacheSeq = manifest.seq;
  } finally {
    session.syncingCache = false;
  }
};

const wireRelayEvents = (session: ActiveCloudWorkspace): void => {
  session.relay.on('state', (state) => {
    cloudWorkspaceChannels.event.emit({
      event: {
        kind: 'state',
        workspaceId: session.config.workspaceId,
        state,
        manifest: session.relay.getManifest() ?? session.manifest,
      },
    });
    if (state.leases.length > 0) {
      cloudWorkspaceChannels.event.emit({
        event: { kind: 'leases', workspaceId: session.config.workspaceId, leases: state.leases },
      });
    }
  });
  session.relay.on('operation', (operation, manifest) => {
    void syncCloudCache(session).catch((): undefined => undefined);
    cloudWorkspaceChannels.event.emit({
      event: { kind: 'operation', workspaceId: session.config.workspaceId, operation, manifest },
    });
  });
  session.relay.on('error', (error) => {
    cloudWorkspaceChannels.event.emit({
      event: { kind: 'error', workspaceId: session.config.workspaceId, error: toError(error) },
    });
  });
};

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
      const cachePath = path.join(remoteIde.workspacePath, 'mounted-worktree');
      const data: CloudWorkspaceSessionData = {
        config,
        manifest,
        state: relay.getState(),
        workspacePath: remoteIde.workspacePath,
        cachePath,
        remoteMcpServer: remoteIde.server,
      };
      const active: ActiveCloudWorkspace = { ...data, relay, adapter };
      wireRelayEvents(active);
      sessions.set(config.workspaceId, active);
      await syncCloudCache(active);
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
      let publishProgress: CloudWorkspacePublishProgress | undefined;
      if (req.publishRootPath) {
        const rootPath = path.resolve(req.publishRootPath);
        const stat = await fsp.stat(rootPath);
        if (!stat.isDirectory()) throw new Error(`Publish source is not a directory: ${rootPath}.`);
        publishProgress = startPublishLocalWorkspace(session, rootPath);
      }
      await session.relay.fetchStatus().catch((): null => null);
      await syncCloudCache(session).catch((): null => null);
      return {
        ok: true,
        data: {
          connected: true,
          config: session.config,
          manifest: session.relay.getManifest() ?? session.manifest,
          state: session.relay.getState(),
          workspacePath: session.workspacePath,
          cachePath: session.cachePath,
          remoteMcpServer: session.remoteMcpServer,
          publishProgress,
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

  cloudWorkspaceChannels.claim.provider(async (req): Promise<CloudWorkspaceResult<CloudWorkspaceLeaseClaimResult>> => {
    try {
      const session = requireSession(req.workspaceId);
      return { ok: true, data: await session.adapter.claimFile(req.relPath, req.intent) };
    } catch (error) {
      return { ok: false, error: toError(error) };
    }
  });

  cloudWorkspaceChannels.release.provider(async (req): Promise<CloudWorkspaceResult<boolean>> => {
    try {
      const session = requireSession(req.workspaceId);
      return { ok: true, data: await session.adapter.releaseFile(req.relPath) };
    } catch (error) {
      return { ok: false, error: toError(error) };
    }
  });

  cloudWorkspaceChannels.publish.provider(async (req): Promise<CloudWorkspaceResult<CloudWorkspacePublishProgress>> => {
    try {
      const session = requireSession(req.workspaceId);
      const rootPath = path.resolve(req.rootPath);
      const stat = await fsp.stat(rootPath);
      if (!stat.isDirectory()) throw new Error(`Publish source is not a directory: ${rootPath}.`);
      return { ok: true, data: startPublishLocalWorkspace(session, rootPath) };
    } catch (error) {
      return { ok: false, error: toError(error) };
    }
  });

  cloudWorkspaceChannels.publishStatus.provider(
    async (req): Promise<CloudWorkspaceResult<CloudWorkspacePublishProgress>> => {
      try {
        const current = publishJobs.get(req.workspaceId);
        return {
          ok: true,
          data: current ?? {
            uploaded: 0,
            skipped: 0,
            failed: 0,
            totalBytes: 0,
            errors: [],
            running: false,
            done: false,
            totalDiscovered: 0,
          },
        };
      } catch (error) {
        return { ok: false, error: toError(error) };
      }
    }
  );

  cloudWorkspaceChannels.pull.provider(async (req): Promise<CloudWorkspaceResult<CloudWorkspacePullProgress>> => {
    try {
      const session = requireSession(req.workspaceId);
      const rootPath = path.resolve(req.rootPath);
      await fsp.mkdir(rootPath, { recursive: true });
      const stat = await fsp.stat(rootPath);
      if (!stat.isDirectory()) throw new Error(`Pull target is not a directory: ${rootPath}.`);
      return { ok: true, data: startPullCloudWorkspace(session, rootPath) };
    } catch (error) {
      return { ok: false, error: toError(error) };
    }
  });

  cloudWorkspaceChannels.pullStatus.provider(async (req): Promise<CloudWorkspaceResult<CloudWorkspacePullProgress>> => {
    try {
      const current = pullJobs.get(req.workspaceId);
      return {
        ok: true,
        data: current ?? {
          uploaded: 0,
          skipped: 0,
          failed: 0,
          totalBytes: 0,
          errors: [],
          running: false,
          done: false,
          totalDiscovered: 0,
        },
      };
    } catch (error) {
      return { ok: false, error: toError(error) };
    }
  });

  console.log('[cloudWorkspaceBridge] registered channels:', Object.values(CLOUD_WORKSPACE_CHANNELS).join(', '));
}

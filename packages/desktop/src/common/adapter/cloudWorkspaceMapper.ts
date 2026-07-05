/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared protocol helpers for cloud-authoritative workspaces.
 *
 * The cloud relay is the source of truth. Clients keep a cache and apply an
 * ordered operation log from the relay. This file is pure TypeScript so Main,
 * Renderer, and tests can share the same manifest/reducer semantics.
 */

export type CloudWorkspaceConnectionState = 'idle' | 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'error';

export type CloudWorkspaceFileMeta = {
  path: string;
  hash: string;
  size: number;
  revision: number;
  updatedAt: number;
  deleted?: boolean;
};

export type CloudWorkspaceManifest = {
  workspaceId: string;
  seq: number;
  files: Record<string, CloudWorkspaceFileMeta>;
};

export type CloudWorkspaceSnapshot = {
  manifest: CloudWorkspaceManifest;
  blobs?: Record<string, string>;
};

export type CloudWorkspacePresence = {
  clientId: string;
  name: string;
  role: 'owner' | 'editor' | 'viewer' | 'agent';
  lastSeenAt: number;
};

export type CloudWorkspaceFileLease = {
  relPath: string;
  clientId: string;
  name?: string;
  intent?: string;
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
};

export type CloudWorkspaceLeaseClaimResult =
  | { ok: true; lease: CloudWorkspaceFileLease; renewed: boolean }
  | { ok: false; reason: 'held'; lease: CloudWorkspaceFileLease };

export type CloudWorkspaceRelayStatus = {
  manifest: CloudWorkspaceManifest;
  participants: CloudWorkspacePresence[];
  leases: CloudWorkspaceFileLease[];
};

export type CloudWorkspaceSyncState = {
  workspaceId: string;
  clientId: string;
  state: CloudWorkspaceConnectionState;
  lastAppliedSeq: number;
  pendingOps: number;
  participants: CloudWorkspacePresence[];
  leases: CloudWorkspaceFileLease[];
  error?: string;
};

export type CloudWorkspaceOperationBase = {
  id: string;
  workspaceId: string;
  clientId: string;
  seq?: number;
  baseSeq: number;
  createdAt: number;
};

export type CloudWorkspaceWriteOperation = CloudWorkspaceOperationBase & {
  type: 'file.write';
  path: string;
  hash: string;
  size: number;
};

export type CloudWorkspacePatchOperation = CloudWorkspaceOperationBase & {
  type: 'file.patch';
  path: string;
  oldText: string;
  newText: string;
  hash: string;
  size: number;
};

export type CloudWorkspaceRenameOperation = CloudWorkspaceOperationBase & {
  type: 'file.rename';
  fromPath: string;
  toPath: string;
};

export type CloudWorkspaceDeleteOperation = CloudWorkspaceOperationBase & {
  type: 'file.delete';
  path: string;
};

export type CloudWorkspaceOperation =
  | CloudWorkspaceWriteOperation
  | CloudWorkspacePatchOperation
  | CloudWorkspaceRenameOperation
  | CloudWorkspaceDeleteOperation;

export type CloudWorkspaceEnvelope =
  | {
      kind: 'hello';
      workspaceId: string;
      seq: number;
      manifestHash?: string;
      participants?: CloudWorkspacePresence[];
      leases?: CloudWorkspaceFileLease[];
    }
  | { kind: 'op'; op: CloudWorkspaceOperation }
  | { kind: 'presence'; participants: CloudWorkspacePresence[] }
  | { kind: 'leases'; leases: CloudWorkspaceFileLease[] }
  | { kind: 'ack'; opId: string; seq: number }
  | { kind: 'error'; message: string; retryable?: boolean };

export type CloudWorkspaceRelayConfig = {
  relayBaseUrl: string;
  workspaceId: string;
  token: string;
  clientId: string;
  displayName?: string;
};

export type CloudWorkspaceApplyOptions = {
  strictSeq?: boolean;
  now?: number;
};

export const normalizeCloudPath = (input: string): string => {
  const trimmed = input.trim().replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
  const parts = trimmed.split('/').filter((part) => part.length > 0 && part !== '.');
  if (parts.some((part) => part === '..')) throw new Error('Cloud workspace paths cannot contain parent segments.');
  return parts.join('/');
};

export const normalizeRelayBaseUrl = (input: string): string => {
  const trimmed = input.trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(trimmed)) throw new Error('Relay URL must start with http:// or https://.');
  return trimmed;
};

export const buildCloudWorkspaceUrls = (config: Pick<CloudWorkspaceRelayConfig, 'relayBaseUrl' | 'workspaceId'>) => {
  const base = normalizeRelayBaseUrl(config.relayBaseUrl);
  const workspaceId = encodeURIComponent(config.workspaceId);
  const httpBase = `${base}/v1/workspaces/${workspaceId}`;
  const wsBase = base.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
  return {
    workspace: httpBase,
    manifest: `${httpBase}/manifest`,
    status: `${httpBase}/status`,
    leases: `${httpBase}/leases`,
    opsSince: (seq: number): string => `${httpBase}/ops?since=${encodeURIComponent(String(seq))}`,
    appendOp: `${httpBase}/ops`,
    blob: (hash: string): string => `${httpBase}/blobs/${encodeURIComponent(hash)}`,
    file: (path: string): string => `${httpBase}/files/${encodeURIComponent(normalizeCloudPath(path))}`,
    connect: `${wsBase}/v1/workspaces/${workspaceId}/connect`,
    mcpSse: `${httpBase}/mcp/sse`,
  };
};

const cloneManifest = (manifest: CloudWorkspaceManifest): CloudWorkspaceManifest => ({
  workspaceId: manifest.workspaceId,
  seq: manifest.seq,
  files: Object.fromEntries(Object.entries(manifest.files).map(([key, value]) => [key, { ...value }])),
});

const requireSequenced = (
  manifest: CloudWorkspaceManifest,
  op: CloudWorkspaceOperation,
  strictSeq: boolean
): number => {
  const seq = op.seq;
  if (seq === undefined || !Number.isInteger(seq) || seq <= 0)
    throw new Error('Cloud operation must have a positive relay sequence before apply.');
  if (op.workspaceId !== manifest.workspaceId) throw new Error('Cloud operation belongs to a different workspace.');
  if (seq <= manifest.seq) return manifest.seq;
  if (strictSeq && seq !== manifest.seq + 1)
    throw new Error(`Cloud operation sequence gap: expected ${manifest.seq + 1}, got ${seq}.`);
  return seq;
};

export const applyCloudWorkspaceOperation = (
  manifest: CloudWorkspaceManifest,
  op: CloudWorkspaceOperation,
  options: CloudWorkspaceApplyOptions = {}
): CloudWorkspaceManifest => {
  const strictSeq = options.strictSeq ?? true;
  const nextSeq = requireSequenced(manifest, op, strictSeq);
  if (nextSeq === manifest.seq) return manifest;
  const next = cloneManifest(manifest);
  const updatedAt = options.now ?? op.createdAt;

  if (op.type === 'file.write' || op.type === 'file.patch') {
    const filePath = normalizeCloudPath(op.path);
    const previous = next.files[filePath];
    next.files[filePath] = {
      path: filePath,
      hash: op.hash,
      size: op.size,
      revision: (previous?.revision ?? 0) + 1,
      updatedAt,
    };
  } else if (op.type === 'file.rename') {
    const fromPath = normalizeCloudPath(op.fromPath);
    const toPath = normalizeCloudPath(op.toPath);
    const previous = next.files[fromPath];
    if (!previous) throw new Error(`Cannot rename missing file: ${fromPath}.`);
    delete next.files[fromPath];
    next.files[toPath] = { ...previous, path: toPath, revision: previous.revision + 1, updatedAt };
  } else {
    const filePath = normalizeCloudPath(op.path);
    const previous = next.files[filePath];
    if (previous) {
      next.files[filePath] = { ...previous, deleted: true, revision: previous.revision + 1, updatedAt };
    } else {
      next.files[filePath] = { path: filePath, hash: '', size: 0, revision: 1, updatedAt, deleted: true };
    }
  }

  next.seq = nextSeq;
  return next;
};

export const applyCloudWorkspaceOperations = (
  manifest: CloudWorkspaceManifest,
  ops: CloudWorkspaceOperation[],
  options: CloudWorkspaceApplyOptions = {}
): CloudWorkspaceManifest => ops.reduce((current, op) => applyCloudWorkspaceOperation(current, op, options), manifest);

export const listCloudWorkspaceDir = (
  manifest: CloudWorkspaceManifest,
  dir = ''
): Array<{ name: string; path: string; isDir: boolean }> => {
  const prefix = normalizeCloudPath(dir);
  const base = prefix ? `${prefix}/` : '';
  const entries = new Map<string, { name: string; path: string; isDir: boolean }>();
  for (const meta of Object.values(manifest.files)) {
    if (meta.deleted) continue;
    if (!meta.path.startsWith(base)) continue;
    const rest = meta.path.slice(base.length);
    if (rest.length === 0) continue;
    const [name, ...tail] = rest.split('/');
    const isDir = tail.length > 0;
    entries.set(name, { name, path: base + name, isDir });
  }
  return [...entries.values()].toSorted((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
};

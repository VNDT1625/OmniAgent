/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Durable local replica for a cloud workspace.
 *
 * The working tree is always usable. While offline, disk is the journal. On
 * reconnect we compare the persisted base hashes with local and remote state,
 * then apply one-sided changes or perform a deterministic three-way merge.
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs, watch, type FSWatcher } from 'node:fs';
import * as path from 'node:path';
import type { CloudWorkspaceManifest, CloudWorkspaceOperation } from '@/common/adapter/cloudWorkspaceMapper';
import { normalizeCloudPath } from '@/common/adapter/cloudWorkspaceMapper';
import type { CloudWorkspaceRelayClient } from './cloudWorkspaceRelay';
import { mergeText3 } from './cloudReplicaMerge';
import type {
  ReplicaConflict,
  ReplicaConflictResolution,
  ReplicaPersistedState,
  ReplicaSyncStatus,
} from './cloudReplicaTypes';

type LocalFile = {
  relPath: string;
  content: string;
  encoding: 'utf8' | 'base64';
  hash: string;
  size: number;
};

type CloudReplicaOptions = {
  workspaceId: string;
  rootPath: string;
  dataPath: string;
  relay: CloudWorkspaceRelayClient;
  onStatus?: (status: ReplicaSyncStatus) => void;
  scanIntervalMs?: number;
};

const EXCLUDED_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  '.aionui',
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
const EXCLUDED_FILES = new Set(['.env', '.env.local', '.env.development', '.env.production', '.env.test']);
const MAX_REPLICA_FILES = 20_000;
const MAX_RAW_FILE_BYTES = 18 * 1024 * 1024;
const DEFAULT_SCAN_INTERVAL_MS = 2_000;
const WATCH_DEBOUNCE_MS = 300;

const hashContent = (content: string): string => createHash('sha256').update(content, 'utf-8').digest('hex');
const isBinary = (bytes: Buffer): boolean => bytes.subarray(0, Math.min(bytes.length, 8_000)).includes(0);
const isExcludedFile = (name: string): boolean => EXCLUDED_FILES.has(name) || name.startsWith('.env.');

const encodeLocalFile = (relPath: string, bytes: Buffer): LocalFile => {
  const encoding = isBinary(bytes) ? 'base64' : 'utf8';
  const content = encoding === 'base64' ? bytes.toString('base64') : bytes.toString('utf-8');
  return { relPath, content, encoding, hash: hashContent(content), size: bytes.byteLength };
};

const emptyState = (workspaceId: string, rootPath: string): ReplicaPersistedState => ({
  schemaVersion: 1,
  workspaceId,
  rootPath,
  lastSyncedSeq: 0,
  files: {},
  conflicts: [],
  updatedAt: Date.now(),
});

const serializeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const atomicWrite = async (filePath: string, content: string | Buffer): Promise<void> => {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = `${filePath}.aionui-${randomUUID()}.tmp`;
  await fs.writeFile(temp, content);
  await fs.rename(temp, filePath);
};

const decodeContent = (content: string, encoding: 'utf8' | 'base64'): string | Buffer =>
  encoding === 'base64' ? Buffer.from(content, 'base64') : content;

const liveRemoteFiles = (manifest: CloudWorkspaceManifest) =>
  Object.fromEntries(Object.entries(manifest.files).filter(([, file]) => !file.deleted));

export const createCloudWorkspaceReplica = (options: CloudReplicaOptions) => {
  const rootPath = path.resolve(options.rootPath);
  const statePath = path.join(options.dataPath, 'replica-state.json');
  const scanIntervalMs = options.scanIntervalMs ?? DEFAULT_SCAN_INTERVAL_MS;
  let persisted = emptyState(options.workspaceId, rootPath);
  let status: ReplicaSyncStatus = {
    enabled: true,
    rootPath,
    state: 'idle',
    lastSyncedSeq: 0,
    pendingFiles: 0,
    conflicts: [],
  };
  let watcher: FSWatcher | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<ReplicaSyncStatus> | undefined;
  let stopped = false;

  const emitStatus = (patch: Partial<ReplicaSyncStatus>): ReplicaSyncStatus => {
    status = { ...status, ...patch, conflicts: persisted.conflicts };
    options.onStatus?.(status);
    return status;
  };

  const saveState = async (): Promise<void> => {
    persisted.updatedAt = Date.now();
    await atomicWrite(statePath, JSON.stringify(persisted, null, 2));
  };

  const loadState = async (): Promise<void> => {
    try {
      const parsed = JSON.parse(await fs.readFile(statePath, 'utf-8')) as ReplicaPersistedState;
      if (parsed.schemaVersion === 1 && parsed.workspaceId === options.workspaceId && parsed.rootPath === rootPath) {
        parsed.conflicts = parsed.conflicts.map((conflict) => ({
          ...conflict,
          localEncoding: conflict.localHash ? (conflict.localEncoding ?? 'utf8') : null,
          remoteEncoding: conflict.remoteHash ? (conflict.remoteEncoding ?? 'utf8') : null,
        }));
        persisted = parsed;
      }
    } catch {
      persisted = emptyState(options.workspaceId, rootPath);
    }
    emitStatus({
      lastSyncedSeq: persisted.lastSyncedSeq,
      conflicts: persisted.conflicts,
      state: persisted.conflicts.length > 0 ? 'conflict' : 'idle',
    });
  };

  const scanLocal = async (): Promise<Map<string, LocalFile>> => {
    const files = new Map<string, LocalFile>();
    const visit = async (dir: string): Promise<void> => {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (files.size >= MAX_REPLICA_FILES) throw new Error(`Replica exceeds ${MAX_REPLICA_FILES} files.`);
        if (entry.isDirectory() && EXCLUDED_DIRS.has(entry.name)) continue;
        if (entry.isFile() && isExcludedFile(entry.name)) continue;
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          // eslint-disable-next-line no-await-in-loop
          await visit(absolute);
          continue;
        }
        if (!entry.isFile()) continue;
        // eslint-disable-next-line no-await-in-loop
        const stat = await fs.stat(absolute);
        if (stat.size > MAX_RAW_FILE_BYTES) continue;
        // eslint-disable-next-line no-await-in-loop
        const bytes = await fs.readFile(absolute);
        const relPath = normalizeCloudPath(path.relative(rootPath, absolute));
        files.set(relPath, encodeLocalFile(relPath, bytes));
      }
    };
    await fs.mkdir(rootPath, { recursive: true });
    await visit(rootPath);
    return files;
  };

  const writeLocal = async (relPath: string, content: string, encoding: 'utf8' | 'base64'): Promise<void> => {
    const absolute = path.resolve(rootPath, normalizeCloudPath(relPath));
    if (absolute !== rootPath && !absolute.startsWith(`${rootPath}${path.sep}`))
      throw new Error(`Refusing to write outside replica: ${relPath}`);
    await atomicWrite(absolute, decodeContent(content, encoding));
  };

  const deleteLocal = async (relPath: string): Promise<void> => {
    const absolute = path.resolve(rootPath, normalizeCloudPath(relPath));
    if (!absolute.startsWith(`${rootPath}${path.sep}`))
      throw new Error(`Refusing to delete outside replica: ${relPath}`);
    await fs.rm(absolute, { force: true });
  };

  const remoteContent = async (
    manifest: CloudWorkspaceManifest,
    relPath: string
  ): Promise<{ content: string; encoding: 'utf8' | 'base64'; hash: string } | null> => {
    const meta = manifest.files[relPath];
    if (!meta || meta.deleted) return null;
    return {
      content: await options.relay.fetchBlob(meta.hash),
      encoding: meta.encoding ?? 'utf8',
      hash: meta.hash,
    };
  };

  const pushLocal = async (
    relPath: string,
    local: LocalFile | null,
    expectedRemoteHash: string | null
  ): Promise<CloudWorkspaceOperation> => {
    const claim = await options.relay.claimLease(relPath, 'replica-sync');
    if (!claim.ok) throw new Error(`file lease held by ${claim.lease.name || claim.lease.clientId}: ${relPath}`);
    try {
      if (!local) {
        return await options.relay.appendOperation({
          id: randomUUID(),
          type: 'file.delete',
          path: relPath,
          baseHash: expectedRemoteHash,
        });
      }
      await options.relay.uploadBlob(local.content);
      return await options.relay.appendOperation({
        id: randomUUID(),
        type: 'file.write',
        path: relPath,
        hash: local.hash,
        size: local.size,
        encoding: local.encoding,
        baseHash: expectedRemoteHash,
      });
    } finally {
      await options.relay.releaseLease(relPath).catch((): false => false);
    }
  };

  const recordConflict = async (
    relPath: string,
    baseHash: string | null,
    local: LocalFile | null,
    remote: Awaited<ReturnType<typeof remoteContent>>,
    baseContent: string
  ): Promise<void> => {
    const previous = persisted.conflicts.find((conflict) => conflict.relPath === relPath);
    const conflict: ReplicaConflict = {
      id: previous?.id ?? randomUUID(),
      relPath,
      baseHash,
      localHash: local?.hash ?? null,
      remoteHash: remote?.hash ?? null,
      localEncoding: local?.encoding ?? null,
      remoteEncoding: remote?.encoding ?? null,
      baseContent,
      localContent: local?.content ?? '',
      remoteContent: remote?.content ?? '',
      createdAt: previous?.createdAt ?? Date.now(),
    };
    persisted.conflicts = [...persisted.conflicts.filter((item) => item.relPath !== relPath), conflict];
    await saveState();
  };

  const synchronizePass = async (): Promise<ReplicaSyncStatus> => {
    emitStatus({ state: 'scanning', error: undefined });
    const localFiles = await scanLocal();
    const changedLocally = new Set(
      [...new Set([...Object.keys(persisted.files), ...localFiles.keys()])].filter(
        (relPath) => (persisted.files[relPath]?.hash ?? null) !== (localFiles.get(relPath)?.hash ?? null)
      )
    );
    emitStatus({ pendingFiles: changedLocally.size, state: 'syncing' });

    let manifest: CloudWorkspaceManifest;
    try {
      manifest = (await options.relay.fetchStatus()).manifest;
    } catch (error) {
      return emitStatus({ state: 'offline', pendingFiles: changedLocally.size, error: serializeError(error) });
    }

    const remoteFiles = liveRemoteFiles(manifest);
    const conflictedPaths = new Set(persisted.conflicts.map((conflict) => conflict.relPath));
    const allPaths = [
      ...new Set([...Object.keys(persisted.files), ...localFiles.keys(), ...Object.keys(manifest.files)]),
    ].toSorted();

    for (const relPath of allPaths) {
      if (conflictedPaths.has(relPath)) continue;
      const baseHash = persisted.files[relPath]?.hash ?? null;
      const local = localFiles.get(relPath) ?? null;
      const remoteMeta = remoteFiles[relPath];
      const remoteHash = remoteMeta?.hash ?? null;
      const localHash = local?.hash ?? null;

      if (localHash === remoteHash) {
        if (local && remoteMeta)
          persisted.files[relPath] = { hash: local.hash, encoding: remoteMeta.encoding ?? local.encoding };
        else delete persisted.files[relPath];
        continue;
      }

      if (localHash === baseHash) {
        const remote = await remoteContent(manifest, relPath);
        if (remote) {
          await writeLocal(relPath, remote.content, remote.encoding);
          persisted.files[relPath] = { hash: remote.hash, encoding: remote.encoding };
        } else {
          await deleteLocal(relPath);
          delete persisted.files[relPath];
        }
        continue;
      }

      if (remoteHash === baseHash) {
        const accepted = await pushLocal(relPath, local, remoteHash);
        if (local) persisted.files[relPath] = { hash: local.hash, encoding: local.encoding };
        else delete persisted.files[relPath];
        manifest.seq = accepted.seq ?? manifest.seq;
        continue;
      }

      const remote = await remoteContent(manifest, relPath);
      const baseContent = baseHash ? await options.relay.fetchBlob(baseHash) : '';
      if (local && remote && local.encoding === 'utf8' && remote.encoding === 'utf8') {
        const merged = mergeText3(baseContent, local.content, remote.content);
        if (merged.ok) {
          const mergedBytes = Buffer.from(merged.content, 'utf-8');
          const mergedLocal = encodeLocalFile(relPath, mergedBytes);
          await writeLocal(relPath, merged.content, 'utf8');
          const accepted = await pushLocal(relPath, mergedLocal, remote.hash);
          persisted.files[relPath] = { hash: mergedLocal.hash, encoding: 'utf8' };
          manifest.seq = accepted.seq ?? manifest.seq;
          continue;
        }
      }
      await recordConflict(relPath, baseHash, local, remote, baseContent);
    }

    const latest = options.relay.getManifest() ?? manifest;
    persisted.lastSyncedSeq = latest.seq;
    await saveState();
    const pendingFiles = persisted.conflicts.length;
    return emitStatus({
      state: pendingFiles > 0 ? 'conflict' : 'idle',
      lastSyncedSeq: persisted.lastSyncedSeq,
      pendingFiles,
      lastSyncAt: Date.now(),
      error: undefined,
    });
  };

  const synchronize = (): Promise<ReplicaSyncStatus> => {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      let lastError: unknown;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await synchronizePass();
        } catch (error) {
          lastError = error;
          if (!serializeError(error).includes('base hash mismatch')) throw error;
          await options.relay.fetchStatus().catch((): null => null);
        }
      }
      throw lastError ?? new Error('Replica synchronization failed after retries.');
    })()
      .catch((error) => emitStatus({ state: 'error', error: serializeError(error) }))
      .finally(() => {
        inFlight = undefined;
      });
    return inFlight;
  };

  const scheduleSync = (): void => {
    if (stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void synchronize();
    }, WATCH_DEBOUNCE_MS);
  };

  const start = async (): Promise<ReplicaSyncStatus> => {
    stopped = false;
    await loadState();
    try {
      watcher = watch(rootPath, { recursive: true }, (_event, fileName) => {
        if (!fileName) return scheduleSync();
        const relPath = String(fileName).replace(/\\/g, '/');
        if (relPath.split('/').some((part) => EXCLUDED_DIRS.has(part))) return;
        scheduleSync();
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = undefined;
      });
    } catch {
      watcher = undefined;
    }
    pollTimer = setInterval(scheduleSync, scanIntervalMs);
    return synchronize();
  };

  const stop = (): void => {
    stopped = true;
    watcher?.close();
    watcher = undefined;
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = undefined;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = undefined;
    emitStatus({ state: 'offline' });
  };

  const resolveConflict = async (
    conflictId: string,
    resolution: ReplicaConflictResolution,
    mergedContent?: string
  ): Promise<ReplicaSyncStatus> => {
    const conflict = persisted.conflicts.find((item) => item.id === conflictId);
    if (!conflict) throw new Error('Replica conflict no longer exists.');
    const manifest = (await options.relay.fetchStatus()).manifest;
    const currentRemote = await remoteContent(manifest, conflict.relPath);
    if ((currentRemote?.hash ?? null) !== conflict.remoteHash)
      throw new Error('Remote file changed again; synchronize before resolving this conflict.');

    if (resolution === 'remote') {
      if (currentRemote) {
        await writeLocal(conflict.relPath, currentRemote.content, currentRemote.encoding);
        persisted.files[conflict.relPath] = { hash: currentRemote.hash, encoding: currentRemote.encoding };
      } else {
        await deleteLocal(conflict.relPath);
        delete persisted.files[conflict.relPath];
      }
    } else if (resolution === 'local' && conflict.localHash === null) {
      await deleteLocal(conflict.relPath);
      await pushLocal(conflict.relPath, null, conflict.remoteHash);
      delete persisted.files[conflict.relPath];
    } else {
      const content = resolution === 'merged' ? mergedContent : conflict.localContent;
      if (content === undefined) throw new Error('Merged conflict content is required.');
      const encoding = resolution === 'merged' ? 'utf8' : conflict.localEncoding;
      if (!encoding) throw new Error('The selected local conflict has no file content.');
      const bytes = encoding === 'base64' ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf-8');
      const selected = encodeLocalFile(conflict.relPath, bytes);
      await writeLocal(conflict.relPath, selected.content, selected.encoding);
      await pushLocal(conflict.relPath, selected, conflict.remoteHash);
      persisted.files[conflict.relPath] = { hash: selected.hash, encoding: selected.encoding };
    }

    persisted.conflicts = persisted.conflicts.filter((item) => item.id !== conflictId);
    await saveState();
    return synchronize();
  };

  return {
    start,
    stop,
    synchronize,
    scheduleSync,
    resolveConflict,
    getStatus: (): ReplicaSyncStatus => status,
  };
};

export type CloudWorkspaceReplica = ReturnType<typeof createCloudWorkspaceReplica>;

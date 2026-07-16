/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyCloudWorkspaceOperation,
  type CloudWorkspaceFileLease,
  type CloudWorkspaceManifest,
  type CloudWorkspaceOperation,
} from '@/common/adapter/cloudWorkspaceMapper';
import {
  createCloudWorkspaceReplica,
  type CloudWorkspaceReplica,
} from '@process/ide/teamEdit/cloud/cloudReplicaService';
import type { CloudWorkspaceRelayClient } from '@process/ide/teamEdit/cloud/cloudWorkspaceRelay';

type OperationDraft = Parameters<CloudWorkspaceRelayClient['appendOperation']>[0];

type InMemoryRelay = {
  manifest: CloudWorkspaceManifest;
  blobs: Map<string, string>;
  leases: Map<string, CloudWorkspaceFileLease>;
  online: boolean;
};

const hash = (content: string): string => createHash('sha256').update(content, 'utf-8').digest('hex');

const createRelay = (): InMemoryRelay => ({
  manifest: { workspaceId: 'workspace', seq: 0, files: {} },
  blobs: new Map(),
  leases: new Map(),
  online: true,
});

const createClient = (relay: InMemoryRelay, clientId: string): CloudWorkspaceRelayClient => {
  const client = {
    fetchStatus: async () => {
      if (!relay.online) throw new Error('offline');
      return { manifest: relay.manifest, participants: [], leases: [...relay.leases.values()] };
    },
    getManifest: () => relay.manifest,
    getState: () => ({
      workspaceId: 'workspace',
      clientId,
      state: relay.online ? ('connected' as const) : ('offline' as const),
      lastAppliedSeq: relay.manifest.seq,
      pendingOps: 0,
      participants: [],
      leases: [...relay.leases.values()],
    }),
    fetchBlob: async (blobHash: string) => {
      if (!relay.online) throw new Error('offline');
      const content = relay.blobs.get(blobHash);
      if (content === undefined) throw new Error('blob-not-found');
      return content;
    },
    uploadBlob: async (content: string) => {
      if (!relay.online) throw new Error('offline');
      const blobHash = hash(content);
      relay.blobs.set(blobHash, content);
      return blobHash;
    },
    claimLease: async (relPath: string) => {
      const held = relay.leases.get(relPath);
      if (held && held.clientId !== clientId) return { ok: false as const, reason: 'held' as const, lease: held };
      const now = Date.now();
      const lease: CloudWorkspaceFileLease = {
        relPath,
        clientId,
        acquiredAt: held?.acquiredAt ?? now,
        renewedAt: now,
        expiresAt: now + 120_000,
      };
      relay.leases.set(relPath, lease);
      return { ok: true as const, lease, renewed: Boolean(held) };
    },
    releaseLease: async (relPath: string) => relay.leases.delete(relPath),
    appendOperation: async (draft: OperationDraft) => {
      if (!relay.online) throw new Error('offline');
      const relPath = draft.type === 'file.rename' ? draft.fromPath : draft.path;
      const held = relay.leases.get(relPath);
      if (!held || held.clientId !== clientId) throw new Error('file lease required');
      const current = relay.manifest.files[relPath];
      const currentHash = current && !current.deleted ? current.hash : null;
      if (draft.baseHash !== undefined && draft.baseHash !== currentHash) throw new Error('base hash mismatch');
      const operation = {
        ...draft,
        workspaceId: 'workspace',
        clientId,
        baseSeq: relay.manifest.seq,
        createdAt: Date.now(),
        protocolVersion: 2,
        seq: relay.manifest.seq + 1,
      } as CloudWorkspaceOperation;
      relay.manifest = applyCloudWorkspaceOperation(relay.manifest, operation);
      return operation;
    },
  };
  return client as unknown as CloudWorkspaceRelayClient;
};

const tempPaths: string[] = [];
const makeReplica = async (
  relay: InMemoryRelay,
  clientId: string,
  initial?: Record<string, string>
): Promise<{ root: string; replica: CloudWorkspaceReplica }> => {
  const parent = await mkdtemp(path.join(tmpdir(), `aionui-replica-${clientId}-`));
  tempPaths.push(parent);
  const root = path.join(parent, 'repo');
  const dataPath = path.join(parent, 'state');
  await mkdir(root, { recursive: true });
  for (const [relPath, content] of Object.entries(initial ?? {})) {
    const absolute = path.join(root, relPath);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf-8');
  }
  const replica = createCloudWorkspaceReplica({
    workspaceId: 'workspace',
    rootPath: root,
    dataPath,
    relay: createClient(relay, clientId),
    scanIntervalMs: 60_000,
  });
  await replica.start();
  replica.stop();
  return { root, replica };
};

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((entry) => rm(entry, { recursive: true, force: true })));
});

describe('cloud workspace local replicas', () => {
  it('keeps two working trees identical after online edits', async () => {
    const relay = createRelay();
    const a = await makeReplica(relay, 'a', { 'src/app.ts': 'export const value = 1;\n' });
    const b = await makeReplica(relay, 'b');

    await writeFile(path.join(a.root, 'src/app.ts'), 'export const value = 2;\n', 'utf-8');
    await a.replica.synchronize();
    await b.replica.synchronize();

    expect(await readFile(path.join(b.root, 'src/app.ts'), 'utf-8')).toBe('export const value = 2;\n');
  });

  it('automatically merges disjoint offline edits and converges both replicas', async () => {
    const relay = createRelay();
    const base = 'one\ntwo\nthree\n';
    const a = await makeReplica(relay, 'a', { 'file.txt': base });
    const b = await makeReplica(relay, 'b');

    await writeFile(path.join(a.root, 'file.txt'), 'ONE\ntwo\nthree\n', 'utf-8');
    await writeFile(path.join(b.root, 'file.txt'), 'one\ntwo\nTHREE\n', 'utf-8');
    await a.replica.synchronize();
    const bStatus = await b.replica.synchronize();
    await a.replica.synchronize();

    expect(bStatus.conflicts).toHaveLength(0);
    expect(await readFile(path.join(a.root, 'file.txt'), 'utf-8')).toBe('ONE\ntwo\nTHREE\n');
    expect(await readFile(path.join(b.root, 'file.txt'), 'utf-8')).toBe('ONE\ntwo\nTHREE\n');
  });

  it('does not merge against an unavailable base blob', async () => {
    const relay = createRelay();
    const base = 'base\n';
    const a = await makeReplica(relay, 'a', { 'file.txt': base });
    const b = await makeReplica(relay, 'b');

    await writeFile(path.join(a.root, 'file.txt'), 'remote\n', 'utf-8');
    await writeFile(path.join(b.root, 'file.txt'), 'local\n', 'utf-8');
    await a.replica.synchronize();
    relay.blobs.delete(hash(base));
    const status = await b.replica.synchronize();

    expect(status.state).toBe('error');
    expect(await readFile(path.join(b.root, 'file.txt'), 'utf-8')).toBe('local\n');
  });

  it('preserves overlapping versions until a user resolves the conflict', async () => {
    const relay = createRelay();
    const a = await makeReplica(relay, 'a', { 'file.txt': 'value = 1\n' });
    const b = await makeReplica(relay, 'b');

    await writeFile(path.join(a.root, 'file.txt'), 'value = 2\n', 'utf-8');
    await writeFile(path.join(b.root, 'file.txt'), 'value = 3\n', 'utf-8');
    await a.replica.synchronize();
    const conflictStatus = await b.replica.synchronize();

    expect(conflictStatus.state).toBe('conflict');
    expect(await readFile(path.join(b.root, 'file.txt'), 'utf-8')).toBe('value = 3\n');

    await b.replica.resolveConflict(conflictStatus.conflicts[0].id, 'remote');
    expect(await readFile(path.join(b.root, 'file.txt'), 'utf-8')).toBe('value = 2\n');
  });

  it('preserves a local deletion when resolving a delete-versus-edit conflict', async () => {
    const relay = createRelay();
    const a = await makeReplica(relay, 'a', { 'file.txt': 'base\n' });
    const b = await makeReplica(relay, 'b');

    await writeFile(path.join(a.root, 'file.txt'), 'remote edit\n', 'utf-8');
    await unlink(path.join(b.root, 'file.txt'));
    await a.replica.synchronize();
    const conflict = await b.replica.synchronize();

    expect(conflict.conflicts[0].localHash).toBeNull();
    await b.replica.resolveConflict(conflict.conflicts[0].id, 'local');
    await a.replica.synchronize();
    await expect(readFile(path.join(a.root, 'file.txt'))).rejects.toThrow();
  });

  it('keeps binary bytes intact when selecting the local conflict version', async () => {
    const relay = createRelay();
    const a = await makeReplica(relay, 'a');
    const first = Buffer.from([0, 1, 2, 3]);
    const aEdit = Buffer.from([0, 8, 2, 3]);
    const bEdit = Buffer.from([0, 1, 9, 3]);
    await writeFile(path.join(a.root, 'asset.bin'), first);
    await a.replica.synchronize();
    const b = await makeReplica(relay, 'b');

    await writeFile(path.join(a.root, 'asset.bin'), aEdit);
    await writeFile(path.join(b.root, 'asset.bin'), bEdit);
    await a.replica.synchronize();
    const conflict = await b.replica.synchronize();

    expect(conflict.conflicts[0].localEncoding).toBe('base64');
    await b.replica.resolveConflict(conflict.conflicts[0].id, 'local');
    await a.replica.synchronize();
    expect(await readFile(path.join(a.root, 'asset.bin'))).toEqual(bEdit);
    expect(await readFile(path.join(b.root, 'asset.bin'))).toEqual(bEdit);
  });

  it('journals disk changes while offline and publishes them after reconnect', async () => {
    const relay = createRelay();
    const a = await makeReplica(relay, 'a', { 'file.txt': 'online\n' });
    relay.online = false;
    await writeFile(path.join(a.root, 'file.txt'), 'offline edit\n', 'utf-8');

    const offline = await a.replica.synchronize();
    expect(offline.state).toBe('offline');
    expect(offline.pendingFiles).toBe(1);

    relay.online = true;
    await a.replica.synchronize();
    expect(relay.manifest.files['file.txt'].hash).toBe(hash('offline edit\n'));
  });
});

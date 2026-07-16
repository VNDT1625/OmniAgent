/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  applyCloudWorkspaceOperation,
  buildCloudWorkspaceUrls,
  listCloudWorkspaceDir,
  normalizeCloudPath,
  type CloudWorkspaceManifest,
  type CloudWorkspaceOperation,
} from '@/common/adapter/cloudWorkspaceMapper';

const manifest = (): CloudWorkspaceManifest => ({
  workspaceId: 'ws-1',
  seq: 0,
  files: {},
});

const op = (patch: Partial<CloudWorkspaceOperation> & Pick<CloudWorkspaceOperation, 'type'>): CloudWorkspaceOperation =>
  ({
    id: 'op-1',
    workspaceId: 'ws-1',
    clientId: 'client-a',
    baseSeq: 0,
    seq: 1,
    createdAt: 100,
    path: 'src/index.ts',
    hash: 'hash-a',
    size: 10,
    ...patch,
  }) as CloudWorkspaceOperation;

describe('cloudWorkspaceMapper', () => {
  it('normalizes repo-relative paths and rejects parent traversal', () => {
    expect(normalizeCloudPath('/src\\index.ts')).toBe('src/index.ts');
    expect(() => normalizeCloudPath('../secret.txt')).toThrow('parent segments');
  });

  it('builds stable HTTP, WebSocket, and MCP routes from one relay URL', () => {
    const urls = buildCloudWorkspaceUrls({ relayBaseUrl: 'https://relay.example.com/', workspaceId: 'ws 1' });

    expect(urls.manifest).toBe('https://relay.example.com/v1/workspaces/ws%201/manifest');
    expect(urls.status).toBe('https://relay.example.com/v1/workspaces/ws%201/status');
    expect(urls.leases).toBe('https://relay.example.com/v1/workspaces/ws%201/leases');
    expect(urls.connect).toBe('wss://relay.example.com/v1/workspaces/ws%201/connect');
    expect(urls.mcpSse).toBe('https://relay.example.com/v1/workspaces/ws%201/mcp/sse');
  });

  it('applies ordered write, rename, and delete operations to the manifest', () => {
    const afterWrite = applyCloudWorkspaceOperation(manifest(), op({ type: 'file.write' }));
    const afterRename = applyCloudWorkspaceOperation(
      afterWrite,
      op({ id: 'op-2', type: 'file.rename', seq: 2, fromPath: 'src/index.ts', toPath: 'src/main.ts' })
    );
    const afterDelete = applyCloudWorkspaceOperation(
      afterRename,
      op({ id: 'op-3', type: 'file.delete', seq: 3, path: 'src/main.ts' })
    );

    expect(afterWrite.files['src/index.ts']?.revision).toBe(1);
    expect(afterRename.files['src/index.ts']).toBeUndefined();
    expect(afterRename.files['src/main.ts']?.revision).toBe(2);
    expect(afterDelete.files['src/main.ts']?.deleted).toBe(true);
    expect(afterDelete.seq).toBe(3);
  });

  it('rejects sequence gaps in strict mode', () => {
    expect(() => applyCloudWorkspaceOperation(manifest(), op({ type: 'file.write', seq: 2 }))).toThrow('sequence gap');
  });

  it('lists only direct children for a directory', () => {
    const state = applyCloudWorkspaceOperation(
      applyCloudWorkspaceOperation(manifest(), op({ type: 'file.write', path: 'src/index.ts' })),
      op({ id: 'op-2', type: 'file.write', seq: 2, path: 'README.md', hash: 'hash-b' })
    );

    expect(listCloudWorkspaceDir(state, '')).toEqual([
      { name: 'src', path: 'src', isDir: true },
      { name: 'README.md', path: 'README.md', isDir: false },
    ]);
    expect(listCloudWorkspaceDir(state, 'src')).toEqual([{ name: 'index.ts', path: 'src/index.ts', isDir: false }]);
  });
});

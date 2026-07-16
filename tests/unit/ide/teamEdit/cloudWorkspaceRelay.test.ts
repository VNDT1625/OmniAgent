/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { CloudWorkspaceManifest, CloudWorkspaceOperation } from '@/common/adapter/cloudWorkspaceMapper';
import {
  collectCloudWorkspacePublishFiles,
  isCloudWorkspaceBinaryBuffer,
} from '@process/ide/teamEdit/cloud/cloudWorkspaceBridge';
import {
  createCloudWorkspaceFileAdapter,
  createCloudWorkspaceRelayClient,
} from '@process/ide/teamEdit/cloud/cloudWorkspaceRelay';
import { createRemoteIdeWorkspaceGuide } from '@process/ide/teamEdit/remoteIdeMcp';

const baseManifest = (): CloudWorkspaceManifest => ({
  workspaceId: 'ws-1',
  seq: 0,
  files: {},
});

type RecordedRequest = { url: string; init?: RequestInit };

class RecordingWebSocket extends EventTarget {
  static urls: string[] = [];
  readonly url: string;

  constructor(url: string) {
    super();
    this.url = url;
    RecordingWebSocket.urls.push(url);
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }

  close(): void {
    this.dispatchEvent(new Event('close'));
  }
}

const jsonResponse = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200 });
const textResponse = (value: string): Response => new Response(value, { status: 200 });

const makeFetch = (manifest: CloudWorkspaceManifest, records: RecordedRequest[]) => {
  const blobs = new Map<string, string>();
  return async (url: string, init?: RequestInit): Promise<Response> => {
    records.push({ url, init });
    if (url.endsWith('/manifest')) return jsonResponse(manifest);
    if (url.endsWith('/tickets') && init?.method === 'POST')
      return jsonResponse({ ticket: 'socket-ticket', expiresAt: Date.now() + 60_000 });
    if (url.endsWith('/status'))
      return jsonResponse({
        manifest,
        participants: [],
        leases: [],
      });
    if (url.endsWith('/leases') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as {
        relPath: string;
        clientId: string;
        name?: string;
        intent?: string;
      };
      return jsonResponse({
        ok: true,
        renewed: false,
        lease: {
          relPath: body.relPath,
          clientId: body.clientId,
          name: body.name,
          intent: body.intent,
          acquiredAt: 100,
          renewedAt: 100,
          expiresAt: 1000,
        },
      });
    }
    if (url.endsWith('/leases') && init?.method === 'DELETE') return jsonResponse({ ok: true });
    if (url.includes('/ops?since=')) return jsonResponse([]);
    if (url.endsWith('/ops') && init?.method === 'POST') {
      const body = JSON.parse(String(init.body)) as CloudWorkspaceOperation;
      return jsonResponse({ ...body, seq: manifest.seq + 1 });
    }
    const blobMatch = url.match(/\/blobs\/([^/?]+)$/);
    if (blobMatch && init?.method === 'PUT') {
      blobs.set(decodeURIComponent(blobMatch[1]), String(init.body));
      return jsonResponse({ ok: true, hash: decodeURIComponent(blobMatch[1]) });
    }
    if (blobMatch) return textResponse(blobs.get(decodeURIComponent(blobMatch[1])) ?? '');
    return new Response('not found', { status: 404 });
  };
};

describe('cloudWorkspaceRelay', () => {
  it('loads the manifest and appends a write operation after uploading the blob', async () => {
    const records: RecordedRequest[] = [];
    const relay = createCloudWorkspaceRelayClient(
      { relayBaseUrl: 'https://relay.example.com', workspaceId: 'ws-1', token: 'token', clientId: 'client-a' },
      { fetchImpl: makeFetch(baseManifest(), records), WebSocketImpl: undefined }
    );
    await relay.fetchManifest();
    const adapter = createCloudWorkspaceFileAdapter(relay);

    await adapter.writeFile('src/index.ts', 'hello');

    expect(relay.getManifest()?.files['src/index.ts']?.revision).toBe(1);
    expect(records.some((record) => record.url.includes('/blobs/') && record.init?.method === 'PUT')).toBe(true);
    expect(records.some((record) => record.url.endsWith('/ops') && record.init?.method === 'POST')).toBe(true);
    expect(records.some((record) => record.url.endsWith('/leases') && record.init?.method === 'POST')).toBe(true);
    expect(records.some((record) => record.url.endsWith('/leases') && record.init?.method === 'DELETE')).toBe(true);
  });

  it('surfaces cloud lease conflicts before writing a file', async () => {
    const records: RecordedRequest[] = [];
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      records.push({ url, init });
      if (url.endsWith('/manifest')) return jsonResponse(baseManifest());
      if (url.endsWith('/leases') && init?.method === 'POST')
        return jsonResponse({
          ok: false,
          reason: 'held',
          lease: {
            relPath: 'src/index.ts',
            clientId: 'client-b',
            name: 'Bob',
            acquiredAt: 100,
            renewedAt: 100,
            expiresAt: 1000,
          },
        });
      return jsonResponse({});
    };
    const relay = createCloudWorkspaceRelayClient(
      { relayBaseUrl: 'https://relay.example.com', workspaceId: 'ws-1', token: 'token', clientId: 'client-a' },
      { fetchImpl, WebSocketImpl: undefined }
    );
    await relay.fetchManifest();
    const adapter = createCloudWorkspaceFileAdapter(relay);

    await expect(adapter.writeFile('src/index.ts', 'hello')).rejects.toThrow('held by Bob');
    expect(records.some((record) => record.url.includes('/blobs/'))).toBe(false);
    expect(records.some((record) => record.url.endsWith('/ops'))).toBe(false);
  });

  it('rejects targeted edits when the old text is stale', async () => {
    const records: RecordedRequest[] = [];
    const initial = baseManifest();
    initial.seq = 1;
    initial.files['a.txt'] = { path: 'a.txt', hash: 'hash-a', size: 5, revision: 1, updatedAt: 10 };
    const relay = createCloudWorkspaceRelayClient(
      { relayBaseUrl: 'https://relay.example.com', workspaceId: 'ws-1', token: 'token', clientId: 'client-a' },
      { fetchImpl: makeFetch(initial, records), WebSocketImpl: undefined }
    );
    await relay.fetchManifest();
    await relay.uploadBlob('hello');
    const adapter = createCloudWorkspaceFileAdapter(relay);

    await expect(adapter.editFile('a.txt', 'missing', 'next')).rejects.toThrow('STALE');
  });

  it('catches up by applying missed operations since the local sequence', async () => {
    const missed: CloudWorkspaceOperation = {
      id: 'op-1',
      type: 'file.write',
      workspaceId: 'ws-1',
      clientId: 'client-b',
      baseSeq: 0,
      seq: 1,
      createdAt: 20,
      path: 'README.md',
      hash: 'hash-readme',
      size: 12,
    };
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.endsWith('/manifest')) return jsonResponse(baseManifest());
      if (url.includes('/ops?since=0')) return jsonResponse([missed]);
      return jsonResponse([]);
    };
    const relay = createCloudWorkspaceRelayClient(
      { relayBaseUrl: 'https://relay.example.com', workspaceId: 'ws-1', token: 'token', clientId: 'client-a' },
      { fetchImpl, WebSocketImpl: undefined }
    );

    await relay.catchUp();

    expect(relay.getManifest()?.seq).toBe(1);
    expect(relay.getManifest()?.files['README.md']?.hash).toBe('hash-readme');
  });

  it('uses bearer auth to mint a one-time WebSocket ticket without exposing the token in the URL', async () => {
    RecordingWebSocket.urls = [];
    const records: RecordedRequest[] = [];
    const relay = createCloudWorkspaceRelayClient(
      {
        relayBaseUrl: 'https://relay.example.com',
        workspaceId: 'ws-1',
        token: 'secret-token',
        clientId: 'client-a',
        displayName: 'Alice',
      },
      {
        fetchImpl: makeFetch(baseManifest(), records),
        WebSocketImpl: RecordingWebSocket as unknown as typeof WebSocket,
      }
    );

    await relay.connect();

    expect(records[0]?.init?.headers).toMatchObject({ authorization: 'Bearer secret-token' });
    expect(RecordingWebSocket.urls[0]).toContain('ticket=socket-ticket');
    expect(RecordingWebSocket.urls[0]).not.toContain('secret-token');
    expect(RecordingWebSocket.urls[0]).toContain('clientId=client-a');
    expect(RecordingWebSocket.urls[0]).toContain('name=Alice');
  });

  it('collects publishable local files while excluding heavy workspace noise and binary content', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aionui-cloud-publish-'));
    try {
      await mkdir(path.join(root, 'src'), { recursive: true });
      await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
      await writeFile(path.join(root, 'README.md'), 'hello');
      await writeFile(path.join(root, '.env.local'), 'TOKEN=secret');
      await writeFile(path.join(root, 'src', 'index.ts'), 'export const ok = true;');
      await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), 'ignored');

      const files = (await collectCloudWorkspacePublishFiles(root)).map((file) =>
        path.relative(root, file).replace(/\\/g, '/')
      );

      expect(files).toEqual(['README.md', 'src/index.ts']);
      expect(isCloudWorkspaceBinaryBuffer(Buffer.from([65, 0, 66]))).toBe(true);
      expect(isCloudWorkspaceBinaryBuffer(Buffer.from('text'))).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('guides cloud agents toward cloud-aware IDE tools instead of the scratch folder', () => {
    const guide = createRemoteIdeWorkspaceGuide({
      kind: 'cloud',
      baseUrl: 'https://relay.example.com',
      token: 'token',
      repoName: 'Security',
      workspacePath: 'C:/Users/MyPC/AppData/Roaming/AionUi-Dev/remote-ide/hash',
      backend: {
        listDir: async () => [],
        readFile: async () => '',
        writeFile: async () => '',
        editFile: async () => '',
        status: async () => '',
      },
    });

    expect(guide).toContain('ide_grep');
    expect(guide).toContain('ide_find_definition');
    expect(guide).toContain('ide_find_references');
    expect(guide).toContain('ide_scan_repo');
    expect(guide).toContain('ide_context');
    expect(guide).toContain('ide_command');
    expect(guide).toContain('temporary cloud worktree cache');
    expect(guide).toContain('cloud operation log');
    expect(guide).toContain('lease-guarded by the cloud relay');
    expect(guide).toContain('scratch directory');
  });
});

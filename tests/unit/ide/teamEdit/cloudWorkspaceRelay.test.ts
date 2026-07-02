/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { CloudWorkspaceManifest, CloudWorkspaceOperation } from '@/common/adapter/cloudWorkspaceMapper';
import {
  createCloudWorkspaceFileAdapter,
  createCloudWorkspaceRelayClient,
} from '@process/ide/teamEdit/cloud/cloudWorkspaceRelay';

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

  it('sends bearer auth on HTTP and token metadata on WebSocket connect', async () => {
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
    expect(RecordingWebSocket.urls[0]).toContain('token=secret-token');
    expect(RecordingWebSocket.urls[0]).toContain('clientId=client-a');
    expect(RecordingWebSocket.urls[0]).toContain('name=Alice');
  });
});

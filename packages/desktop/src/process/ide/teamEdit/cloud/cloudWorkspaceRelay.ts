/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Main-process Cloud Workspace relay client and lazy file adapter. */

import { createHash, randomUUID } from 'node:crypto';
import {
  applyCloudWorkspaceOperation,
  buildCloudWorkspaceUrls,
  listCloudWorkspaceDir,
  normalizeCloudPath,
  type CloudWorkspaceEnvelope,
  type CloudWorkspaceFileLease,
  type CloudWorkspaceLeaseClaimResult,
  type CloudWorkspaceManifest,
  type CloudWorkspaceOperation,
  type CloudWorkspaceRelayConfig,
  type CloudWorkspaceRelayStatus,
  type CloudWorkspaceSyncState,
} from '@/common/adapter/cloudWorkspaceMapper';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

type CloudWorkspaceRelayClientOptions = {
  fetchImpl?: FetchLike;
  WebSocketImpl?: typeof WebSocket;
  requestTimeoutMs?: number;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
};

type CloudWorkspaceRelayEvents = {
  state: (state: CloudWorkspaceSyncState) => void;
  operation: (op: CloudWorkspaceOperation, manifest: CloudWorkspaceManifest) => void;
  error: (error: Error) => void;
};

type CloudWorkspaceOperationDraft<T extends CloudWorkspaceOperation = CloudWorkspaceOperation> =
  T extends CloudWorkspaceOperation ? Omit<T, 'workspaceId' | 'clientId' | 'baseSeq' | 'createdAt'> : never;

export type CloudWorkspaceRelayClient = ReturnType<typeof createCloudWorkspaceRelayClient>;

const DEFAULT_REQUEST_TIMEOUT_MS = 20000;
const DEFAULT_RECONNECT_BASE_DELAY_MS = 750;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 10000;

const hashText = (content: string): string => createHash('sha256').update(content, 'utf-8').digest('hex');

const jsonHeaders = (token: string): Record<string, string> => ({
  authorization: `Bearer ${token}`,
  'content-type': 'application/json',
});

const parseJson = async <T>(response: Response): Promise<T> => {
  const text = await response.text();
  if (!response.ok) throw new Error(text || `Relay request failed with HTTP ${response.status}.`);
  return (text.length > 0 ? JSON.parse(text) : null) as T;
};

const requestJson = async <T>(
  fetchImpl: FetchLike,
  url: string,
  token: string,
  timeoutMs: number,
  init: RequestInit = {}
): Promise<T> => {
  const response = await fetchImpl(url, {
    ...init,
    headers: { ...jsonHeaders(token), ...(init.headers as Record<string, string> | undefined) },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return parseJson<T>(response);
};

const initialSyncState = (config: CloudWorkspaceRelayConfig): CloudWorkspaceSyncState => ({
  workspaceId: config.workspaceId,
  clientId: config.clientId,
  state: 'idle',
  lastAppliedSeq: 0,
  pendingOps: 0,
  participants: [],
  leases: [],
});

export const createCloudWorkspaceRelayClient = (
  config: CloudWorkspaceRelayConfig,
  options: CloudWorkspaceRelayClientOptions = {}
) => {
  const fetchImpl = options.fetchImpl ?? ((url, init) => fetch(url, init));
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const reconnectBaseDelayMs = options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
  const reconnectMaxDelayMs = options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
  const urls = buildCloudWorkspaceUrls(config);
  const listeners: { [K in keyof CloudWorkspaceRelayEvents]: Set<CloudWorkspaceRelayEvents[K]> } = {
    state: new Set(),
    operation: new Set(),
    error: new Set(),
  };
  let manifest: CloudWorkspaceManifest | null = null;
  let syncState = initialSyncState(config);
  let socket: WebSocket | null = null;
  let closed = false;
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const emit = <K extends keyof CloudWorkspaceRelayEvents>(
    kind: K,
    ...args: Parameters<CloudWorkspaceRelayEvents[K]>
  ): void => {
    for (const listener of listeners[kind]) {
      const typed = listener as (...values: Parameters<CloudWorkspaceRelayEvents[K]>) => void;
      typed(...args);
    }
  };

  const setState = (patch: Partial<CloudWorkspaceSyncState>): void => {
    syncState = { ...syncState, ...patch };
    emit('state', syncState);
  };

  const applyRemoteOperation = (op: CloudWorkspaceOperation): void => {
    if (!manifest) throw new Error('Cannot apply cloud operation before manifest is loaded.');
    manifest = applyCloudWorkspaceOperation(manifest, op);
    setState({ lastAppliedSeq: manifest.seq });
    emit('operation', op, manifest);
  };

  const fetchManifest = async (): Promise<CloudWorkspaceManifest> => {
    manifest = await requestJson<CloudWorkspaceManifest>(fetchImpl, urls.manifest, config.token, requestTimeoutMs);
    setState({ lastAppliedSeq: manifest.seq });
    return manifest;
  };

  const fetchOpsSince = async (seq: number): Promise<CloudWorkspaceOperation[]> =>
    requestJson<CloudWorkspaceOperation[]>(fetchImpl, urls.opsSince(seq), config.token, requestTimeoutMs);

  const fetchStatus = async (): Promise<CloudWorkspaceRelayStatus> => {
    const status = await requestJson<CloudWorkspaceRelayStatus>(fetchImpl, urls.status, config.token, requestTimeoutMs);
    manifest = status.manifest;
    setState({
      lastAppliedSeq: status.manifest.seq,
      participants: status.participants,
      leases: status.leases,
    });
    return status;
  };

  const catchUp = async (): Promise<void> => {
    if (!manifest) await fetchManifest();
    const ops = await fetchOpsSince(manifest?.seq ?? 0);
    for (const op of ops) applyRemoteOperation(op);
  };

  const scheduleReconnect = (): void => {
    if (closed) return;
    const delay = Math.min(reconnectBaseDelayMs * 2 ** reconnectAttempt, reconnectMaxDelayMs);
    reconnectAttempt += 1;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  };

  const handleEnvelope = (envelope: CloudWorkspaceEnvelope): void => {
    if (envelope.kind === 'hello') {
      setState({
        state: 'connected',
        lastAppliedSeq: envelope.seq,
        participants: envelope.participants ?? [],
        leases: envelope.leases ?? syncState.leases,
      });
      reconnectAttempt = 0;
      if (manifest && envelope.seq > manifest.seq) void catchUp().catch(handleError);
      return;
    }
    if (envelope.kind === 'op') {
      applyRemoteOperation(envelope.op);
      return;
    }
    if (envelope.kind === 'presence') {
      setState({ participants: envelope.participants });
      return;
    }
    if (envelope.kind === 'leases') {
      setState({ leases: envelope.leases });
      return;
    }
    if (envelope.kind === 'error') {
      handleError(new Error(envelope.message));
    }
  };

  const handleError = (error: Error): void => {
    setState({ state: 'error', error: error.message });
    emit('error', error);
  };

  const connect = async (): Promise<void> => {
    if (!WebSocketImpl) throw new Error('WebSocket is not available in this runtime.');
    closed = false;
    setState({ state: reconnectAttempt > 0 ? 'reconnecting' : 'connecting', error: undefined });
    if (!manifest) await fetchManifest();
    const url = new URL(urls.connect);
    url.searchParams.set('token', config.token);
    url.searchParams.set('clientId', config.clientId);
    if (config.displayName) url.searchParams.set('name', config.displayName);
    socket?.close();
    socket = new WebSocketImpl(url.toString());
    socket.addEventListener('open', () => {
      setState({ state: 'connected', error: undefined });
      void catchUp().catch(handleError);
    });
    socket.addEventListener('message', (event: MessageEvent) => {
      try {
        const payload = typeof event.data === 'string' ? event.data : String(event.data);
        handleEnvelope(JSON.parse(payload) as CloudWorkspaceEnvelope);
      } catch (error) {
        handleError(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.addEventListener('close', () => {
      socket = null;
      if (!closed) {
        setState({ state: 'reconnecting' });
        scheduleReconnect();
      }
    });
    socket.addEventListener('error', () => {
      handleError(new Error('Cloud workspace WebSocket error.'));
    });
  };

  const close = (): void => {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    socket?.close();
    socket = null;
    setState({ state: 'offline' });
  };

  const appendOperation = async (op: CloudWorkspaceOperationDraft) => {
    const currentSeq = manifest?.seq ?? syncState.lastAppliedSeq;
    const pending = {
      ...op,
      workspaceId: config.workspaceId,
      clientId: config.clientId,
      baseSeq: currentSeq,
      createdAt: Date.now(),
    } as CloudWorkspaceOperation;
    setState({ pendingOps: syncState.pendingOps + 1 });
    try {
      const accepted = await requestJson<CloudWorkspaceOperation>(
        fetchImpl,
        urls.appendOp,
        config.token,
        requestTimeoutMs,
        {
          method: 'POST',
          body: JSON.stringify(pending),
        }
      );
      applyRemoteOperation(accepted);
      return accepted;
    } finally {
      setState({ pendingOps: Math.max(0, syncState.pendingOps - 1) });
    }
  };

  const fetchBlob = async (hash: string): Promise<string> => {
    const response = await fetchImpl(urls.blob(hash), {
      headers: { authorization: `Bearer ${config.token}` },
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) throw new Error(`Could not fetch blob ${hash}: HTTP ${response.status}.`);
    return response.text();
  };

  const uploadBlob = async (content: string): Promise<string> => {
    const hash = hashText(content);
    await requestJson<{ ok: true; hash: string }>(fetchImpl, urls.blob(hash), config.token, requestTimeoutMs, {
      method: 'PUT',
      body: content,
      headers: { 'content-type': 'text/plain; charset=utf-8' },
    });
    return hash;
  };

  const claimLease = async (relPath: string, intent?: string): Promise<CloudWorkspaceLeaseClaimResult> =>
    requestJson<CloudWorkspaceLeaseClaimResult>(fetchImpl, urls.leases, config.token, requestTimeoutMs, {
      method: 'POST',
      body: JSON.stringify({
        relPath: normalizeCloudPath(relPath),
        clientId: config.clientId,
        name: config.displayName,
        intent,
      }),
      headers: { 'x-aion-client-id': config.clientId },
    });

  const releaseLease = async (relPath: string): Promise<boolean> => {
    const res = await requestJson<{ ok: boolean }>(fetchImpl, urls.leases, config.token, requestTimeoutMs, {
      method: 'DELETE',
      body: JSON.stringify({ relPath: normalizeCloudPath(relPath), clientId: config.clientId }),
      headers: { 'x-aion-client-id': config.clientId },
    });
    return res.ok;
  };

  const on = <K extends keyof CloudWorkspaceRelayEvents>(
    kind: K,
    listener: CloudWorkspaceRelayEvents[K]
  ): (() => void) => {
    listeners[kind].add(listener);
    return () => listeners[kind].delete(listener);
  };

  return {
    urls,
    on,
    connect,
    close,
    fetchManifest,
    fetchStatus,
    fetchOpsSince,
    catchUp,
    appendOperation,
    fetchBlob,
    uploadBlob,
    claimLease,
    releaseLease,
    getManifest: (): CloudWorkspaceManifest | null => manifest,
    getState: (): CloudWorkspaceSyncState => syncState,
  };
};

const withCloudLease = async <T>(
  relay: CloudWorkspaceRelayClient,
  relPath: string,
  intent: string,
  fn: () => Promise<T>
): Promise<T> => {
  const claim = await relay.claimLease(relPath, intent);
  if (!claim.ok)
    throw new Error(`Cloud file is currently held by ${claim.lease.name || claim.lease.clientId}: ${relPath}`);
  try {
    return await fn();
  } finally {
    await relay.releaseLease(relPath).catch((): false => false);
  }
};

export const createCloudWorkspaceFileAdapter = (relay: CloudWorkspaceRelayClient) => ({
  listDir: (dir = '') => {
    const manifest = relay.getManifest();
    if (!manifest) throw new Error('Cloud workspace manifest is not loaded.');
    return listCloudWorkspaceDir(manifest, dir);
  },
  readFile: async (path: string): Promise<string> => {
    const manifest = relay.getManifest();
    if (!manifest) throw new Error('Cloud workspace manifest is not loaded.');
    const relPath = normalizeCloudPath(path);
    const meta = manifest.files[relPath];
    if (!meta || meta.deleted) throw new Error(`Cloud file not found: ${relPath}.`);
    return relay.fetchBlob(meta.hash);
  },
  writeFile: async (path: string, content: string): Promise<CloudWorkspaceOperation> => {
    const relPath = normalizeCloudPath(path);
    return withCloudLease(relay, relPath, `${content.length} bytes`, async () => {
      const hash = await relay.uploadBlob(content);
      return relay.appendOperation({ id: randomUUID(), type: 'file.write', path: relPath, hash, size: content.length });
    });
  },
  editFile: async (path: string, oldText: string, newText: string): Promise<CloudWorkspaceOperation> => {
    const relPath = normalizeCloudPath(path);
    return withCloudLease(relay, relPath, 'edit', async () => {
      const current = await createCloudWorkspaceFileAdapter(relay).readFile(relPath);
      const first = current.indexOf(oldText);
      if (first < 0) throw new Error('STALE: oldText was not found in the current cloud file.');
      if (current.indexOf(oldText, first + oldText.length) >= 0)
        throw new Error('AMBIGUOUS: oldText matches more than once.');
      const next = `${current.slice(0, first)}${newText}${current.slice(first + oldText.length)}`;
      const hash = await relay.uploadBlob(next);
      return relay.appendOperation({
        id: randomUUID(),
        type: 'file.patch',
        path: relPath,
        oldText,
        newText,
        hash,
        size: next.length,
      });
    });
  },
  claimFile: (path: string, intent?: string): Promise<CloudWorkspaceLeaseClaimResult> =>
    relay.claimLease(normalizeCloudPath(path), intent),
  releaseFile: (path: string): Promise<boolean> => relay.releaseLease(normalizeCloudPath(path)),
  listLeases: (): CloudWorkspaceFileLease[] => relay.getState().leases,
});

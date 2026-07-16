/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { DurableObject } from 'cloudflare:workers';

export interface Env {
  WORKSPACE_ROOMS: DurableObjectNamespace<WorkspaceRoom>;
  BLOBS: R2Bucket;
}

type FileMeta = {
  path: string;
  hash: string;
  size: number;
  revision: number;
  updatedAt: number;
  deleted?: boolean;
  encoding?: 'utf8' | 'base64';
};

type Manifest = {
  workspaceId: string;
  seq: number;
  files: Record<string, FileMeta>;
};

type FileLease = {
  relPath: string;
  clientId: string;
  name?: string;
  intent?: string;
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
};

type LeaseClaimResult =
  | { ok: true; lease: FileLease; renewed: boolean }
  | { ok: false; reason: 'held'; lease: FileLease };

type OperationBase = {
  id: string;
  workspaceId: string;
  clientId: string;
  seq?: number;
  baseSeq: number;
  createdAt: number;
  protocolVersion?: 2;
};

type Operation =
  | (OperationBase & {
      type: 'file.write';
      path: string;
      hash: string;
      size: number;
      baseHash?: string | null;
      encoding?: 'utf8' | 'base64';
    })
  | (OperationBase & {
      type: 'file.patch';
      path: string;
      oldText: string;
      newText: string;
      hash: string;
      size: number;
      baseHash?: string | null;
      encoding?: 'utf8' | 'base64';
    })
  | (OperationBase & { type: 'file.rename'; fromPath: string; toPath: string; baseHash?: string | null })
  | (OperationBase & { type: 'file.delete'; path: string; baseHash?: string | null });

type Presence = {
  clientId: string;
  name: string;
  role: 'owner' | 'editor' | 'viewer' | 'agent';
  lastSeenAt: number;
};

type SessionAttachment = {
  clientId: string;
  name: string;
};

const DEFAULT_LEASE_TTL_MS = 120_000;
const MAX_LEASE_TTL_MS = 300_000;
const MAX_OPERATION_BODY_BYTES = 6 * 1024 * 1024;
const MAX_BLOB_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 20_000;
const RETAINED_OPERATION_COUNT = 5_000;
const MIN_TOKEN_LENGTH = 32;
const MAX_ID_LENGTH = 128;
const MAX_PATH_LENGTH = 1_024;
const MAX_CONTROL_BODY_BYTES = 16 * 1_024;
const SOCKET_TICKET_TTL_MS = 60_000;

const json = (value: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(value), {
    ...init,
    headers: { 'content-type': 'application/json; charset=utf-8', ...init.headers },
  });

const normalizePath = (input: string): string => {
  const parts = decodeURIComponent(input)
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .split('/')
    .filter((part) => part.length > 0 && part !== '.');
  if (parts.some((part) => part === '..')) throw new Error('Invalid path.');
  const normalized = parts.join('/');
  if (normalized.length > MAX_PATH_LENGTH) throw new Error('Path is too long.');
  return normalized;
};

const sha256Hex = async (content: string): Promise<string> => {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const emptyManifest = (workspaceId: string): Manifest => ({ workspaceId, seq: 0, files: {} });

const readBoundedJson = async <T>(request: Request, maxBytes: number): Promise<T> => {
  const declaredLength = Number(request.headers.get('content-length') ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) throw new Error('request body too large');
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new Error('request body too large');
  return JSON.parse(text) as T;
};

const extractToken = (request: Request): string => {
  const token = request.headers
    .get('authorization')
    ?.match(/^Bearer\s+(.+)$/i)?.[1]
    ?.trim();
  if (!token) throw new Error('missing authorization token');
  if (token.length < MIN_TOKEN_LENGTH)
    throw new Error(`authorization token must be at least ${MIN_TOKEN_LENGTH} characters`);
  return token;
};

const hashToken = async (workspaceId: string, token: string): Promise<string> => {
  const bytes = new TextEncoder().encode(`${workspaceId}:${token}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const secureHashEqual = (provided: string, expected: string): boolean => {
  if (provided.length !== 64 || expected.length !== 64) return false;
  let difference = 0;
  for (let index = 0; index < 64; index += 1) difference |= provided.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
};

const validateId = (value: string, label: string): string => {
  const trimmed = value.trim();
  const minimum = label === 'workspaceId' ? 16 : 1;
  if (trimmed.length < minimum || trimmed.length > MAX_ID_LENGTH || !/^[A-Za-z0-9_-]+$/.test(trimmed))
    throw new Error(`${label} must be ${minimum}-${MAX_ID_LENGTH} characters using only letters, numbers, _ or -`);
  return trimmed;
};

const applyOperation = (manifest: Manifest, op: Operation): Manifest => {
  const next: Manifest = {
    workspaceId: manifest.workspaceId,
    seq: op.seq ?? manifest.seq,
    files: Object.fromEntries(Object.entries(manifest.files).map(([key, value]) => [key, { ...value }])),
  };
  const updatedAt = op.createdAt;
  if (op.type === 'file.write' || op.type === 'file.patch') {
    const filePath = normalizePath(op.path);
    const previous = next.files[filePath];
    next.files[filePath] = {
      path: filePath,
      hash: op.hash,
      size: op.size,
      revision: (previous?.revision ?? 0) + 1,
      updatedAt,
      encoding: op.encoding ?? previous?.encoding ?? 'utf8',
    };
  } else if (op.type === 'file.rename') {
    const fromPath = normalizePath(op.fromPath);
    const toPath = normalizePath(op.toPath);
    const previous = next.files[fromPath];
    if (!previous) throw new Error(`Cannot rename missing file: ${fromPath}.`);
    delete next.files[fromPath];
    next.files[toPath] = { ...previous, path: toPath, revision: previous.revision + 1, updatedAt };
  } else {
    const filePath = normalizePath(op.path);
    const previous = next.files[filePath];
    next.files[filePath] = previous
      ? { ...previous, deleted: true, revision: previous.revision + 1, updatedAt }
      : { path: filePath, hash: '', size: 0, revision: 1, updatedAt, deleted: true };
  }
  return next;
};

const touchedPaths = (op: Operation): string[] => {
  if (op.type === 'file.rename') return [normalizePath(op.fromPath), normalizePath(op.toPath)];
  return [normalizePath(op.path)];
};

export class WorkspaceRoom extends DurableObject<Env> {
  private readonly state: DurableObjectState;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      const workspaceId = validateId(decodeURIComponent(url.pathname.split('/')[3] ?? ''), 'workspaceId');
      if (url.pathname.endsWith('/connect')) {
        await this.authorizeSocket(url);
        return await this.handleConnect(request, workspaceId);
      }
      await this.authorize(request, workspaceId);
      if (url.pathname.endsWith('/tickets') && request.method === 'POST') return json(await this.issueSocketTicket());
      if (url.pathname.endsWith('/manifest') && request.method === 'GET')
        return json(await this.getManifest(workspaceId));
      if (url.pathname.endsWith('/status') && request.method === 'GET')
        return json({
          manifest: await this.getManifest(workspaceId),
          participants: this.participants(),
          leases: await this.listLeases(),
        });
      if (url.pathname.endsWith('/leases') && request.method === 'GET') return json(await this.listLeases());
      if (url.pathname.endsWith('/leases') && request.method === 'POST')
        return json(await this.claimLease(workspaceId, request));
      if (url.pathname.endsWith('/leases') && request.method === 'DELETE')
        return json({ ok: await this.releaseLease(request) });
      if (url.pathname.endsWith('/ops') && request.method === 'GET')
        return json(await this.getOpsSince(Number(url.searchParams.get('since') ?? 0)));
      if (url.pathname.endsWith('/ops') && request.method === 'POST')
        return json(await this.acceptOperation(workspaceId, request));
      const blobMatch = url.pathname.match(/\/blobs\/([^/]+)$/);
      if (blobMatch) return await this.handleBlob(request, blobMatch[1]);
      const fileMatch = url.pathname.match(/\/files\/(.+)$/);
      if (fileMatch) return await this.handleFile(request, workspaceId, fileMatch[1]);
      if (url.pathname.endsWith('/mcp/sse'))
        return json({ ok: false, error: 'MCP relay route is reserved for the app-side MCP gateway.' }, { status: 501 });
      return json({ ok: false, error: 'not-found' }, { status: 404 });
    } catch (error) {
      return json({ ok: false, error: error instanceof Error ? error.message : String(error) }, { status: 400 });
    }
  }

  private async authorize(request: Request, workspaceId: string): Promise<void> {
    const tokenHash = await hashToken(workspaceId, extractToken(request));
    const key = 'auth:tokenHash';
    const stored = await this.state.storage.get<string>(key);
    if (!stored) {
      await this.state.storage.put(key, tokenHash);
      return;
    }
    if (!secureHashEqual(tokenHash, stored)) throw new Error('invalid authorization token');
  }

  private async issueSocketTicket(): Promise<{ ticket: string; expiresAt: number }> {
    const now = Date.now();
    const stored = await this.state.storage.list<number>({ prefix: 'auth:ticket:' });
    const expired = [...stored.entries()].filter(([, expiresAt]) => expiresAt < now).map(([key]) => key);
    if (expired.length > 0) await this.state.storage.delete(expired);
    const ticket = crypto.randomUUID();
    const expiresAt = now + SOCKET_TICKET_TTL_MS;
    await this.state.storage.put(`auth:ticket:${ticket}`, expiresAt);
    return { ticket, expiresAt };
  }

  private async authorizeSocket(url: URL): Promise<void> {
    const ticket = url.searchParams.get('ticket')?.trim();
    if (!ticket) throw new Error('missing WebSocket ticket');
    const key = `auth:ticket:${ticket}`;
    const expiresAt = await this.state.storage.get<number>(key);
    await this.state.storage.delete(key);
    if (!expiresAt || expiresAt < Date.now()) throw new Error('invalid or expired WebSocket ticket');
  }

  private async getManifest(workspaceId: string): Promise<Manifest> {
    return (await this.state.storage.get<Manifest>('manifest')) ?? emptyManifest(workspaceId);
  }

  private async getOpsSince(seq: number): Promise<Operation[]> {
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('since must be a non-negative integer');
    const list = await this.state.storage.list<Operation>({ prefix: 'op:' });
    return [...list.entries()]
      .map(([, value]) => value)
      .filter((op) => (op.seq ?? 0) > seq)
      .toSorted((a, b) => (a.seq ?? 0) - (b.seq ?? 0));
  }

  private async getLease(relPath: string): Promise<FileLease | undefined> {
    const lease = await this.state.storage.get<FileLease>(`lease:${relPath}`);
    if (!lease) return undefined;
    if (lease.expiresAt > Date.now()) return lease;
    await this.state.storage.delete(`lease:${relPath}`);
    return undefined;
  }

  private async listLeases(): Promise<FileLease[]> {
    const leases = await this.state.storage.list<FileLease>({ prefix: 'lease:' });
    const live: FileLease[] = [];
    const expired: string[] = [];
    const now = Date.now();
    for (const [key, lease] of leases.entries()) {
      if (lease.expiresAt > now) live.push(lease);
      else expired.push(key);
    }
    if (expired.length > 0) await this.state.storage.delete(expired);
    return live.toSorted((a, b) => a.relPath.localeCompare(b.relPath));
  }

  private async putLease(lease: FileLease): Promise<void> {
    await this.state.storage.put(`lease:${lease.relPath}`, lease);
    this.broadcast({ kind: 'leases', leases: await this.listLeases() });
  }

  private async claimLease(workspaceId: string, request: Request): Promise<LeaseClaimResult> {
    const body = await readBoundedJson<{
      relPath?: string;
      path?: string;
      clientId?: string;
      name?: string;
      intent?: string;
      ttlMs?: number;
    }>(request, MAX_CONTROL_BODY_BYTES);
    const relPath = normalizePath(body.relPath ?? body.path ?? '');
    if (!relPath) throw new Error('lease path is required');
    const clientId = validateId(
      body.clientId?.trim() || request.headers.get('x-aion-client-id') || 'http-client',
      'clientId'
    );
    const held = await this.getLease(relPath);
    if (held && held.clientId !== clientId) return { ok: false, reason: 'held', lease: held };
    const now = Date.now();
    const requestedTtl = body.ttlMs ?? DEFAULT_LEASE_TTL_MS;
    if (!Number.isFinite(requestedTtl)) throw new Error('lease ttl must be finite');
    const ttl = Math.max(1, Math.min(Math.trunc(requestedTtl), MAX_LEASE_TTL_MS));
    const lease: FileLease = {
      relPath,
      clientId,
      name: (body.name?.trim() || clientId).slice(0, MAX_ID_LENGTH),
      intent: body.intent?.trim().slice(0, 256),
      acquiredAt: held?.acquiredAt ?? now,
      renewedAt: now,
      expiresAt: now + ttl,
    };
    await this.putLease(lease);
    void workspaceId;
    return { ok: true, lease, renewed: Boolean(held) };
  }

  private async releaseLease(request: Request): Promise<boolean> {
    const body = await readBoundedJson<{ relPath?: string; path?: string; clientId?: string }>(
      request,
      MAX_CONTROL_BODY_BYTES
    );
    const relPath = normalizePath(body.relPath ?? body.path ?? '');
    if (!relPath) throw new Error('lease path is required');
    const clientId = validateId(
      body.clientId?.trim() || request.headers.get('x-aion-client-id') || 'http-client',
      'clientId'
    );
    const held = await this.getLease(relPath);
    if (!held || held.clientId !== clientId) return false;
    await this.state.storage.delete(`lease:${relPath}`);
    this.broadcast({ kind: 'leases', leases: await this.listLeases() });
    return true;
  }

  private async assertOperationLeases(op: Operation): Promise<void> {
    for (const relPath of touchedPaths(op)) {
      // Durable Object requests are serialized, so this is an authoritative write lock.
      // eslint-disable-next-line no-await-in-loop
      const held = await this.getLease(relPath);
      if (!held) throw new Error(`file lease required: ${relPath}`);
      if (held.clientId !== op.clientId)
        throw new Error(`file lease held by ${held.name || held.clientId}: ${relPath}`);
    }
  }

  private assertOperationBase(manifest: Manifest, op: Operation): void {
    const baseHash = op.baseHash;
    if (baseHash === undefined) {
      if (op.baseSeq !== manifest.seq) throw new Error(`base sequence mismatch: expected ${manifest.seq}`);
      return;
    }
    const relPath = op.type === 'file.rename' ? normalizePath(op.fromPath) : normalizePath(op.path);
    const current = manifest.files[relPath];
    const currentHash = current && !current.deleted ? current.hash : null;
    if (currentHash !== baseHash)
      throw new Error(`base hash mismatch for ${relPath}: expected ${currentHash ?? 'missing'}`);
  }

  private async compactOperations(seq: number): Promise<void> {
    if (seq <= RETAINED_OPERATION_COUNT || seq % 250 !== 0) return;
    const cutoff = seq - RETAINED_OPERATION_COUNT;
    const stored = await this.state.storage.list<Operation>({ prefix: 'op:' });
    const expired = [...stored.entries()].filter(([, op]) => (op.seq ?? 0) <= cutoff);
    const keys = expired.flatMap(([key, op]) => [key, `op-id:${op.id}`]);
    if (keys.length > 0) await this.state.storage.delete(keys);
  }

  private async acceptOperation(workspaceId: string, request: Request): Promise<Operation> {
    const incoming = await readBoundedJson<Operation>(request, MAX_OPERATION_BODY_BYTES);
    const operationId = validateId(incoming.id ?? '', 'operation id');
    incoming.clientId = validateId(incoming.clientId ?? '', 'clientId');
    if (incoming.workspaceId !== workspaceId) throw new Error('workspace mismatch');
    if (!['file.write', 'file.patch', 'file.rename', 'file.delete'].includes(incoming.type))
      throw new Error('unsupported operation type');
    if (!Number.isSafeInteger(incoming.baseSeq) || incoming.baseSeq < 0)
      throw new Error('baseSeq must be a non-negative integer');
    const operationPaths = touchedPaths(incoming);
    if (operationPaths.some((relPath) => !relPath)) throw new Error('operation path is required');
    if (incoming.baseHash !== undefined && incoming.baseHash !== null && !/^[a-f0-9]{64}$/.test(incoming.baseHash))
      throw new Error('invalid base hash');

    const duplicate = await this.state.storage.get<Operation>(`op-id:${operationId}`);
    if (duplicate) return duplicate;

    if (incoming.type === 'file.write' || incoming.type === 'file.patch') {
      if (!/^[a-f0-9]{64}$/.test(incoming.hash)) throw new Error('invalid blob hash');
      if (!Number.isSafeInteger(incoming.size) || incoming.size < 0 || incoming.size > MAX_BLOB_BYTES)
        throw new Error('invalid file size');
      if (incoming.encoding !== undefined && incoming.encoding !== 'utf8' && incoming.encoding !== 'base64')
        throw new Error('invalid file encoding');
      const blob = await this.env.BLOBS.head(incoming.hash);
      if (!blob) throw new Error(`blob not found: ${incoming.hash}`);
    }

    // R2 I/O can reopen the Durable Object input gate. Re-read all authoritative
    // state after it so concurrent writers cannot receive the same sequence.
    const repeated = await this.state.storage.get<Operation>(`op-id:${operationId}`);
    if (repeated) return repeated;
    const manifest = await this.getManifest(workspaceId);
    this.assertOperationBase(manifest, incoming);
    await this.assertOperationLeases(incoming);

    if (incoming.type === 'file.write' || incoming.type === 'file.patch') {
      const relPath = normalizePath(incoming.path);
      const previous = manifest.files[relPath];
      const liveFiles = Object.values(manifest.files).filter((file) => !file.deleted).length;
      if ((!previous || previous.deleted) && liveFiles >= MAX_FILES) throw new Error('workspace file limit reached');
    } else if (incoming.type === 'file.rename') {
      const fromPath = normalizePath(incoming.fromPath);
      const toPath = normalizePath(incoming.toPath);
      if (fromPath === toPath) throw new Error('rename paths must differ');
      const source = manifest.files[fromPath];
      if (!source || source.deleted) throw new Error(`cannot rename missing file: ${fromPath}`);
      const destination = manifest.files[toPath];
      if (destination && !destination.deleted) throw new Error(`rename destination already exists: ${toPath}`);
    } else {
      const relPath = normalizePath(incoming.path);
      const existing = manifest.files[relPath];
      if (!existing || existing.deleted) throw new Error(`cannot delete missing file: ${relPath}`);
    }

    const accepted = {
      ...incoming,
      protocolVersion: 2,
      seq: manifest.seq + 1,
      createdAt: Date.now(),
    } as Operation;
    const next = applyOperation(manifest, accepted);
    const opKey = `op:${String(accepted.seq).padStart(16, '0')}`;
    await this.state.storage.put({ [opKey]: accepted, [`op-id:${accepted.id}`]: accepted, manifest: next });
    await this.compactOperations(accepted.seq ?? next.seq);
    this.broadcast({ kind: 'op', op: accepted });
    return accepted;
  }

  private async handleConnect(request: Request, workspaceId: string): Promise<Response> {
    const upgrade = request.headers.get('Upgrade');
    if (upgrade?.toLowerCase() !== 'websocket')
      return json({ ok: false, error: 'expected websocket' }, { status: 426 });
    const url = new URL(request.url);
    const clientId = validateId(url.searchParams.get('clientId') || crypto.randomUUID(), 'clientId');
    const name = (url.searchParams.get('name')?.trim() || clientId).slice(0, MAX_ID_LENGTH);
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ clientId, name } satisfies SessionAttachment);
    const manifest = await this.getManifest(workspaceId);
    const leases = await this.listLeases();
    server.send(JSON.stringify({ kind: 'hello', workspaceId, seq: manifest.seq, participants: this.participants() }));
    server.send(JSON.stringify({ kind: 'leases', leases }));
    this.broadcast({ kind: 'presence', participants: this.participants() });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketClose(socket: WebSocket): Promise<void> {
    await this.dropSession(socket);
  }

  async webSocketError(socket: WebSocket): Promise<void> {
    await this.dropSession(socket);
  }

  private async dropSession(socket: WebSocket): Promise<void> {
    const presence = socket.deserializeAttachment() as SessionAttachment | null;
    if (presence?.clientId) await this.releaseClientLeases(presence.clientId);
    this.broadcast({ kind: 'presence', participants: this.participants() });
  }

  private async releaseClientLeases(clientId: string): Promise<void> {
    const leases = await this.state.storage.list<FileLease>({ prefix: 'lease:' });
    const owned = [...leases.entries()].filter(([, lease]) => lease.clientId === clientId).map(([key]) => key);
    if (owned.length > 0) {
      await this.state.storage.delete(owned);
      this.broadcast({ kind: 'leases', leases: await this.listLeases() });
    }
  }

  private participants(): Presence[] {
    const now = Date.now();
    return this.state.getWebSockets().flatMap((socket) => {
      const attachment = socket.deserializeAttachment() as SessionAttachment | null;
      return attachment
        ? [{ clientId: attachment.clientId, name: attachment.name, role: 'editor' as const, lastSeenAt: now }]
        : [];
    });
  }

  private broadcast(value: unknown): void {
    const message = JSON.stringify(value);
    for (const socket of this.state.getWebSockets()) {
      try {
        socket.send(message);
      } catch {
        socket.close(1011, 'send failed');
      }
    }
  }

  private async handleBlob(request: Request, hashParam: string): Promise<Response> {
    const hash = normalizePath(hashParam);
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('invalid blob hash');
    if (request.method === 'PUT') {
      const declaredLength = Number(request.headers.get('content-length') ?? 0);
      if (declaredLength > MAX_BLOB_BYTES) throw new Error('blob too large');
      const content = await request.text();
      const bytes = new TextEncoder().encode(content);
      if (bytes.byteLength > MAX_BLOB_BYTES) throw new Error('blob too large');
      const actualHash = await sha256Hex(content);
      if (actualHash !== hash) throw new Error('blob hash mismatch');
      await this.env.BLOBS.put(hash, content, {
        httpMetadata: { contentType: request.headers.get('content-type') ?? 'text/plain; charset=utf-8' },
        customMetadata: { sha256: hash },
      });
      return json({ ok: true, hash });
    }
    if (request.method === 'GET') {
      const object = await this.env.BLOBS.get(hash);
      if (!object) return json({ ok: false, error: 'blob-not-found' }, { status: 404 });
      return new Response(object.body, {
        headers: { 'content-type': object.httpMetadata?.contentType ?? 'text/plain; charset=utf-8' },
      });
    }
    return json({ ok: false, error: 'method-not-allowed' }, { status: 405 });
  }

  private async handleFile(request: Request, workspaceId: string, pathParam: string): Promise<Response> {
    const filePath = normalizePath(pathParam);
    const manifest = await this.getManifest(workspaceId);
    if (request.method === 'GET') {
      const meta = manifest.files[filePath];
      if (!meta || meta.deleted) return json({ ok: false, error: 'file-not-found' }, { status: 404 });
      const object = await this.env.BLOBS.get(meta.hash);
      if (!object) return json({ ok: false, error: 'blob-not-found' }, { status: 404 });
      return new Response(object.body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
    }
    return json(
      { ok: false, error: 'method-not-allowed; upload a blob then append a leased operation' },
      { status: 405 }
    );
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/v1\/workspaces\/([^/]+)/);
    if (!match) return json({ ok: false, error: 'not-found' }, { status: 404 });
    const id = env.WORKSPACE_ROOMS.idFromName(decodeURIComponent(match[1]));
    return env.WORKSPACE_ROOMS.get(id).fetch(request);
  },
};

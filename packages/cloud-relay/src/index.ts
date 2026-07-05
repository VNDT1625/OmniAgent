/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

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
};

type Operation =
  | (OperationBase & { type: 'file.write'; path: string; hash: string; size: number })
  | (OperationBase & { type: 'file.patch'; path: string; oldText: string; newText: string; hash: string; size: number })
  | (OperationBase & { type: 'file.rename'; fromPath: string; toPath: string })
  | (OperationBase & { type: 'file.delete'; path: string });

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
  return parts.join('/');
};

const sha256Hex = async (content: string): Promise<string> => {
  const bytes = new TextEncoder().encode(content);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

const emptyManifest = (workspaceId: string): Manifest => ({ workspaceId, seq: 0, files: {} });

const extractToken = (request: Request): string => {
  const url = new URL(request.url);
  const bearer = request.headers
    .get('authorization')
    ?.match(/^Bearer\s+(.+)$/i)?.[1]
    ?.trim();
  const token = bearer || url.searchParams.get('token')?.trim();
  if (!token) throw new Error('missing authorization token');
  return token;
};

const hashToken = async (workspaceId: string, token: string): Promise<string> => {
  const bytes = new TextEncoder().encode(`${workspaceId}:${token}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
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

export class WorkspaceRoom {
  private sessions = new Map<WebSocket, Presence>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const workspaceId = url.pathname.split('/')[3] ?? this.state.id.toString();
    try {
      await this.authorize(request, workspaceId);
      if (url.pathname.endsWith('/connect')) return this.handleConnect(request, workspaceId);
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
      if (blobMatch) return this.handleBlob(request, blobMatch[1]);
      const fileMatch = url.pathname.match(/\/files\/(.+)$/);
      if (fileMatch) return this.handleFile(request, workspaceId, fileMatch[1]);
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
    if (stored !== tokenHash) throw new Error('invalid authorization token');
  }

  private async getManifest(workspaceId: string): Promise<Manifest> {
    return (await this.state.storage.get<Manifest>('manifest')) ?? emptyManifest(workspaceId);
  }

  private async putManifest(manifest: Manifest): Promise<void> {
    await this.state.storage.put('manifest', manifest);
  }

  private async getOpsSince(seq: number): Promise<Operation[]> {
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
    const body = (await request.json()) as {
      relPath?: string;
      path?: string;
      clientId?: string;
      name?: string;
      intent?: string;
      ttlMs?: number;
    };
    const relPath = normalizePath(body.relPath ?? body.path ?? '');
    if (!relPath) throw new Error('lease path is required');
    const clientId = body.clientId?.trim() || request.headers.get('x-aion-client-id') || 'http-client';
    const held = await this.getLease(relPath);
    if (held && held.clientId !== clientId) return { ok: false, reason: 'held', lease: held };
    const now = Date.now();
    const ttl = Math.max(1, Math.min(body.ttlMs ?? DEFAULT_LEASE_TTL_MS, MAX_LEASE_TTL_MS));
    const lease: FileLease = {
      relPath,
      clientId,
      name: body.name?.trim() || clientId,
      intent: body.intent?.trim(),
      acquiredAt: held?.acquiredAt ?? now,
      renewedAt: now,
      expiresAt: now + ttl,
    };
    await this.putLease(lease);
    void workspaceId;
    return { ok: true, lease, renewed: Boolean(held) };
  }

  private async releaseLease(request: Request): Promise<boolean> {
    const body = (await request.json().catch(() => ({}))) as { relPath?: string; path?: string; clientId?: string };
    const relPath = normalizePath(body.relPath ?? body.path ?? '');
    if (!relPath) throw new Error('lease path is required');
    const clientId = body.clientId?.trim() || request.headers.get('x-aion-client-id') || 'http-client';
    const held = await this.getLease(relPath);
    if (!held || held.clientId !== clientId) return false;
    await this.state.storage.delete(`lease:${relPath}`);
    this.broadcast({ kind: 'leases', leases: await this.listLeases() });
    return true;
  }

  private async assertOperationLeases(op: Operation): Promise<void> {
    for (const relPath of touchedPaths(op)) {
      // Durable Object requests are serialized, so this check is the cloud-side write gate.
      // eslint-disable-next-line no-await-in-loop
      const held = await this.getLease(relPath);
      if (held && held.clientId !== op.clientId)
        throw new Error(`file lease held by ${held.name || held.clientId}: ${relPath}`);
    }
  }

  private async acceptOperation(workspaceId: string, request: Request): Promise<Operation> {
    const incoming = (await request.json()) as Operation;
    const manifest = await this.getManifest(workspaceId);
    if (incoming.workspaceId !== workspaceId) throw new Error('workspace mismatch');
    if (incoming.baseSeq !== manifest.seq) throw new Error(`base sequence mismatch: expected ${manifest.seq}`);
    await this.assertOperationLeases(incoming);
    const accepted = { ...incoming, seq: manifest.seq + 1, createdAt: incoming.createdAt || Date.now() } as Operation;
    const next = applyOperation(manifest, accepted);
    await this.state.storage.put(`op:${String(accepted.seq).padStart(16, '0')}`, accepted);
    await this.putManifest(next);
    this.broadcast({ kind: 'op', op: accepted });
    return accepted;
  }

  private handleConnect(request: Request, workspaceId: string): Response {
    const upgrade = request.headers.get('Upgrade');
    if (upgrade !== 'websocket') return json({ ok: false, error: 'expected websocket' }, { status: 426 });
    const url = new URL(request.url);
    const clientId = url.searchParams.get('clientId') || crypto.randomUUID();
    const name = url.searchParams.get('name') || clientId;
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    const presence: Presence = { clientId, name, role: 'editor', lastSeenAt: Date.now() };
    this.sessions.set(server, presence);
    server.serializeAttachment({ clientId, name } satisfies SessionAttachment);
    server.addEventListener('close', () => this.dropSession(server));
    server.addEventListener('error', () => this.dropSession(server));
    void this.getManifest(workspaceId).then((manifest) => {
      server.send(JSON.stringify({ kind: 'hello', workspaceId, seq: manifest.seq, participants: this.participants() }));
      void this.listLeases().then((leases) => server.send(JSON.stringify({ kind: 'leases', leases })));
      this.broadcast({ kind: 'presence', participants: this.participants() });
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  private dropSession(socket: WebSocket): void {
    const presence = this.sessions.get(socket);
    this.sessions.delete(socket);
    if (presence?.clientId) void this.releaseClientLeases(presence.clientId);
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
    return [...this.sessions.values()].map((presence) => ({
      clientId: presence.clientId,
      name: presence.name,
      role: presence.role,
      lastSeenAt: now,
    }));
  }

  private broadcast(value: unknown): void {
    const message = JSON.stringify(value);
    for (const socket of this.sessions.keys()) socket.send(message);
  }

  private async handleBlob(request: Request, hashParam: string): Promise<Response> {
    const hash = normalizePath(hashParam);
    if (request.method === 'PUT') {
      const content = await request.text();
      await this.env.BLOBS.put(hash, content, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
      return json({ ok: true, hash });
    }
    if (request.method === 'GET') {
      const object = await this.env.BLOBS.get(hash);
      if (!object) return json({ ok: false, error: 'blob-not-found' }, { status: 404 });
      return new Response(object.body, { headers: { 'content-type': 'text/plain; charset=utf-8' } });
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
    if (request.method === 'PUT') {
      const content = await request.text();
      const hash = await sha256Hex(content);
      await this.env.BLOBS.put(hash, content, { httpMetadata: { contentType: 'text/plain; charset=utf-8' } });
      const clientId = request.headers.get('x-aion-client-id') || 'http-client';
      const accepted = await this.acceptOperation(
        workspaceId,
        new Request(request.url, {
          method: 'POST',
          body: JSON.stringify({
            id: crypto.randomUUID(),
            type: 'file.write',
            workspaceId,
            clientId,
            baseSeq: manifest.seq,
            createdAt: Date.now(),
            path: filePath,
            hash,
            size: content.length,
          }),
        })
      );
      return json(accepted);
    }
    return json({ ok: false, error: 'method-not-allowed' }, { status: 405 });
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

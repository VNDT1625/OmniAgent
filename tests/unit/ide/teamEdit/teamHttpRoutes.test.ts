/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createServer, request, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { admitTeamPeer, clearAllSessions, publishTeamSession } from '@/process/studio/collabServer';
import { handleTeamRequest, JoinFailureRateLimiter } from '@/process/ide/teamEdit/teamHttpRoutes';
import type { TeamSessionHost } from '@/process/ide/teamEdit/teamSessionHost';

const servers: Server[] = [];

afterEach(async () => {
  clearAllSessions();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const serve = async (host: TeamSessionHost): Promise<string> => {
  const server = createServer((req, res) => {
    const sub = new URL(req.url ?? '/', 'http://local').pathname.split('/')[2] ?? '';
    void handleTeamRequest(req, res, ['team', sub], host).then((handled) => {
      if (!handled && !res.writableEnded) res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
};

const hostStub = (): TeamSessionHost =>
  ({
    joinPeer: vi.fn(),
    leavePeer: vi.fn(),
    snapshot: vi.fn(() => ({ participants: [], leases: [], activity: [] })),
    claim: vi.fn(),
    release: vi.fn(),
    listDir: vi.fn(async () => []),
    readFile: vi.fn(async () => ({ content: '', contentHash: '' })),
    write: vi.fn(async () => ({ ok: true })),
    edit: vi.fn(async () => ({ ok: true })),
    understand: vi.fn(async () => null),
    wiki: vi.fn(async () => null),
    dbConnections: vi.fn(async () => []),
    dbQuery: vi.fn(async () => ({ columns: [], rows: [], rowCount: 0 })),
    queueStatus: vi.fn(() => ({ running: 0, pending: 0, maxConcurrent: 1, maxPending: 1 })),
  }) as unknown as TeamSessionHost;

describe('team join failure limiter', () => {
  it('caps the production tracker at 1,024 distinct clients', () => {
    const limiter = new JoinFailureRateLimiter();

    for (let client = 0; client < 1100; client += 1) {
      limiter.recordFailure(`client-${client}`, 0);
    }

    expect(limiter.trackedKeys).toBe(1024);
    expect(limiter.retryAfterMs('overflow-client', 1)).toBeGreaterThan(0);
  });

  it('bounds tracked clients and releases capacity after the oldest window expires', () => {
    const limiter = new JoinFailureRateLimiter({
      maxFailures: 5,
      maxTrackedKeys: 2,
      windowMs: 100,
    });

    limiter.recordFailure('client-a', 0);
    limiter.recordFailure('client-b', 10);

    expect(limiter.retryAfterMs('client-c', 20)).toBe(80);
    limiter.recordFailure('client-c', 20);
    expect(limiter.trackedKeys).toBe(2);

    expect(limiter.retryAfterMs('client-c', 100)).toBe(0);
    limiter.recordFailure('client-c', 100);
    expect(limiter.trackedKeys).toBe(2);
  });
});

describe('team HTTP security boundary', () => {
  it('rejects file writes when the peer token is read-only', async () => {
    const session = publishTeamSession({
      repoRoot: '/repo',
      repoName: 'repo',
      password: 'secret',
      peerCapabilities: { write: false },
    });
    const peer = admitTeamPeer(session, 'Reviewer');
    const host = hostStub();
    const baseUrl = await serve(host);

    const response = await fetch(`${baseUrl}/team/write`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: peer.token, relPath: 'a.ts', data: 'changed' }),
    });

    expect(response.status).toBe(403);
    expect(host.write).not.toHaveBeenCalled();
  });

  it('keeps database proxy access opt-in per peer token', async () => {
    const session = publishTeamSession({ repoRoot: '/repo', repoName: 'repo', password: 'secret' });
    const peer = admitTeamPeer(session, 'Developer');
    const host = hostStub();
    const baseUrl = await serve(host);

    const response = await fetch(`${baseUrl}/team/db?token=${encodeURIComponent(peer.token)}`);

    expect(response.status).toBe(403);
    expect(host.dbConnections).not.toHaveBeenCalled();
  });

  it('rate-limits repeated password failures by session and remote address', async () => {
    publishTeamSession({ repoRoot: '/repo', repoName: 'repo', password: 'correct-password' });
    const baseUrl = await serve(hostStub());

    for (let attempt = 0; attempt < 5; attempt += 1) {
      const response = await fetch(`${baseUrl}/team/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password: 'wrong-password', name: 'Attacker' }),
      });
      expect(response.status).toBe(401);
    }

    const limited = await fetch(`${baseUrl}/team/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'correct-password', name: 'Blocked' }),
    });

    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('rejects declared request bodies above the bounded payload limit', async () => {
    publishTeamSession({ repoRoot: '/repo', repoName: 'repo', password: 'secret' });
    const baseUrl = await serve(hostStub());

    const response = await fetch(`${baseUrl}/team/join`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'x'.repeat(1024 * 1024 + 1) }),
    });

    expect(response.status).toBe(413);
  });

  it('rejects chunked request bodies above the bounded payload limit', async () => {
    publishTeamSession({ repoRoot: '/repo', repoName: 'repo', password: 'secret' });
    const baseUrl = await serve(hostStub());

    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = request(`${baseUrl}/team/join`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      });
      req.on('response', (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      req.on('error', reject);
      req.write('{"password":"');
      req.write('x'.repeat(1024 * 1024 + 1));
      req.end('"}');
    });

    expect(status).toBe(413);
  });
});

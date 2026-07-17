import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';

import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  JsonPermissionRepository,
  MemoryPermissionRepository,
  PermissionStore,
} from '../../../packages/desktop/src/process/services/agentChat/permission';

const temporaryDirectories: string[] = [];
const baseScope = {
  subjectId: 'agent.leader',
  sessionId: 'session-1',
  surfaceId: 'ide',
  capabilityId: 'workspace.write',
  toolPattern: 'tomny_team_*',
};
let id = 0;
const createStore = (now: () => number = () => 1_000) =>
  new PermissionStore(new MemoryPermissionRepository(), { now, createId: () => `id-${++id}` });

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('PermissionStore authorization', () => {
  it('fails closed until an exact scoped grant exists', async () => {
    const store = createStore();
    await store.initialize();

    await expect(
      store.authorize({
        subjectId: 'agent.leader',
        sessionId: 'session-1',
        surfaceId: 'ide',
        capabilityId: 'workspace.write',
        tool: 'tomny_team_edit',
      })
    ).resolves.toEqual({ allowed: false, reason: 'no-matching-grant' });
  });

  it('consumes allow-once exactly once under concurrent requests', async () => {
    const store = createStore();
    await store.initialize();
    await store.createGrant({ scope: baseScope, effect: 'allow', lifetime: 'allow-once' });
    const request = {
      subjectId: 'agent.leader',
      sessionId: 'session-1',
      surfaceId: 'ide',
      capabilityId: 'workspace.write',
      tool: 'tomny_team_edit',
    };

    const decisions = await Promise.all([store.authorize(request), store.authorize(request)]);

    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(1);
    expect(decisions.filter((decision) => !decision.allowed)).toMatchObject([{ reason: 'consumed' }]);
  });

  it('gives an explicit deny priority over a matching allow', async () => {
    const store = createStore();
    await store.initialize();
    await store.createGrant({ scope: { ...baseScope, toolPattern: '*' }, effect: 'allow', lifetime: 'session' });
    await store.createGrant({ scope: baseScope, effect: 'deny', lifetime: 'session' });

    await expect(
      store.authorize({
        subjectId: 'agent.leader',
        sessionId: 'session-1',
        surfaceId: 'ide',
        capabilityId: 'workspace.write',
        tool: 'tomny_team_write',
      })
    ).resolves.toMatchObject({ allowed: false, reason: 'explicit-deny' });
  });

  it('rejects expired grants and supports explicit revocation', async () => {
    let timestamp = 1_000;
    const store = createStore(() => timestamp);
    await store.initialize();
    const expiring = await store.createGrant({
      scope: baseScope,
      effect: 'allow',
      lifetime: 'session',
      expiresAt: 1_100,
    });
    timestamp = 1_101;
    const request = {
      subjectId: 'agent.leader',
      sessionId: 'session-1',
      surfaceId: 'ide',
      capabilityId: 'workspace.write',
      tool: 'tomny_team_edit',
    };

    await expect(store.authorize(request)).resolves.toMatchObject({ allowed: false, reason: 'expired' });
    expect(await store.revoke(expiring.id)).toBe(true);
    expect(await store.revoke(expiring.id)).toBe(false);
  });

  it('prevents non-persistent grants from escaping their session', async () => {
    const store = createStore();
    await store.initialize();

    await expect(
      store.createGrant({ scope: { ...baseScope, sessionId: '*' }, effect: 'allow', lifetime: 'session' })
    ).rejects.toThrow('Only persistent grants may span sessions');
  });

  it('keeps a bounded structured audit without accepting arbitrary secret details', async () => {
    const store = new PermissionStore(new MemoryPermissionRepository(), {
      now: () => 1_000,
      createId: () => `id-${++id}`,
      maxAuditRecords: 2,
    });
    await store.initialize();
    const grant = await store.createGrant({ scope: baseScope, effect: 'allow', lifetime: 'session' });
    await store.authorize({
      subjectId: 'agent.leader',
      sessionId: 'session-1',
      surfaceId: 'ide',
      capabilityId: 'workspace.write',
      tool: 'tomny_team_edit',
    });
    await store.revoke(grant.id);

    const audit = await store.queryAudit();
    expect(audit).toHaveLength(2);
    expect(JSON.stringify(audit)).not.toMatch(/password|token|command|detail/i);
  });
});

describe('PermissionStore secret hygiene', () => {
  it('rejects secret-shaped values in audit identifiers', async () => {
    const store = createStore();
    await store.initialize();

    await expect(
      store.createGrant({
        scope: { ...baseScope, subjectId: 'sk-abcdefghijklmnop' },
        effect: 'allow',
        lifetime: 'session',
      })
    ).rejects.toThrow('non-secret identifier');
  });
});

describe('PermissionStore persistence failures', () => {
  it('rolls back in-memory grants when durable persistence fails', async () => {
    class FailingRepository extends MemoryPermissionRepository {
      public override async save(_state: Parameters<MemoryPermissionRepository['save']>[0]): Promise<void> {
        throw new Error('disk unavailable');
      }
    }
    const store = new PermissionStore(new FailingRepository());
    await store.initialize();

    await expect(store.createGrant({ scope: baseScope, effect: 'allow', lifetime: 'session' })).rejects.toThrow(
      'disk unavailable'
    );
    await expect(store.listGrants({ includeInactive: true })).resolves.toEqual([]);
  });
});

describe('JsonPermissionRepository integrity', () => {
  it('persists and reloads a checksum-verified snapshot', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tomny-permissions-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'permissions.json');
    const writer = new PermissionStore(new JsonPermissionRepository(filePath), { createId: () => `id-${++id}` });
    await writer.initialize();
    await writer.createGrant({ scope: baseScope, effect: 'allow', lifetime: 'session' });

    const reader = new PermissionStore(new JsonPermissionRepository(filePath));
    await reader.initialize();

    expect(await reader.listGrants()).toMatchObject([{ scope: baseScope, effect: 'allow' }]);
  });

  it('fails closed when the persisted grant snapshot is modified', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'tomny-permissions-'));
    temporaryDirectories.push(directory);
    const filePath = path.join(directory, 'permissions.json');
    const writer = new PermissionStore(new JsonPermissionRepository(filePath), { createId: () => `id-${++id}` });
    await writer.initialize();
    await writer.createGrant({ scope: baseScope, effect: 'allow', lifetime: 'session' });
    const content = await readFile(filePath, 'utf8');
    await writeFile(filePath, content.replace('workspace.write', 'workspace.read'), 'utf8');

    const reader = new PermissionStore(new JsonPermissionRepository(filePath));

    await expect(reader.initialize()).rejects.toThrow('integrity check failed');
  });
});

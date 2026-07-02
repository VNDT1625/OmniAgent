/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { createTeamSessionHost } from '@/process/ide/teamEdit/teamSessionHost';
import { createTeamRequestQueue } from '@/process/ide/teamEdit/teamRequestQueue';
import type { TeamEditService } from '@/process/ide/teamEdit/teamEditService';

const ROOT = '/repo';

const makeTeam = (): TeamEditService =>
  ({
    join: vi.fn(),
    claim: vi.fn(() => ({
      ok: true,
      renewed: false,
      lease: { relPath: 'src/a.ts', agentId: 'peer', acquiredAt: 0, renewedAt: 0, expiresAt: 1 },
    })),
    heartbeat: vi.fn(),
    release: vi.fn(() => true),
    releaseAll: vi.fn(),
    write: vi.fn(async () => ({ ok: true, bytes: 1 })),
    editReplace: vi.fn(async () => ({ ok: true, matches: 1 })),
    snapshot: vi.fn(() => ({ rootPath: ROOT, participants: [], leases: [], activity: [] })),
    reset: vi.fn(),
  }) satisfies TeamEditService;

const wait = (ms = 0): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('teamSessionHost ? queued remote work', () => {
  it('serialises host reads and writes for the same shared repo', async () => {
    const events: string[] = [];
    const host = createTeamSessionHost({
      team: makeTeam(),
      queue: createTeamRequestQueue({ maxConcurrent: 1 }),
      refreshGraph: async () => undefined,
      loadGraph: async () => null,
      loadWiki: async () => null,
      listDbConnections: async () => [],
      runDbQuery: async () => ({ columns: [], rows: [], rowCount: 0 }),
      readDir: async () => {
        events.push('tree:start');
        await wait(10);
        events.push('tree:end');
        return [{ name: 'src', isDir: true }];
      },
      readFileText: async () => {
        events.push('file:start');
        events.push('file:end');
        return 'content';
      },
    });

    const tree = host.listDir(ROOT, '');
    const file = host.readFile(ROOT, 'src/a.ts');

    await expect(Promise.all([tree, file])).resolves.toEqual([[{ name: 'src', isDir: true }], { content: 'content' }]);
    expect(events).toEqual(['tree:start', 'tree:end', 'file:start', 'file:end']);
  });

  it('queues writes behind earlier reads to keep peer changes ordered', async () => {
    const events: string[] = [];
    const team = makeTeam();
    team.write = vi.fn(async () => {
      events.push('write');
      return { ok: true, bytes: 4 };
    });
    const host = createTeamSessionHost({
      team,
      queue: createTeamRequestQueue({ maxConcurrent: 1 }),
      refreshGraph: async () => undefined,
      loadGraph: async () => null,
      loadWiki: async () => null,
      listDbConnections: async () => [],
      runDbQuery: async () => ({ columns: [], rows: [], rowCount: 0 }),
      readDir: async () => {
        events.push('read:start');
        await wait(10);
        events.push('read:end');
        return [];
      },
      readFileText: async () => '',
    });

    const read = host.listDir(ROOT, 'src');
    const write = host.write(ROOT, 'peer', 'src/a.ts', 'data');

    await expect(Promise.all([read, write])).resolves.toEqual([[], { ok: true, bytes: 4 }]);
    expect(events).toEqual(['read:start', 'read:end', 'write']);
  });

  it('surfaces queue pressure for the active repo', async () => {
    const host = createTeamSessionHost({
      team: makeTeam(),
      queue: createTeamRequestQueue({ maxConcurrent: 1 }),
      refreshGraph: async () => undefined,
      loadGraph: async () => null,
      loadWiki: async () => null,
      listDbConnections: async () => [],
      runDbQuery: async () => ({ columns: [], rows: [], rowCount: 0 }),
      readDir: () => new Promise(() => undefined),
      readFileText: async () => '',
    });

    void host.listDir(ROOT, '').catch(() => undefined);
    void host.readFile(ROOT, 'src/a.ts').catch(() => undefined);

    expect(host.queueStatus(ROOT)).toMatchObject({ running: 1, pending: 1, maxConcurrent: 1 });
  });
});

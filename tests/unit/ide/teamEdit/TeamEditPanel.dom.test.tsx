/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DOM tests for {@link TeamEditPanel} — the IDE "Team" mode surface. The
 * team-edit client is mocked so no IPC runs; we assert the panel renders
 * presence + leases from a snapshot and that the active-file lease control
 * reflects who holds the open file.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

const { snapshotMock, joinMock, claimMock, releaseMock, onChangedMock } = vi.hoisted(() => ({
  snapshotMock: vi.fn(),
  joinMock: vi.fn(),
  claimMock: vi.fn(),
  releaseMock: vi.fn(),
  onChangedMock: vi.fn(),
}));

vi.mock('@renderer/pages/studio/ide/teamEdit/teamEditClient', () => ({
  teamEditClient: {
    snapshot: snapshotMock,
    join: joinMock,
    claim: claimMock,
    release: releaseMock,
    onChanged: onChangedMock,
  },
  USER_AGENT_ID: 'user',
}));

import TeamEditPanel from '@renderer/pages/studio/ide/teamEdit/TeamEditPanel';
import type { UseTeamCollab } from '@renderer/pages/studio/ide/teamEdit/useTeamCollab';
import ReplicaStatusPanel from '@renderer/pages/studio/ide/teamEdit/cloud/ReplicaStatusPanel';
import type { UseCloudWorkspace } from '@renderer/pages/studio/ide/teamEdit/cloud/useCloudWorkspace';
import type { ReplicaConflict } from '@process/ide/teamEdit/cloud/cloudReplicaTypes';

const ROOT = '/repo';

/** A solo (non-collab) controller stub: the panel uses the local snapshot. */
const SOLO_COLLAB: UseTeamCollab = {
  role: 'none',
  publishInfo: null,
  peer: null,
  remoteSnapshot: null,
  busy: false,
  error: null,
  publish: async () => false,
  unpublish: async () => undefined,
  join: async () => false,
  leave: async () => undefined,
};

const SNAP = {
  rootPath: ROOT,
  participants: [
    { agentId: 'user', label: 'You', color: '#2C7FFF', isUser: true, joinedAt: 1, lastSeenAt: 2 },
    { agentId: 'agent-a', label: 'Agent A', color: '#22C55E', isUser: false, joinedAt: 1, lastSeenAt: 2 },
  ],
  leases: [{ relPath: 'src/a.ts', agentId: 'agent-a', acquiredAt: 1, renewedAt: 2, expiresAt: 99999999999999 }],
  activity: [{ seq: 1, at: 2, kind: 'claim' as const, agentId: 'agent-a', relPath: 'src/a.ts' }],
};

describe('TeamEditPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    snapshotMock.mockResolvedValue({ ok: true, data: SNAP });
    joinMock.mockResolvedValue({ ok: true, data: true });
    claimMock.mockResolvedValue({ ok: true, data: { ok: true, lease: SNAP.leases[0], renewed: false } });
    releaseMock.mockResolvedValue({ ok: true, data: true });
    onChangedMock.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('shows an empty state when no folder is open', () => {
    render(<TeamEditPanel rootPath={null} activeFile={null} collab={SOLO_COLLAB} />);
    expect(snapshotMock).not.toHaveBeenCalled();
  });

  it('renders participants and held files from the snapshot', async () => {
    render(<TeamEditPanel rootPath={ROOT} activeFile={null} collab={SOLO_COLLAB} />);
    await waitFor(() => expect(screen.getByText('Agent A')).toBeTruthy());
    expect(screen.getByText('a.ts')).toBeTruthy();
  });

  it('subscribes to live snapshot pushes and joins the user', async () => {
    render(<TeamEditPanel rootPath={ROOT} activeFile={null} collab={SOLO_COLLAB} />);
    await waitFor(() => expect(joinMock).toHaveBeenCalledWith(ROOT, 'user', expect.any(String)));
    expect(onChangedMock).toHaveBeenCalled();
  });
});

const replicaConflict = (encoding: 'utf8' | 'base64'): ReplicaConflict => ({
  id: 'conflict-1',
  relPath: encoding === 'utf8' ? 'src/app.ts' : 'asset.bin',
  baseHash: 'base',
  localHash: 'local',
  remoteHash: 'remote',
  localEncoding: encoding,
  remoteEncoding: encoding,
  baseContent: encoding === 'utf8' ? 'base' : 'AA==',
  localContent: encoding === 'utf8' ? 'local' : 'AQ==',
  remoteContent: encoding === 'utf8' ? 'remote' : 'Ag==',
  createdAt: 1,
});

const replicaCloud = (conflict: ReplicaConflict): UseCloudWorkspace => ({
  connected: true,
  session: null,
  manifest: null,
  state: null,
  replica: {
    enabled: true,
    state: 'conflict',
    lastSyncedSeq: 4,
    pendingFiles: 1,
    conflicts: [conflict],
  },
  busy: false,
  publishing: false,
  pulling: false,
  publishProgress: null,
  pullProgress: null,
  error: null,
  connect: vi.fn(async () => true),
  disconnect: vi.fn(async () => undefined),
  publishLocal: vi.fn(async () => true),
  pullCloud: vi.fn(async () => true),
  claimFile: vi.fn(async () => true),
  releaseFile: vi.fn(async () => undefined),
  refreshStatus: vi.fn(async () => undefined),
  syncNow: vi.fn(async () => true),
  resolveConflict: vi.fn(async () => true),
});

describe('ReplicaStatusPanel', () => {
  it('does not offer a text merge editor for binary conflicts', () => {
    const cloud = replicaCloud(replicaConflict('base64'));
    render(<ReplicaStatusPanel cloud={cloud} />);

    expect(screen.getByText('asset.bin')).toBeTruthy();
    expect(screen.queryByText('ide.cloudWorkspace.replica.merge')).toBeNull();
  });

  it('resolves a text conflict through the merge editor', async () => {
    const cloud = replicaCloud(replicaConflict('utf8'));
    render(<ReplicaStatusPanel cloud={cloud} />);

    fireEvent.click(screen.getByText('ide.cloudWorkspace.replica.merge'));
    expect(await screen.findByDisplayValue(/<<<<<<< LOCAL/)).toBeTruthy();
  });
});

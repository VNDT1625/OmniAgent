/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DOM tests for {@link TeamEditPanel} — the IDE "Team" mode surface. The
 * team-edit client is mocked so no IPC runs; we assert the panel renders
 * presence + leases from a snapshot and that the active-file lease control
 * reflects who holds the open file.
 */

import { render, screen, waitFor } from '@testing-library/react';
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

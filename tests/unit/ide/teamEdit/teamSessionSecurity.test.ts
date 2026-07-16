/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  admitTeamPeer,
  clearAllSessions,
  publishTeamSession,
  TEAM_PEER_IDLE_TTL_MS,
  teamPeerCan,
  touchTeamPeer,
} from '@/process/studio/collabServer';

describe('team collaboration session security', () => {
  afterEach(() => clearAllSessions());

  it('binds host-selected capabilities to each admitted peer token', () => {
    const session = publishTeamSession({
      repoRoot: '/repo',
      repoName: 'repo',
      password: 'strong-password',
      peerCapabilities: { write: false, database: true },
    });

    const peer = admitTeamPeer(session, 'Reviewer');

    expect(teamPeerCan(peer, 'write')).toBe(false);
    expect(teamPeerCan(peer, 'database')).toBe(true);
  });

  it('rejects peers beyond the configured bounded session capacity', () => {
    const session = publishTeamSession({ repoRoot: '/repo', repoName: 'repo', password: 'secret', maxPeers: 1 });
    admitTeamPeer(session, 'First');

    expect(() => admitTeamPeer(session, 'Second')).toThrow(/1-peer limit/);
  });

  it('expires idle peer tokens instead of retaining access indefinitely', () => {
    const session = publishTeamSession({ repoRoot: '/repo', repoName: 'repo', password: 'secret' });
    const peer = admitTeamPeer(session, 'Idle peer');
    const expiredAt = peer.lastSeenAt + TEAM_PEER_IDLE_TTL_MS + 1;

    expect(touchTeamPeer(session, peer.token, expiredAt)).toBeUndefined();
    expect(session.peers.has(peer.token)).toBe(false);
  });
});

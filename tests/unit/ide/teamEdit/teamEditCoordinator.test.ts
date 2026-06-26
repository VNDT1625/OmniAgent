/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the pure Agent Team Edit coordinator — the advisory file-lease
 * brain. Time is injected so every expiry/renewal path is deterministic.
 */

import { describe, expect, it } from 'vitest';
import {
  createTeamEditCoordinator,
  normalizeRelPath,
  type TeamEditCoordinator,
} from '@/process/ide/teamEdit/teamEditCoordinator';

/** Build a coordinator with a controllable clock + short TTL. */
const makeCoordinator = (): { c: TeamEditCoordinator; tick: (ms: number) => void; at: () => number } => {
  let clock = 1_000;
  const c = createTeamEditCoordinator({ now: () => clock, leaseTtlMs: 1_000 });
  return { c, tick: (ms) => (clock += ms), at: () => clock };
};

describe('normalizeRelPath', () => {
  it('forward-slashes, trims, and strips leading ./ and slashes', () => {
    expect(normalizeRelPath('.\\src\\a.ts')).toBe('src/a.ts');
    expect(normalizeRelPath('  /src/a.ts/  ')).toBe('src/a.ts');
    expect(normalizeRelPath('src\\nested\\b.ts')).toBe('src/nested/b.ts');
  });
});

describe('teamEditCoordinator — leases', () => {
  it('lets one agent claim a file and reports the lease', () => {
    const { c } = makeCoordinator();
    const result = c.claim('agent-a', 'src/a.ts', 'refactor');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected claim ok');
    expect(result.lease.agentId).toBe('agent-a');
    expect(result.lease.relPath).toBe('src/a.ts');
    expect(result.lease.intent).toBe('refactor');
    expect(result.renewed).toBe(false);
  });

  it('rejects a second agent claiming the same file (conflict names the holder)', () => {
    const { c } = makeCoordinator();
    c.claim('agent-a', 'src/a.ts');
    const result = c.claim('agent-b', 'src/a.ts');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected conflict');
    expect(result.reason).toBe('held');
    expect(result.lease.agentId).toBe('agent-a');
  });

  it('lets the same agent renew its own lease', () => {
    const { c, tick } = makeCoordinator();
    c.claim('agent-a', 'src/a.ts');
    tick(500);
    const result = c.claim('agent-a', 'src/a.ts', 'still editing');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.renewed).toBe(true);
    expect(result.lease.intent).toBe('still editing');
  });

  it('expires a lease after the TTL so another agent can claim it', () => {
    const { c, tick } = makeCoordinator();
    c.claim('agent-a', 'src/a.ts');
    tick(1_001); // past TTL
    const result = c.claim('agent-b', 'src/a.ts');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok after expiry');
    expect(result.lease.agentId).toBe('agent-b');
  });

  it("heartbeat renews all of an agent's leases", () => {
    const { c, tick } = makeCoordinator();
    c.claim('agent-a', 'src/a.ts');
    c.claim('agent-a', 'src/b.ts');
    tick(900);
    c.heartbeat('agent-a');
    tick(900); // 1800 total, but heartbeat reset at 900 → still alive
    expect(c.canWrite('agent-b', 'src/a.ts').allowed).toBe(false);
  });

  it('release frees a lease only for its holder', () => {
    const { c } = makeCoordinator();
    c.claim('agent-a', 'src/a.ts');
    expect(c.release('agent-b', 'src/a.ts')).toBe(false); // not the holder
    expect(c.release('agent-a', 'src/a.ts')).toBe(true);
    expect(c.canWrite('agent-b', 'src/a.ts').allowed).toBe(true);
  });

  it('releaseAll drops every lease an agent holds', () => {
    const { c } = makeCoordinator();
    c.claim('agent-a', 'src/a.ts');
    c.claim('agent-a', 'src/b.ts');
    c.claim('agent-b', 'src/c.ts');
    c.releaseAll('agent-a');
    expect(c.listLeases().map((l) => l.relPath)).toEqual(['src/c.ts']);
  });
});

describe('teamEditCoordinator — write guard', () => {
  it('canWrite allows the holder and blocks others', () => {
    const { c } = makeCoordinator();
    c.claim('agent-a', 'src/a.ts');
    expect(c.canWrite('agent-a', 'src/a.ts').allowed).toBe(true);
    const blocked = c.canWrite('agent-b', 'src/a.ts');
    expect(blocked.allowed).toBe(false);
    if (blocked.allowed) throw new Error('expected blocked');
    expect(blocked.lease.agentId).toBe('agent-a');
  });

  it('canWrite allows an unclaimed file for anyone', () => {
    const { c } = makeCoordinator();
    expect(c.canWrite('agent-a', 'src/new.ts').allowed).toBe(true);
  });

  it('noteWrite auto-acquires a lease for the writer (write implies ownership)', () => {
    const { c } = makeCoordinator();
    c.noteWrite('agent-a', 'src/a.ts', '10 bytes');
    expect(c.canWrite('agent-b', 'src/a.ts').allowed).toBe(false);
    const leases = c.listLeases();
    expect(leases).toHaveLength(1);
    expect(leases[0].agentId).toBe('agent-a');
  });
});

describe('teamEditCoordinator — presence + activity', () => {
  it('join registers a participant once and assigns a colour', () => {
    const { c } = makeCoordinator();
    const a = c.join('agent-a', 'Agent A');
    const again = c.join('agent-a', 'Agent A (renamed)');
    expect(c.listParticipants()).toHaveLength(1);
    expect(again.color).toBe(a.color);
    expect(again.label).toBe('Agent A (renamed)');
  });

  it('logs claim / write / release / conflict in the activity feed', () => {
    const { c } = makeCoordinator();
    c.claim('agent-a', 'src/a.ts');
    c.noteWrite('agent-a', 'src/a.ts');
    c.claim('agent-b', 'src/a.ts'); // conflict
    c.release('agent-a', 'src/a.ts');
    const kinds = c.listActivity().map((e) => e.kind);
    expect(kinds).toContain('claim');
    expect(kinds).toContain('write');
    expect(kinds).toContain('conflict');
    expect(kinds).toContain('release');
  });

  it('caps the activity log to maxActivity', () => {
    let clock = 0;
    const c = createTeamEditCoordinator({ now: () => clock, maxActivity: 5 });
    for (let i = 0; i < 20; i++) {
      clock += 1;
      c.claim('agent-a', `src/file${i}.ts`);
      c.release('agent-a', `src/file${i}.ts`);
    }
    expect(c.listActivity().length).toBeLessThanOrEqual(5);
  });

  it('reset clears all state', () => {
    const { c } = makeCoordinator();
    c.claim('agent-a', 'src/a.ts');
    c.reset();
    expect(c.listLeases()).toHaveLength(0);
    expect(c.listParticipants()).toHaveLength(0);
    expect(c.listActivity()).toHaveLength(0);
  });
});

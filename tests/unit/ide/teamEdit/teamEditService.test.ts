/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the Agent Team Edit service — the per-workspace coordinator wrapper
 * that performs MTUI-guarded writes and emits change snapshots. The MTUI writer
 * + clock are injected so no real CLI is spawned.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createTeamEditService,
  getTeamEditService,
  setTeamEditChangeListener,
} from '@/process/ide/teamEdit/teamEditService';
import type { MtuiResponse } from '@/process/terminal/mtuiBridge';

const ROOT = '/repo';

/** A fake MTUI writer that records calls and returns a configurable result. */
const makeWriter = (ok = true) => {
  const calls: Array<{ filePath: string; data: string }> = [];
  const writeFile = vi.fn(async (filePath: string, data: string): Promise<MtuiResponse> => {
    calls.push({ filePath, data });
    return ok ? { ok: true } : { ok: false, message: 'boom' };
  });
  return { writeFile, calls };
};

describe('teamEditService — guarded write', () => {
  it("writes through MTUI and auto-acquires the writer's lease", async () => {
    const { writeFile, calls } = makeWriter();
    const service = createTeamEditService({ writeFile });
    const result = await service.write(ROOT, 'agent-a', 'src/a.ts', 'hello');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.bytes).toBe(5);
    expect(calls).toHaveLength(1);
    expect(calls[0].data).toBe('hello');
    // The write registered a lease for agent-a.
    const snap = service.snapshot(ROOT);
    expect(snap.leases.map((l) => l.agentId)).toEqual(['agent-a']);
  });

  it('refuses a write when another agent holds the file (no MTUI call)', async () => {
    const { writeFile } = makeWriter();
    const service = createTeamEditService({ writeFile });
    service.claim(ROOT, 'agent-a', 'src/a.ts', 'editing');
    const result = await service.write(ROOT, 'agent-b', 'src/a.ts', 'overwrite');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('held');
    if (result.reason !== 'held') throw new Error('expected held');
    expect(result.lease.agentId).toBe('agent-a');
    expect(writeFile).not.toHaveBeenCalled();
  });

  it('serialises two concurrent writes to the SAME unclaimed file (TOCTOU guard)', async () => {
    // Regression: before the fix, both agents passed the sync `canWrite` check
    // (no lease yet) and the lease was only recorded AFTER the await — so both
    // writes landed and clobbered each other. Claiming SYNCHRONOUSLY before the
    // await closes the window: the second concurrent writer must be refused.
    const calls: string[] = [];
    let release1: (() => void) | null = null;
    const gate1 = new Promise<void>((r) => (release1 = r));
    const writeFile = vi.fn(async (filePath: string, data: string): Promise<MtuiResponse> => {
      // The first write blocks until we let it through, holding the lease while
      // the second concurrent write attempt runs.
      if (calls.length === 0) {
        calls.push(data);
        await gate1;
        return { ok: true };
      }
      calls.push(data);
      return { ok: true };
    });
    const service = createTeamEditService({ writeFile });

    const first = service.write(ROOT, 'agent-a', 'src/a.ts', 'from-a');
    const second = service.write(ROOT, 'agent-b', 'src/a.ts', 'from-b');
    // agent-b is refused immediately (synchronous claim conflict), before its
    // write touches MTUI.
    const secondResult = await second;
    expect(secondResult.ok).toBe(false);
    if (secondResult.ok) throw new Error('expected agent-b refused');
    expect(secondResult.reason).toBe('held');
    if (secondResult.reason !== 'held') throw new Error('expected held');
    expect(secondResult.lease.agentId).toBe('agent-a');

    release1?.();
    const firstResult = await first;
    expect(firstResult.ok).toBe(true);
    // Only agent-a's write reached MTUI; agent-b never clobbered it.
    expect(calls).toEqual(['from-a']);
  });

  it('releases a freshly-acquired lease when the write fails (no orphan lease)', async () => {
    const { writeFile } = makeWriter(false);
    const service = createTeamEditService({ writeFile });
    const result = await service.write(ROOT, 'agent-a', 'src/a.ts', 'data');
    expect(result.ok).toBe(false);
    // The failed write must not leave agent-a holding the file.
    expect(service.snapshot(ROOT).leases).toHaveLength(0);
  });

  it('keeps a PRE-EXISTING lease when a write fails (does not release what the agent already held)', async () => {
    const { writeFile } = makeWriter(false);
    const service = createTeamEditService({ writeFile });
    service.claim(ROOT, 'agent-a', 'src/a.ts', 'editing');
    const result = await service.write(ROOT, 'agent-a', 'src/a.ts', 'data');
    expect(result.ok).toBe(false);
    // The agent already held the lease before this write — keep it.
    expect(service.snapshot(ROOT).leases.map((l) => l.agentId)).toEqual(['agent-a']);
  });

  it('surfaces an MTUI write failure as an error result', async () => {
    const { writeFile } = makeWriter(false);
    const service = createTeamEditService({ writeFile });
    const result = await service.write(ROOT, 'agent-a', 'src/a.ts', 'data');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('error');
  });

  it('isolates leases per workspace root', async () => {
    const { writeFile } = makeWriter();
    const service = createTeamEditService({ writeFile });
    service.claim('/repo-a', 'agent-a', 'src/a.ts');
    // Same path, different workspace → not blocked.
    const result = await service.write('/repo-b', 'agent-b', 'src/a.ts', 'ok');
    expect(result.ok).toBe(true);
  });

  it('accepts absolute paths under the root and stores them workspace-relative', async () => {
    const { writeFile, calls } = makeWriter();
    const service = createTeamEditService({ writeFile });
    const result = await service.write(ROOT, 'agent-a', '/repo/src/deep/a.ts', 'x');
    expect(result.ok).toBe(true);
    expect(service.snapshot(ROOT).leases[0].relPath).toBe('src/deep/a.ts');
    // The MTUI writer still receives an absolute path.
    expect(calls[0].filePath.replace(/\\/g, '/')).toBe('/repo/src/deep/a.ts');
  });
});

describe('teamEditService — collaborative editReplace', () => {
  /** A fake MTUI anchor editor returning a configurable envelope. */
  const makeEditor = (envelope: MtuiResponse) => {
    const calls: Array<{ filePath: string; oldText: string; newText: string }> = [];
    const editReplace = vi.fn(async (filePath: string, oldText: string, newText: string): Promise<MtuiResponse> => {
      calls.push({ filePath, oldText, newText });
      return envelope;
    });
    return { editReplace, calls };
  };

  it('applies an anchor replace via MTUI and records the edit', async () => {
    const { editReplace, calls } = makeEditor({ ok: true, matches: 1 });
    const service = createTeamEditService({ editReplace });
    const result = await service.editReplace(ROOT, 'agent-a', 'src/a.ts', 'old', 'new');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('expected ok');
    expect(result.matches).toBe(1);
    expect(calls[0]).toMatchObject({ oldText: 'old', newText: 'new' });
    expect(service.snapshot(ROOT).leases.map((l) => l.agentId)).toEqual(['agent-a']);
  });

  it('maps a stale anchor (NO_MATCH) to reason "stale" and releases the fresh lease', async () => {
    const { editReplace } = makeEditor({ ok: false, error_type: 'NO_MATCH', message: 'Text not found' });
    const service = createTeamEditService({ editReplace });
    const result = await service.editReplace(ROOT, 'agent-a', 'src/a.ts', 'gone', 'x');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('stale');
    // A failed edit must not leave agent-a holding the file.
    expect(service.snapshot(ROOT).leases).toHaveLength(0);
  });

  it('maps an overlapping concurrent edit (CONFLICT) to reason "stale"', async () => {
    const { editReplace } = makeEditor({ ok: false, error_type: 'CONFLICT', message: 'Blocked: overlaps' });
    const service = createTeamEditService({ editReplace });
    const result = await service.editReplace(ROOT, 'agent-a', 'src/a.ts', 'beta', 'beta2');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('stale');
  });

  it('maps an ambiguous anchor (MULTIPLE_MATCHES) to reason "ambiguous"', async () => {
    const { editReplace } = makeEditor({ ok: false, error_type: 'MULTIPLE_MATCHES', message: 'Found 2 matches' });
    const service = createTeamEditService({ editReplace });
    const result = await service.editReplace(ROOT, 'agent-a', 'src/a.ts', 'x', 'y');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected failure');
    expect(result.reason).toBe('ambiguous');
  });

  it('refuses an edit when another agent holds the file (no MTUI call)', async () => {
    const { editReplace } = makeEditor({ ok: true, matches: 1 });
    const service = createTeamEditService({ editReplace });
    service.claim(ROOT, 'agent-a', 'src/a.ts', 'editing');
    const result = await service.editReplace(ROOT, 'agent-b', 'src/a.ts', 'old', 'new');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected refusal');
    expect(result.reason).toBe('held');
    expect(editReplace).not.toHaveBeenCalled();
  });

  it('lets two agents edit DIFFERENT anchors of the same file (MTUI merges; leases released between)', async () => {
    const { editReplace } = makeEditor({ ok: true, matches: 1 });
    const service = createTeamEditService({ editReplace });
    const a = await service.editReplace(ROOT, 'agent-a', 'src/a.ts', 'alpha', 'alpha2');
    expect(a.ok).toBe(true);
    service.release(ROOT, 'agent-a', 'src/a.ts');
    const b = await service.editReplace(ROOT, 'agent-b', 'src/a.ts', 'gamma', 'gamma2');
    expect(b.ok).toBe(true);
  });
});

describe('teamEditService — change notifications', () => {
  it('emits a snapshot on every mutation', async () => {
    const { writeFile } = makeWriter();
    const onChange = vi.fn();
    const service = createTeamEditService({ writeFile, onChange });
    service.join(ROOT, 'agent-a', 'Agent A');
    service.claim(ROOT, 'agent-a', 'src/a.ts');
    await service.write(ROOT, 'agent-a', 'src/a.ts', 'x');
    service.release(ROOT, 'agent-a', 'src/a.ts');
    expect(onChange).toHaveBeenCalled();
    const last = onChange.mock.calls.at(-1)?.[0];
    expect(last.rootPath).toBe(ROOT);
  });

  it('reset drops the workspace coordinator', async () => {
    const { writeFile } = makeWriter();
    const service = createTeamEditService({ writeFile });
    service.claim(ROOT, 'agent-a', 'src/a.ts');
    service.reset(ROOT);
    expect(service.snapshot(ROOT).leases).toHaveLength(0);
  });
});

describe('teamEditService — shared singleton (UI + agent plane)', () => {
  it('returns ONE instance regardless of call order vs the change listener (no split-brain)', () => {
    // Agent plane resolves the service BEFORE the bridge wires its listener
    // (the real boot-order hazard). Both must end up sharing one coordinator.
    const first = getTeamEditService();
    const events: string[] = [];
    setTeamEditChangeListener((s) => events.push(s.rootPath));
    const second = getTeamEditService();
    expect(second).toBe(first); // same instance — agent + UI see the same state

    // A mutation on the shared instance flows to the late-registered listener.
    first.claim(ROOT, 'agent-a', 'src/a.ts');
    expect(events).toContain(ROOT);
    expect(first.snapshot(ROOT).leases.map((l) => l.agentId)).toEqual(['agent-a']);
    first.reset(ROOT);
  });
});

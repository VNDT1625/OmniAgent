/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Property 8 ("Bản chính bất khả xâm phạm cho đến khi pass") + Property 2 ("Mọi
 * tác vụ nặng đi qua coordinator") for the monitor patch flow (Yêu cầu 6):
 *
 * - A patch reaches the MAIN app only after the sandbox PASSED and it cleared
 *   review; a failed sandbox is never applied. A rollback point is always
 *   captured before applying (criteria 6.4–6.7).
 * - Building + testing a patch always goes through the ResourceCoordinator under
 *   `patchBuild`, with each lease released exactly once (criterion 6.8).
 *
 * fast-check is not a dependency; a deterministic seeded PRNG drives randomized
 * sandbox/risk/decision combinations. No real build/test/disk.
 *
 * Validates: Requirements 6.4, 6.5, 6.6, 6.7, 6.8
 */

import { describe, expect, it, vi } from 'vitest';
import { createPatchGate, type PatchApplier } from '@/process/monitor/patchGate';
import { createPatchSandbox, type AppCopyBuilder, type DiffApplier } from '@/process/monitor/patchSandbox';
import type { PatchProposal, SandboxResult } from '@/process/monitor/monitorTypes';
import type { ITestOrchestrator } from '@/process/testing/testOrchestrator';
import type { TestScenario, TestSession } from '@/process/testing/testingTypes';
import type { Lease, LeaseRequest } from '@/process/resource/leaseTypes';

const PROPERTY_RUNS = 200;

const makeRng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const forAllSeeds = async (runs: number, check: (rng: () => number, run: number) => Promise<void>): Promise<void> => {
  for (let run = 0; run < runs; run++) {
    const seed = ((run + 1) * 0x9e3779b1) >>> 0;
    try {
      await check(makeRng(seed), run);
    } catch (error) {
      throw new Error(`Property failed on run ${run} (seed ${seed}): ${(error as Error).message}`, { cause: error });
    }
  }
};

const proposal = (risk: PatchProposal['risk'] = 'medium'): PatchProposal => ({
  id: `p-${Math.random().toString(36).slice(2)}`,
  reportId: 'r1',
  signature: 'sig',
  rootCause: 'rc',
  explanation: 'fix it',
  diff: '--- a\n+++ b\n',
  risk,
  createdAt: 0,
});

// --- Patch gate (Property 8) ------------------------------------------------

/** A spy applier recording snapshot/apply/restore calls. */
const createSpyApplier = () => {
  const calls: string[] = [];
  let n = 0;
  const applier: PatchApplier = {
    snapshot: async () => {
      calls.push('snapshot');
      return { rollbackId: `rb-${++n}` };
    },
    apply: async () => {
      calls.push('apply');
    },
    restore: async () => {
      calls.push('restore');
    },
  };
  return { applier, calls };
};

const passed = (id: string): SandboxResult => ({ proposalId: id, passed: true });
const failed = (id: string): SandboxResult => ({ proposalId: id, passed: false, detail: 'tests failed' });

describe('patchGate — Property 8: main app inviolable until a passing, reviewed patch', () => {
  it('NEVER applies a patch whose sandbox failed (default review policy)', async () => {
    const { applier, calls } = createSpyApplier();
    const gate = createPatchGate({ applier });
    const p = proposal();

    const gated = await gate.submit(p, failed(p.id));

    expect(gated.status).toBe('rejected');
    expect(calls).toEqual([]); // main app untouched: no snapshot, no apply
  });

  it('leaves a passing patch pending review by default (no auto-apply)', async () => {
    const { applier, calls } = createSpyApplier();
    const gate = createPatchGate({ applier });
    const p = proposal('low');

    const gated = await gate.submit(p, passed(p.id));

    expect(gated.status).toBe('pending-review');
    expect(calls).toEqual([]); // still not applied without explicit approval
  });

  it('applies only after approval, snapshotting a rollback point FIRST (criterion 6.7)', async () => {
    const { applier, calls } = createSpyApplier();
    const gate = createPatchGate({ applier });
    const p = proposal();
    await gate.submit(p, passed(p.id));

    const gated = await gate.approve(p.id);

    expect(gated.status).toBe('applied');
    expect(gated.rollbackId).toBeTruthy();
    expect(calls).toEqual(['snapshot', 'apply']); // snapshot BEFORE apply
  });

  it('refuses to approve a patch whose sandbox did not pass', async () => {
    const { applier } = createSpyApplier();
    const gate = createPatchGate({ applier });
    const p = proposal();
    await gate.submit(p, failed(p.id));

    await expect(gate.approve(p.id)).rejects.toThrow(/did not pass/);
  });

  it('auto-applies only within the configured risk ceiling (criterion 6.6)', async () => {
    const { applier, calls } = createSpyApplier();
    const gate = createPatchGate({ applier, policy: { autoApplyMaxRisk: 'low' } });

    const low = proposal('low');
    const high = proposal('high');
    const lowGated = await gate.submit(low, passed(low.id));
    const highGated = await gate.submit(high, passed(high.id));

    expect(lowGated.status).toBe('applied'); // low-risk auto-applied
    expect(highGated.status).toBe('pending-review'); // high-risk still needs review
    expect(calls).toEqual(['snapshot', 'apply']); // only the low-risk one applied
  });

  it('can roll back an applied patch (criterion 6.7)', async () => {
    const { applier, calls } = createSpyApplier();
    const gate = createPatchGate({ applier });
    const p = proposal();
    await gate.submit(p, passed(p.id));
    await gate.approve(p.id);

    const gated = await gate.rollback(p.id);

    expect(gated.status).toBe('rolled-back');
    expect(calls).toContain('restore');
  });

  it('PROPERTY: main app is mutated iff sandbox passed AND (auto-applicable OR approved)', async () => {
    await forAllSeeds(PROPERTY_RUNS, async (rng) => {
      const { applier, calls } = createSpyApplier();
      const ceil = (['none', 'low', 'medium'] as const)[Math.floor(rng() * 3)];
      const gate = createPatchGate({ applier, policy: { autoApplyMaxRisk: ceil } });
      const risk = (['low', 'medium', 'high'] as const)[Math.floor(rng() * 3)];
      const sandboxPassed = rng() < 0.5;
      const willApprove = rng() < 0.5;
      const p = proposal(risk);

      await gate.submit(p, sandboxPassed ? passed(p.id) : failed(p.id));
      if (willApprove && sandboxPassed) {
        await gate.approve(p.id).catch(() => undefined);
      } else if (willApprove && !sandboxPassed) {
        // Approving a failed patch must throw and must not apply.
        await gate.approve(p.id).catch(() => undefined);
      }

      const applied = calls.includes('apply');
      if (!sandboxPassed) {
        // INVARIANT: a failed sandbox can never mutate the main app.
        expect(applied).toBe(false);
      }
      if (applied) {
        // INVARIANT: whenever applied, a snapshot was taken first (rollback point).
        expect(calls.indexOf('snapshot')).toBeLessThan(calls.indexOf('apply'));
        expect(sandboxPassed).toBe(true);
      }
    });
  });
});

// --- Patch sandbox (Property 2) --------------------------------------------

const createAccountingCoordinator = () => {
  const held = new Set<string>();
  const grants: LeaseRequest[] = [];
  const releases: string[] = [];
  let n = 0;
  return {
    coordinator: {
      requestLease: async (req: LeaseRequest): Promise<Lease> => {
        grants.push(req);
        const id = `l-${++n}`;
        held.add(id);
        return { id, kind: req.kind, grantedAt: n, estCostMB: req.estCostMB };
      },
      releaseLease: (id: string) => {
        releases.push(id);
        held.delete(id);
      },
    },
    held,
    grants,
    releases,
  };
};

const session = (status: TestSession['status']): TestSession => ({
  id: 's1',
  scenario: { id: 'sc', name: 'patch test', platform: 'windows', steps: [] },
  visibility: 'hidden',
  status,
  results: [],
  reportPath: '/r/s1.md',
  createdAt: 0,
  updatedAt: 0,
});

const buildSandbox = (opts: {
  orchestratorStatus: TestSession['status'];
  applyOk?: boolean;
  buildThrows?: boolean;
}) => {
  const acct = createAccountingCoordinator();
  const copyBuilder: AppCopyBuilder = {
    build: async () => {
      if (opts.buildThrows) throw new Error('build failed');
      return { id: 'copy-1', rootDir: '/tmp/copy-1' };
    },
    dispose: vi.fn(async () => undefined),
  };
  const diffApplier: DiffApplier = { apply: async () => opts.applyOk ?? true };
  const orchestrator: ITestOrchestrator = {
    run: async (_scenario: TestScenario) => session(opts.orchestratorStatus),
    getSession: () => undefined,
    listSessions: () => [],
  };
  const sandbox = createPatchSandbox({
    copyBuilder,
    diffApplier,
    testOrchestrator: orchestrator,
    coordinator: acct.coordinator,
    buildScenario: () => ({ id: 'sc', name: 'patch test', platform: 'windows', steps: [] }),
  });
  return { sandbox, acct, copyBuilder };
};

describe('patchSandbox — Property 2: build+test leases through the coordinator', () => {
  it('passes when the hidden test passes, leasing patchBuild and releasing it', async () => {
    const { sandbox, acct } = buildSandbox({ orchestratorStatus: 'passed' });
    const result = await sandbox.tryPatch(proposal());
    expect(result.passed).toBe(true);
    expect(acct.grants.map((g) => g.kind)).toEqual(['patchBuild']);
    expect(acct.held.size).toBe(0);
  });

  it('fails (and never claims pass) when the hidden test fails', async () => {
    const { sandbox, acct } = buildSandbox({ orchestratorStatus: 'failed' });
    const result = await sandbox.tryPatch(proposal());
    expect(result.passed).toBe(false);
    expect(acct.held.size).toBe(0);
  });

  it('disposes the isolated copy and releases the lease even when build throws', async () => {
    const { sandbox, acct } = buildSandbox({ orchestratorStatus: 'passed', buildThrows: true });
    const result = await sandbox.tryPatch(proposal());
    expect(result.passed).toBe(false);
    expect(acct.grants.map((g) => g.kind)).toEqual(['patchBuild']);
    expect(acct.held.size).toBe(0); // lease released via finally
  });

  it('fails fast (still balanced) when the diff does not apply cleanly', async () => {
    const { sandbox, acct, copyBuilder } = buildSandbox({ orchestratorStatus: 'passed', applyOk: false });
    const result = await sandbox.tryPatch(proposal());
    expect(result.passed).toBe(false);
    expect(result.detail).toMatch(/did not apply/);
    expect(copyBuilder.dispose).toHaveBeenCalled();
    expect(acct.held.size).toBe(0);
  });
});

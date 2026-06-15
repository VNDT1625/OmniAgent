/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/workspace/workspaceOrchestrator — the engine that runs
 * several sub-agents in parallel, each on its own surface, gated by the
 * ResourceCoordinator (criterion 3.12).
 *
 * Every collaborator is injected: a fake coordinator whose `requestLease` can be
 * held to assert the concurrency gate, and fake surface runners that record
 * prepare/run/dispose and can be made to succeed, fail, or block on the abort
 * signal. The tests assert:
 *  - all surfaces are announced up-front as `queued`;
 *  - surfaces run concurrently up to the coordinator's grants and the rest wait;
 *  - leases are always released (success AND failure paths);
 *  - one surface erroring does not abort the others (isolation);
 *  - cancel() aborts in-flight surfaces and marks them `stopped`.
 */

import { describe, expect, it, vi } from 'vitest';
import { createWorkspaceOrchestrator } from '@/process/workspace/workspaceOrchestrator';
import type { ISurfaceRunner, SurfaceSpec, WorkspaceEvent } from '@/process/workspace/surfaceTypes';
import type { IResourceCoordinator } from '@/process/resource/resourceCoordinator';
import type { Lease, LeaseRequest } from '@/process/resource/leaseTypes';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/** A coordinator that grants leases immediately and counts active/peak leases. */
const immediateCoordinator = (): { coordinator: IResourceCoordinator; peak: () => number; active: () => number } => {
  let active = 0;
  let peak = 0;
  let n = 0;
  const coordinator = {
    requestLease: (_req: LeaseRequest): Promise<Lease> => {
      active += 1;
      peak = Math.max(peak, active);
      return Promise.resolve({ id: `lease-${n++}`, kind: 'agent', grantedAt: 0, estCostMB: 0 });
    },
    releaseLease: (_id: string): void => {
      active -= 1;
    },
  } as unknown as IResourceCoordinator;
  return { coordinator, peak: () => peak, active: () => active };
};

/**
 * A coordinator that grants at most `limit` leases at once; further requests
 * queue until a release frees a slot. Lets us assert the concurrency gate.
 */
const gatedCoordinator = (limit: number): IResourceCoordinator => {
  let active = 0;
  let n = 0;
  const waiters: Array<() => void> = [];
  const tryGrant = (resolve: (l: Lease) => void): void => {
    if (active < limit) {
      active += 1;
      resolve({ id: `lease-${n++}`, kind: 'agent', grantedAt: 0, estCostMB: 0 });
    } else {
      waiters.push(() => tryGrant(resolve));
    }
  };
  return {
    requestLease: (_req: LeaseRequest) => new Promise<Lease>((resolve) => tryGrant(resolve)),
    releaseLease: () => {
      active -= 1;
      const next = waiters.shift();
      if (next) next();
    },
  } as unknown as IResourceCoordinator;
};

/** A runner whose `run` resolves with a fixed answer after recording the call. */
const okRunner = (calls: string[]): ISurfaceRunner => ({
  prepare: (spec) => {
    calls.push(`prepare:${spec.kind}`);
    return Promise.resolve({ title: spec.kind, tabId: spec.kind === 'browser' ? 'tab' : undefined });
  },
  run: (spec, _prepared, ctx) => {
    calls.push(`run:${spec.kind}`);
    ctx.emit({ type: 'step', tool: 't', summary: 's' });
    ctx.emit({ type: 'observation', tool: 't', ok: true, summary: 'done' });
    return Promise.resolve({ answer: `answer:${spec.kind}`, steps: 1 });
  },
  dispose: (spec) => {
    calls.push(`dispose:${spec.kind}`);
  },
});

const browserSpec = (instruction = 'do A'): SurfaceSpec => ({ kind: 'browser', url: 'a.com', instruction, model: 'm' });
const editorSpec = (instruction = 'edit B'): SurfaceSpec => ({
  kind: 'editor',
  filePath: 'b.md',
  instruction,
  model: 'm',
});

let counter = 0;
const ids = (): (() => string) => () => `s${counter++}`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('workspaceOrchestrator', () => {
  it('announces every surface up-front and runs each runner', async () => {
    const calls: string[] = [];
    const { coordinator } = immediateCoordinator();
    const orchestrator = createWorkspaceOrchestrator({
      runners: { browser: okRunner(calls), editor: okRunner(calls) },
      coordinator,
      generateId: ids(),
    });

    const events: WorkspaceEvent[] = [];
    const result = await orchestrator.run({ runId: 'r1', surfaces: [browserSpec(), editorSpec()] }, (e) =>
      events.push(e)
    );

    // Both surfaces created, each ran, each finished.
    expect(result.ok).toBe(true);
    expect(result.surfaces).toHaveLength(2);
    expect(result.surfaces.every((s) => s.status === 'done')).toBe(true);
    expect(calls).toContain('run:browser');
    expect(calls).toContain('run:editor');

    // First two events are the up-front `surface-created` (queued) announcements.
    const created = events.filter((e) => e.type === 'surface-created');
    expect(created.length).toBeGreaterThanOrEqual(2);
    expect(events.at(-1)).toEqual({ type: 'run-complete', ok: true });
  });

  it('releases a lease for every surface, even on failure', async () => {
    const releases: string[] = [];
    let active = 0;
    let peak = 0;
    let n = 0;
    const coordinator = {
      requestLease: () => {
        active += 1;
        peak = Math.max(peak, active);
        return Promise.resolve({ id: `l${n++}`, kind: 'agent', grantedAt: 0, estCostMB: 0 });
      },
      releaseLease: (id: string) => {
        active -= 1;
        releases.push(id);
      },
    } as unknown as IResourceCoordinator;

    const failingRunner: ISurfaceRunner = {
      prepare: (spec) => Promise.resolve({ title: spec.kind }),
      run: () => Promise.reject(new Error('boom')),
    };
    const calls: string[] = [];
    const orchestrator = createWorkspaceOrchestrator({
      runners: { browser: failingRunner, editor: okRunner(calls) },
      coordinator,
      generateId: ids(),
    });

    const result = await orchestrator.run({ runId: 'r2', surfaces: [browserSpec(), editorSpec()] }, () => {});

    // The browser surface errored, the editor succeeded — run is not ok, but
    // BOTH leases were released and the editor was unaffected (isolation).
    expect(result.ok).toBe(false);
    expect(releases).toHaveLength(2);
    expect(active).toBe(0);
    expect(result.surfaces.find((s) => s.kind === 'editor')?.status).toBe('done');
    expect(result.surfaces.find((s) => s.kind === 'browser')?.status).toBe('error');
  });

  it('limits concurrency to the coordinator budget (gate)', async () => {
    // Gate of 1 → surfaces run one at a time even though three are requested.
    const coordinator = gatedCoordinator(1);
    let active = 0;
    let peak = 0;
    const blockingRunner: ISurfaceRunner = {
      prepare: (spec) => Promise.resolve({ title: spec.kind }),
      run: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((r) => setTimeout(r, 5));
        active -= 1;
        return { answer: 'ok', steps: 0 };
      },
    };
    const orchestrator = createWorkspaceOrchestrator({
      runners: { browser: blockingRunner, editor: blockingRunner },
      coordinator,
      generateId: ids(),
    });

    await orchestrator.run({ runId: 'r3', surfaces: [browserSpec(), editorSpec(), browserSpec()] }, () => {});
    expect(peak).toBe(1);
  });

  it('runs surfaces in parallel when the budget allows', async () => {
    const coordinator = gatedCoordinator(3);
    let active = 0;
    let peak = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const blockingRunner: ISurfaceRunner = {
      prepare: (spec) => Promise.resolve({ title: spec.kind }),
      run: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await gate; // hold all three until released, so they overlap
        active -= 1;
        return { answer: 'ok', steps: 0 };
      },
    };
    const orchestrator = createWorkspaceOrchestrator({
      runners: { browser: blockingRunner, editor: blockingRunner },
      coordinator,
      generateId: ids(),
    });

    const runPromise = orchestrator.run(
      { runId: 'r4', surfaces: [browserSpec(), editorSpec(), browserSpec()] },
      () => {}
    );
    // Let all three reach the gate, then release.
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(peak).toBe(3);
    release();
    await runPromise;
  });

  it('cancel() aborts in-flight surfaces and marks them stopped', async () => {
    const coordinator = gatedCoordinator(3);
    const cancellableRunner: ISurfaceRunner = {
      prepare: (spec) => Promise.resolve({ title: spec.kind }),
      run: (_spec, _prepared, ctx) =>
        new Promise((resolve) => {
          ctx.signal.addEventListener('abort', () => resolve({ answer: '', steps: 0 }));
        }),
    };
    const orchestrator = createWorkspaceOrchestrator({
      runners: { browser: cancellableRunner, editor: cancellableRunner },
      coordinator,
      generateId: ids(),
    });

    const runPromise = orchestrator.run({ runId: 'r5', surfaces: [browserSpec(), editorSpec()] }, () => {});
    await new Promise<void>((r) => setTimeout(r, 5));
    orchestrator.cancel('r5');
    const result = await runPromise;
    expect(result.surfaces.every((s) => s.status === 'stopped')).toBe(true);
  });
});

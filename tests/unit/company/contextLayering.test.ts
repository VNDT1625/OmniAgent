/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Property + unit tests for process/company/contextLayering — Property 7
 * ("CLI không giữ trí nhớ"): memory lives ONLY in files; worker ("tay chân")
 * agents have no persistent state outside the injected context. The
 * ContextLayering instance must store NO per-worker state, return fully
 * detached (deep-cloned) delegation payloads, render reproducibly from injected
 * inputs only, and refuse to delegate without an explicit division context.
 *
 * fast-check is not a dependency of this repo, so the universal invariants are
 * exercised with a deterministic seeded PRNG + randomized loops (reproducible:
 * each failure reports its run index and seed).
 *
 * Validates: Requirements 3.3, 3.4, 3.9
 */

import { describe, expect, it } from 'vitest';
import type {
  CompanyContext,
  DelegationRequest,
  DivisionContext,
  DivisionContextInput,
  SharedItem,
} from '@/process/company/contextLayering';
import { ContextLayering } from '@/process/company/contextLayering';

// --- Deterministic property-testing harness (no external deps) -------------

/** Number of randomized cases per property. */
const PROPERTY_RUNS = 200;

/** mulberry32 — a small, fast, deterministic PRNG seeded by a single integer. */
const makeRng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Run `check` over many deterministic seeds. On the first failing case the
 * original assertion error is re-thrown with the run index and seed attached so
 * the counterexample is reproducible.
 */
const forAllSeeds = (runs: number, check: (rng: () => number, run: number) => void): void => {
  for (let run = 0; run < runs; run++) {
    const seed = ((run + 1) * 0x9e3779b1) >>> 0;
    try {
      check(makeRng(seed), run);
    } catch (error) {
      throw new Error(`Property failed on run ${run} (seed ${seed}): ${(error as Error).message}`, { cause: error });
    }
  }
};

// --- Generators ------------------------------------------------------------

const randInt = (rng: () => number, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));

const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789 -_/.\n:éàç中文';

const randString = (rng: () => number, maxLen = 10): string => {
  const len = randInt(rng, 0, maxLen);
  let out = '';
  for (let i = 0; i < len; i++) {
    out += ALPHABET[randInt(rng, 0, ALPHABET.length - 1)];
  }
  return out;
};

const genSharedItems = (rng: () => number): SharedItem[] => {
  const count = randInt(rng, 0, 4);
  const items: SharedItem[] = [];
  for (let i = 0; i < count; i++) {
    items.push({ key: `k${i}-${randString(rng, 6)}`, value: randString(rng, 12) });
  }
  return items;
};

const genCompanyContext = (rng: () => number): CompanyContext => {
  const ruleCount = randInt(rng, 0, 4);
  const rules: string[] = [];
  for (let i = 0; i < ruleCount; i++) rules.push(randString(rng, 16));
  return { rules, sharedItems: genSharedItems(rng) };
};

const genDivisionInput = (rng: () => number): DivisionContextInput => ({
  name: `Division-${randString(rng, 6)}`,
  headAgentId: `head-${randInt(rng, 0, 9999)}`,
  items: genSharedItems(rng),
});

/** Build a fresh instance seeded with one company context and N unique divisions. */
const genPopulated = (rng: () => number): { instance: ContextLayering; divisionIds: string[] } => {
  const instance = new ContextLayering();
  instance.setCompanyContext(genCompanyContext(rng));
  const divisionCount = randInt(rng, 1, 5);
  const divisionIds: string[] = [];
  for (let i = 0; i < divisionCount; i++) {
    const divisionId = `div-${i}`;
    instance.setDivisionContext(divisionId, genDivisionInput(rng));
    divisionIds.push(divisionId);
  }
  return { instance, divisionIds };
};

/** Worker ids deliberately include awkward values a real orchestrator might pass. */
const genWorkerId = (rng: () => number): string => {
  const specials = ['', ' ', 'worker', 'tay-chân', '../escape', '🤖', 'a/b\\c', 'DROP TABLE'];
  return rng() < 0.4 ? specials[randInt(rng, 0, specials.length - 1)] : `worker-${randInt(rng, 0, 100000)}`;
};

/** Snapshot of every piece of retrievable state on the instance. */
const snapshotState = (
  instance: ContextLayering
): { company: CompanyContext; divisions: Array<[string, DivisionContext | undefined]> } => ({
  company: instance.getCompanyContext(),
  divisions: instance.listDivisions().map((id) => [id, instance.getDivisionContext(id)]),
});

// --- Property 7 ------------------------------------------------------------

describe('ContextLayering — Property 7: CLI không giữ trí nhớ (Requirements 3.3, 3.4, 3.9)', () => {
  describe('the returned delegation payload is fully detached from instance state', () => {
    it('mutating the returned company/division/mailbox never changes stored context', () => {
      forAllSeeds(PROPERTY_RUNS, (rng) => {
        const { instance, divisionIds } = genPopulated(rng);
        const divisionId = divisionIds[randInt(rng, 0, divisionIds.length - 1)];

        const before = snapshotState(instance);
        const payload = instance.buildDelegationContext({
          divisionId,
          taskPrompt: randString(rng, 20),
          toAgentId: genWorkerId(rng),
        });

        // The snapshot handed out must equal what is stored at build time.
        expect(payload.company).toEqual(before.company);
        expect(payload.division).toEqual(instance.getDivisionContext(divisionId));

        // Aggressively mutate every reachable part of the returned payload.
        payload.company.rules.push('INJECTED RULE');
        payload.company.sharedItems.push({ key: 'injected', value: 'x' });
        if (payload.company.sharedItems.length > 0) payload.company.sharedItems[0].value = 'TAMPERED';
        payload.division.name = 'TAMPERED NAME';
        payload.division.headAgentId = 'TAMPERED HEAD';
        payload.division.items.push({ key: 'injected', value: 'x' });
        if (payload.division.items.length > 0) payload.division.items[0].key = 'TAMPERED KEY';
        payload.taskPrompt = 'TAMPERED TASK';
        payload.renderedPrompt = 'TAMPERED RENDER';
        payload.mailbox.content = 'TAMPERED CONTENT';
        payload.mailbox.toAgentId = 'TAMPERED WORKER';

        // Stored state must be byte-for-byte unchanged (deep-clone invariant).
        expect(snapshotState(instance)).toEqual(before);
      });
    });
  });

  describe('the instance holds no per-worker state', () => {
    it('delegating to arbitrary workers never mutates the divisions or company layer', () => {
      forAllSeeds(PROPERTY_RUNS, (rng) => {
        const { instance, divisionIds } = genPopulated(rng);
        const before = snapshotState(instance);

        const delegationCount = randInt(rng, 1, 15);
        for (let i = 0; i < delegationCount; i++) {
          const divisionId = divisionIds[randInt(rng, 0, divisionIds.length - 1)];
          instance.buildDelegationContext({ divisionId, taskPrompt: randString(rng, 20), toAgentId: genWorkerId(rng) });
        }

        // No new divisions appeared; existing contexts untouched; company untouched.
        expect(snapshotState(instance)).toEqual(before);
        // There is no per-worker retrieval API — the only listing is by division.
        expect(instance.listDivisions().toSorted()).toEqual([...divisionIds].toSorted());
      });
    });

    it('across an interleaved op sequence, retrievable state changes ONLY via set* methods', () => {
      forAllSeeds(PROPERTY_RUNS, (rng) => {
        const instance = new ContextLayering();
        // Parallel reference model: the only state we expect to be observable.
        let modelCompany: CompanyContext = { rules: [], sharedItems: [] };
        instance.setCompanyContext(modelCompany);
        const modelDivisions = new Map<string, DivisionContext>();

        const ops = randInt(rng, 5, 20);
        for (let i = 0; i < ops; i++) {
          const choice = rng();
          if (choice < 0.45 && modelDivisions.size > 0) {
            // delegate: must NOT change any retrievable state
            const ids = [...modelDivisions.keys()];
            const divisionId = ids[randInt(rng, 0, ids.length - 1)];
            instance.buildDelegationContext({
              divisionId,
              taskPrompt: randString(rng, 20),
              toAgentId: genWorkerId(rng),
            });
          } else if (choice < 0.7) {
            // explicit company change
            modelCompany = genCompanyContext(rng);
            instance.setCompanyContext(modelCompany);
          } else {
            // explicit division change (new or overwrite an existing id from a small pool)
            const divisionId = `d${randInt(rng, 0, 4)}`;
            const input = genDivisionInput(rng);
            instance.setDivisionContext(divisionId, input);
            modelDivisions.set(divisionId, { divisionId, ...input });
          }

          // After every op the instance must match the model exactly.
          expect(instance.getCompanyContext()).toEqual(modelCompany);
          expect(instance.listDivisions()).toEqual([...modelDivisions.keys()]);
          for (const [id, ctx] of modelDivisions) {
            expect(instance.getDivisionContext(id)).toEqual(ctx);
          }
        }
      });
    });
  });

  describe('worker context is reproducible purely from injected inputs', () => {
    it('same company + division + taskPrompt yields an identical renderedPrompt', () => {
      forAllSeeds(PROPERTY_RUNS, (rng) => {
        const { instance, divisionIds } = genPopulated(rng);
        const divisionId = divisionIds[randInt(rng, 0, divisionIds.length - 1)];
        const taskPrompt = randString(rng, 20);

        const first = instance.buildDelegationContext({ divisionId, taskPrompt });
        const second = instance.buildDelegationContext({ divisionId, taskPrompt });

        expect(second.renderedPrompt).toBe(first.renderedPrompt);
        expect(second.mailbox.content).toBe(first.mailbox.content);
      });
    });

    it('intervening delegations do not leak into a later identical delegation', () => {
      forAllSeeds(PROPERTY_RUNS, (rng) => {
        const { instance, divisionIds } = genPopulated(rng);
        const divisionId = divisionIds[randInt(rng, 0, divisionIds.length - 1)];
        const taskPrompt = randString(rng, 20);

        const baseline = instance.buildDelegationContext({ divisionId, taskPrompt }).renderedPrompt;

        // Fire several unrelated delegations (different divisions/tasks/workers).
        const noise = randInt(rng, 1, 10);
        for (let i = 0; i < noise; i++) {
          const otherId = divisionIds[randInt(rng, 0, divisionIds.length - 1)];
          instance.buildDelegationContext({
            divisionId: otherId,
            taskPrompt: randString(rng, 20),
            toAgentId: genWorkerId(rng),
          });
        }

        const repeat = instance.buildDelegationContext({ divisionId, taskPrompt }).renderedPrompt;
        expect(repeat).toBe(baseline);
      });
    });
  });

  describe('context must be injected, not implicit', () => {
    it('throws for an unknown division id', () => {
      forAllSeeds(PROPERTY_RUNS, (rng) => {
        const { instance, divisionIds } = genPopulated(rng);
        const unknownId = `unknown-${randInt(rng, 0, 1000000)}`;
        // Guard against an astronomically unlikely collision with a generated id.
        if (divisionIds.includes(unknownId)) return;

        const req: DelegationRequest = { divisionId: unknownId, taskPrompt: randString(rng, 10) };
        expect(() => instance.buildDelegationContext(req)).toThrow(/unknown division/);
      });
    });
  });
});

// --- Example-based unit tests (concrete, human-readable guards) -------------

describe('ContextLayering — example-based unit tests', () => {
  const seedInstance = (): ContextLayering => {
    const instance = new ContextLayering();
    instance.setCompanyContext({
      rules: ['Every plan reviewed by System Architect'],
      sharedItems: [{ key: 'repo-url', value: 'https://example.com/repo' }],
    });
    instance.setDivisionContext('frontend', {
      name: 'Frontend',
      headAgentId: 'fe-head',
      items: [{ key: 'framework', value: 'react' }],
    });
    return instance;
  };

  it('composes company rules, shared knowledge, division context and the task into the rendered prompt', () => {
    const instance = seedInstance();

    const { renderedPrompt, mailbox, division } = instance.buildDelegationContext({
      divisionId: 'frontend',
      taskPrompt: 'Build the login page',
      toAgentId: 'worker-1',
    });

    expect(renderedPrompt).toContain('Every plan reviewed by System Architect');
    expect(renderedPrompt).toContain('repo-url: https://example.com/repo');
    expect(renderedPrompt).toContain('Division Context: Frontend (frontend)');
    expect(renderedPrompt).toContain('framework: react');
    expect(renderedPrompt).toContain('Build the login page');
    expect(mailbox.content).toBe(renderedPrompt);
    expect(mailbox.toAgentId).toBe('worker-1');
    // Sender defaults to the division head when not provided.
    expect(mailbox.fromAgentId).toBe(division.headAgentId);
  });

  it('mutating a returned payload does not corrupt the stored division context', () => {
    const instance = seedInstance();

    const payload = instance.buildDelegationContext({ divisionId: 'frontend', taskPrompt: 'task' });
    payload.division.items[0].value = 'vue';
    payload.company.rules.push('hacked');

    expect(instance.getDivisionContext('frontend')?.items[0].value).toBe('react');
    expect(instance.getCompanyContext().rules).toEqual(['Every plan reviewed by System Architect']);
  });

  it('does not register any division as a side effect of delegating to a worker', () => {
    const instance = seedInstance();

    instance.buildDelegationContext({ divisionId: 'frontend', taskPrompt: 'task', toAgentId: 'ephemeral-worker' });

    expect(instance.listDivisions()).toEqual(['frontend']);
    // There is no API to retrieve worker state; the worker id leaves no trace.
    expect(instance.getDivisionContext('ephemeral-worker')).toBeUndefined();
  });

  it('throws when delegating to a division that was never injected', () => {
    const instance = new ContextLayering();

    expect(() => instance.buildDelegationContext({ divisionId: 'backend', taskPrompt: 'task' })).toThrow(
      /unknown division 'backend'/
    );
  });
});

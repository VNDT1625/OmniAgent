/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit + property tests for process/company/callTemplate — the self-recovering
 * CLI call template for the agent-company model (Requirement 3, criteria 3.6 &
 * 3.7). Both side-effecting collaborators (the CLI `probe` and the persistence
 * `store`) are injected with in-memory fakes, so no real disk or CLI is touched.
 *
 * The headline invariant exercised here is Property 9 ("Mẫu gọi tự phục hồi"):
 * when a locked template's runner fails, the manager MUST re-probe the CLI,
 * update + persist (overwrite) the fresh template, and only THEN retry / surface
 * the error. fast-check is not a project dependency, so the property is covered
 * by exhaustive boolean enumeration plus a deterministic seeded-random fuzz loop.
 */

import { describe, expect, it } from 'vitest';
import type {
  AssembledCall,
  CallTemplate,
  ICallTemplateStore,
  PromptShape,
  TemplateFixed,
  TemplateProbeFn,
} from '@/process/company/callTemplate';
import { CallTemplateError, createCallTemplateManager } from '@/process/company/callTemplate';

const KEY = 'acme/agents/president';

/** Ordered log of side effects so tests can assert the recovery sequence. */
type RecordedEvent =
  | { type: 'load'; key: string }
  | { type: 'save'; key: string; template: CallTemplate }
  | { type: 'probe'; key: string }
  | { type: 'run'; call: AssembledCall };

const makeFixed = (command: string, overrides?: Partial<TemplateFixed>): TemplateFixed => ({
  command,
  args: ['--fixed'],
  env: { TOKEN: 'secret' },
  probedAt: 1000,
  ...overrides,
});

const argShape: PromptShape = { delivery: 'arg', argTemplate: ['--prompt', '{{PROMPT}}'], placeholder: '{{PROMPT}}' };
const stdinShape: PromptShape = { delivery: 'stdin', argTemplate: [], placeholder: '' };

const makeTemplate = (
  command: string,
  promptShape: PromptShape = argShape,
  fixedOverrides?: Partial<TemplateFixed>
): CallTemplate => ({
  fixed: makeFixed(command, fixedOverrides),
  promptShape,
});

/**
 * In-memory {@link ICallTemplateStore} that records every load/save in the
 * shared event log and keeps the persisted templates for inspection.
 */
const makeStore = (
  events: RecordedEvent[],
  seed?: Record<string, CallTemplate>
): { store: ICallTemplateStore; map: Map<string, CallTemplate>; saved: CallTemplate[] } => {
  const map = new Map<string, CallTemplate>(seed ? Object.entries(seed) : []);
  const saved: CallTemplate[] = [];
  const store: ICallTemplateStore = {
    async load(key) {
      events.push({ type: 'load', key });
      return map.get(key);
    },
    async save(key, template) {
      events.push({ type: 'save', key, template });
      saved.push(template);
      map.set(key, template);
    },
  };
  return { store, map, saved };
};

const indexOfEvent = (events: RecordedEvent[], predicate: (e: RecordedEvent) => boolean): number =>
  events.findIndex(predicate);

describe('createCallTemplateManager — getOrProbe', () => {
  it('probes, persists, then caches on first use of an unseen key', async () => {
    const events: RecordedEvent[] = [];
    const { store, saved } = makeStore(events);
    const probed = makeTemplate('cli-probed');
    let probeCount = 0;
    const probe: TemplateProbeFn = async (key) => {
      probeCount += 1;
      events.push({ type: 'probe', key });
      return { fixed: probed.fixed, promptShape: probed.promptShape };
    };
    const manager = createCallTemplateManager({ probe, store });

    const first = await manager.getOrProbe(KEY);

    expect(first.fixed.command).toBe('cli-probed');
    expect(probeCount).toBe(1);
    expect(saved).toHaveLength(1);
    expect(saved[0].fixed.command).toBe('cli-probed');
    // load happened before probe, probe before save (persist).
    expect(indexOfEvent(events, (e) => e.type === 'load')).toBeLessThan(
      indexOfEvent(events, (e) => e.type === 'probe')
    );
    expect(indexOfEvent(events, (e) => e.type === 'probe')).toBeLessThan(
      indexOfEvent(events, (e) => e.type === 'save')
    );
  });

  it('returns the cached template without re-probing or re-loading on the second call', async () => {
    const events: RecordedEvent[] = [];
    const { store } = makeStore(events);
    let probeCount = 0;
    const probe: TemplateProbeFn = async (key) => {
      probeCount += 1;
      events.push({ type: 'probe', key });
      return { fixed: makeFixed('cli-probed'), promptShape: argShape };
    };
    const manager = createCallTemplateManager({ probe, store });

    await manager.getOrProbe(KEY);
    const eventCountAfterFirst = events.length;
    await manager.getOrProbe(KEY);

    expect(probeCount).toBe(1);
    expect(events).toHaveLength(eventCountAfterFirst);
  });

  it('prefers an already-persisted template over probing', async () => {
    const events: RecordedEvent[] = [];
    const persisted = makeTemplate('cli-persisted');
    const { store, saved } = makeStore(events, { [KEY]: persisted });
    let probeCount = 0;
    const probe: TemplateProbeFn = async (key) => {
      probeCount += 1;
      events.push({ type: 'probe', key });
      return { fixed: makeFixed('cli-fresh'), promptShape: argShape };
    };
    const manager = createCallTemplateManager({ probe, store });

    const template = await manager.getOrProbe(KEY);

    expect(template.fixed.command).toBe('cli-persisted');
    expect(probeCount).toBe(0);
    expect(saved).toHaveLength(0);
  });

  it('deduplicates concurrent first-time resolutions into a single probe', async () => {
    const events: RecordedEvent[] = [];
    const { store, saved } = makeStore(events);
    let probeCount = 0;
    const probe: TemplateProbeFn = async (key) => {
      probeCount += 1;
      events.push({ type: 'probe', key });
      await Promise.resolve();
      return { fixed: makeFixed('cli-probed'), promptShape: argShape };
    };
    const manager = createCallTemplateManager({ probe, store });

    const [a, b] = await Promise.all([manager.getOrProbe(KEY), manager.getOrProbe(KEY)]);

    expect(probeCount).toBe(1);
    expect(saved).toHaveLength(1);
    expect(a).toBe(b);
  });
});

describe('createCallTemplateManager — buildCall splices the prompt per promptShape', () => {
  it("appends the spliced prompt args for delivery 'arg'", async () => {
    const events: RecordedEvent[] = [];
    const { store } = makeStore(events, { [KEY]: makeTemplate('cli', argShape) });
    const probe: TemplateProbeFn = async () => ({ fixed: makeFixed('unused'), promptShape: argShape });
    const manager = createCallTemplateManager({ probe, store });

    const call = await manager.buildCall(KEY, 'do the thing');

    expect(call.command).toBe('cli');
    expect(call.args).toEqual(['--fixed', '--prompt', 'do the thing']);
    expect(call.stdin).toBeUndefined();
  });

  it("routes the prompt to stdin and leaves args untouched for delivery 'stdin'", async () => {
    const events: RecordedEvent[] = [];
    const { store } = makeStore(events, { [KEY]: makeTemplate('cli', stdinShape) });
    const probe: TemplateProbeFn = async () => ({ fixed: makeFixed('unused'), promptShape: stdinShape });
    const manager = createCallTemplateManager({ probe, store });

    const call = await manager.buildCall(KEY, 'piped prompt');

    expect(call.args).toEqual(['--fixed']);
    expect(call.stdin).toBe('piped prompt');
  });

  it('splices the prompt literally, never as a regexp replacement pattern', async () => {
    const events: RecordedEvent[] = [];
    const { store } = makeStore(events, { [KEY]: makeTemplate('cli', argShape) });
    const probe: TemplateProbeFn = async () => ({ fixed: makeFixed('unused'), promptShape: argShape });
    const manager = createCallTemplateManager({ probe, store });

    const call = await manager.buildCall(KEY, 'use $& and $1 verbatim');

    expect(call.args).toEqual(['--fixed', '--prompt', 'use $& and $1 verbatim']);
  });

  it('does not mutate the locked fixed config when assembling a call', async () => {
    const events: RecordedEvent[] = [];
    const locked = makeTemplate('cli', argShape);
    const { store } = makeStore(events, { [KEY]: locked });
    const probe: TemplateProbeFn = async () => ({ fixed: makeFixed('unused'), promptShape: argShape });
    const manager = createCallTemplateManager({ probe, store });

    const call = await manager.buildCall(KEY, 'hello');

    expect(call.args).not.toBe(locked.fixed.args);
    expect(locked.fixed.args).toEqual(['--fixed']);
    expect(call.env).not.toBe(locked.fixed.env);
  });
});

describe('createCallTemplateManager — runWithRecovery (Property 9: Mẫu gọi tự phục hồi)', () => {
  it('runs the locked template directly and never recovers when the first run succeeds', async () => {
    const events: RecordedEvent[] = [];
    const { store, saved } = makeStore(events, { [KEY]: makeTemplate('cli-locked') });
    let probeCount = 0;
    const probe: TemplateProbeFn = async (key) => {
      probeCount += 1;
      events.push({ type: 'probe', key });
      return { fixed: makeFixed('cli-fresh'), promptShape: argShape };
    };
    const manager = createCallTemplateManager({ probe, store });

    const result = await manager.runWithRecovery(KEY, 'go', async (call) => {
      events.push({ type: 'run', call });
      return `ran:${call.command}`;
    });

    expect(result).toBe('ran:cli-locked');
    expect(probeCount).toBe(0);
    expect(saved).toHaveLength(0);
  });

  it('re-probes and persists the fresh template before retrying — then returns the recovered result', async () => {
    const events: RecordedEvent[] = [];
    const { store, saved } = makeStore(events, { [KEY]: makeTemplate('cli-stale') });
    const probe: TemplateProbeFn = async (key) => {
      events.push({ type: 'probe', key });
      return { fixed: makeFixed('cli-fresh'), promptShape: argShape };
    };
    const manager = createCallTemplateManager({ probe, store });

    let runCount = 0;
    const result = await manager.runWithRecovery(KEY, 'go', async (call) => {
      runCount += 1;
      events.push({ type: 'run', call });
      if (runCount === 1) throw new Error('stale template failed');
      return `ran:${call.command}`;
    });

    expect(result).toBe('ran:cli-fresh');
    // The fresh, re-probed template was persisted (overwrite) before recovery completed.
    expect(saved).toHaveLength(1);
    expect(saved[0].fixed.command).toBe('cli-fresh');
    // Order: first (failing) run → probe → save(fresh) → retry run.
    const firstRun = indexOfEvent(events, (e) => e.type === 'run' && e.call.command === 'cli-stale');
    const probeAt = indexOfEvent(events, (e) => e.type === 'probe');
    const saveAt = indexOfEvent(events, (e) => e.type === 'save');
    const retryRun = indexOfEvent(events, (e) => e.type === 'run' && e.call.command === 'cli-fresh');
    expect(firstRun).toBeLessThan(probeAt);
    expect(probeAt).toBeLessThan(saveAt);
    expect(saveAt).toBeLessThan(retryRun);
  });

  it("surfaces CallTemplateError phase 'probe' and persists nothing when re-probing fails", async () => {
    const events: RecordedEvent[] = [];
    const { store, saved } = makeStore(events, { [KEY]: makeTemplate('cli-stale') });
    const probe: TemplateProbeFn = async (key) => {
      events.push({ type: 'probe', key });
      throw new Error('CLI vanished');
    };
    const manager = createCallTemplateManager({ probe, store });

    let runCount = 0;
    const promise = manager.runWithRecovery(KEY, 'go', async (call) => {
      runCount += 1;
      events.push({ type: 'run', call });
      throw new Error('stale template failed');
    });

    await expect(promise).rejects.toBeInstanceOf(CallTemplateError);
    await promise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(CallTemplateError);
      expect((error as CallTemplateError).phase).toBe('probe');
      expect((error as CallTemplateError).key).toBe(KEY);
    });
    // Re-probe failed before any persist, so the stale template was NOT overwritten.
    expect(saved).toHaveLength(0);
    expect(runCount).toBe(1);
  });

  it("surfaces CallTemplateError phase 'run' but still persists the fresh template before the error", async () => {
    const events: RecordedEvent[] = [];
    const { store, saved } = makeStore(events, { [KEY]: makeTemplate('cli-stale') });
    const probe: TemplateProbeFn = async (key) => {
      events.push({ type: 'probe', key });
      return { fixed: makeFixed('cli-fresh'), promptShape: argShape };
    };
    const manager = createCallTemplateManager({ probe, store });

    const promise = manager.runWithRecovery(KEY, 'go', async (call) => {
      events.push({ type: 'run', call });
      throw new Error(`run failed for ${call.command}`);
    });

    await expect(promise).rejects.toBeInstanceOf(CallTemplateError);
    await promise.catch((error: unknown) => {
      expect((error as CallTemplateError).phase).toBe('run');
    });
    // Persisted-overwrite-before-error: the fresh template was saved even though
    // the retry ultimately failed.
    expect(saved).toHaveLength(1);
    expect(saved[0].fixed.command).toBe('cli-fresh');
    expect(indexOfEvent(events, (e) => e.type === 'probe')).toBeLessThan(
      indexOfEvent(events, (e) => e.type === 'save')
    );
  });
});

/**
 * Property 9 — exhaustive + fuzzed. fast-check is not a project dependency, so
 * the universal claim is covered by (a) enumerating every fail/succeed
 * combination and (b) a deterministic seeded-random loop over many randomized
 * scenarios. The invariant under test: once a locked-template run fails, IF the
 * re-probe succeeds THEN the fresh template is persisted (overwrite) BEFORE the
 * retry runs or any error is surfaced.
 */
describe('createCallTemplateManager — Property 9 invariant across fail/succeed combinations', () => {
  type Scenario = { firstRunFails: boolean; probeFails: boolean; retryFails: boolean };

  /**
   * Drive one full {@link runWithRecovery} scenario against fresh fakes and
   * assert the ordering/persistence invariant for that combination.
   */
  const checkScenario = async ({ firstRunFails, probeFails, retryFails }: Scenario): Promise<void> => {
    const events: RecordedEvent[] = [];
    const { store, saved } = makeStore(events, { [KEY]: makeTemplate('cli-stale') });
    const probe: TemplateProbeFn = async (key) => {
      events.push({ type: 'probe', key });
      if (probeFails) throw new Error('probe failed');
      return { fixed: makeFixed('cli-fresh'), promptShape: argShape };
    };
    const manager = createCallTemplateManager({ probe, store });

    let runCount = 0;
    const runner = async (call: AssembledCall): Promise<string> => {
      runCount += 1;
      events.push({ type: 'run', call });
      const isFirst = runCount === 1;
      if (isFirst && firstRunFails) throw new Error('first run failed');
      if (!isFirst && retryFails) throw new Error('retry failed');
      return `ran:${call.command}`;
    };

    const saveAt = (): number => indexOfEvent(events, (e) => e.type === 'save');
    const probeAt = (): number => indexOfEvent(events, (e) => e.type === 'probe');
    const retryRunAt = (): number => events.findIndex((e, i) => e.type === 'run' && i > probeAt());

    if (!firstRunFails) {
      // No recovery path: locked template ran fine, nothing re-probed/persisted.
      const result = await manager.runWithRecovery(KEY, 'go', runner);
      expect(result).toBe('ran:cli-stale');
      expect(saved).toHaveLength(0);
      expect(probeAt()).toBe(-1);
      return;
    }

    if (probeFails) {
      // Recovery impossible: phase 'probe', and NO overwrite of the stale template.
      await expect(manager.runWithRecovery(KEY, 'go', runner)).rejects.toMatchObject({
        name: 'CallTemplateError',
        phase: 'probe',
      });
      expect(saved).toHaveLength(0);
      return;
    }

    // Re-probe succeeded → the fresh template MUST be persisted before the retry
    // runs and before any error is surfaced.
    if (retryFails) {
      await expect(manager.runWithRecovery(KEY, 'go', runner)).rejects.toMatchObject({
        name: 'CallTemplateError',
        phase: 'run',
      });
    } else {
      expect(await manager.runWithRecovery(KEY, 'go', runner)).toBe('ran:cli-fresh');
    }
    expect(saved).toHaveLength(1);
    expect(saved[0].fixed.command).toBe('cli-fresh');
    expect(probeAt()).toBeLessThan(saveAt());
    expect(saveAt()).toBeLessThan(retryRunAt());
  };

  const allScenarios: Scenario[] = [false, true].flatMap((firstRunFails) =>
    [false, true].flatMap((probeFails) =>
      [false, true].map((retryFails) => ({ firstRunFails, probeFails, retryFails }))
    )
  );

  it.each(allScenarios)('holds the persist-before-error invariant for %o', async (scenario) => {
    await checkScenario(scenario);
  });

  it('holds across a deterministic seeded-random fuzz of many scenarios', async () => {
    // mulberry32: tiny deterministic PRNG so the "property" is reproducible.
    let state = 0x9e3779b9;
    const nextBool = (): boolean => {
      state |= 0;
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296 < 0.5;
    };

    for (let i = 0; i < 200; i += 1) {
      await checkScenario({ firstRunFails: nextBool(), probeFails: nextBool(), retryFails: nextBool() });
    }
  });
});

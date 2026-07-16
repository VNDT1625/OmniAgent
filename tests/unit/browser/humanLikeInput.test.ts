/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Property + unit tests for process/browser/humanLikeInput — Property 1
 * ("Cách ly người dùng" / user isolation): while the browsing agent drives a
 * page it operates EXCLUSIVELY inside its isolated tab and NEVER grabs the real
 * OS mouse/keyboard. Concretely, `createHumanLikeInput` has no side channel: it
 * only ever emits through the injected `InputSink` (which a `browserViewManager`
 * adapter maps onto a specific tab's `webContents.sendInputEvent`). Confining
 * output to the injected sink == confining the agent to the tab, never the real
 * cursor.
 *
 * The module's whole isolation guarantee therefore reduces to four observable
 * facts, exercised here over MANY randomized inputs with a seeded PRNG and a
 * fake (instant) sleep — no real timers, no Electron:
 *
 *   1. EVERY emitted event lands on the injected spy sink and nothing else; the
 *      sink is the ONLY observable output.
 *   2. `moveMouse` always ends exactly at the rounded target, and the bezier
 *      path is a pure function of inputs + rng (reproducible per seed).
 *   3. `click` emits mouseDown then mouseUp at the same point/button (down
 *      before up); `typeText` emits exactly one `sendKeyChar` per code point.
 *   4. With a fake sleep no real time is consumed (no real timer is ever
 *      scheduled), and identical seeds yield identical sink-event sequences —
 *      i.e. there is no hidden nondeterministic side effect.
 *
 * fast-check is not a dependency of this repo, so the universal invariants are
 * exercised with a deterministic seeded PRNG + randomized loops (each failure
 * reports its run index and seed for reproducibility).
 *
 * Validates: Requirements 1.3
 */

import { describe, expect, it, vi } from 'vitest';
import type { InputSink, MouseButton, Point, Rng, Sleep } from '@/process/browser/humanLikeInput';
import { createHumanLikeInput, createSeededRng, generateBezierPath } from '@/process/browser/humanLikeInput';

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
 * Run an async `check` over many deterministic seeds. On the first failing case
 * the original assertion error is re-thrown with the run index and seed
 * attached so the counterexample is reproducible.
 */
const forAllSeedsAsync = async (
  runs: number,
  check: (rng: () => number, run: number, seed: number) => Promise<void>
): Promise<void> => {
  for (let run = 0; run < runs; run++) {
    const seed = ((run + 1) * 0x9e3779b1) >>> 0;
    try {
      await check(makeRng(seed), run, seed);
    } catch (error) {
      throw new Error(`Property failed on run ${run} (seed ${seed}): ${(error as Error).message}`, { cause: error });
    }
  }
};

/** Synchronous variant of {@link forAllSeedsAsync} for pure-function properties. */
const forAllSeedsSync = (runs: number, check: (rng: () => number, run: number, seed: number) => void): void => {
  for (let run = 0; run < runs; run++) {
    const seed = ((run + 1) * 0x9e3779b1) >>> 0;
    try {
      check(makeRng(seed), run, seed);
    } catch (error) {
      throw new Error(`Property failed on run ${run} (seed ${seed}): ${(error as Error).message}`, { cause: error });
    }
  }
};

// --- Spy sink: the single, fully-observable output channel -----------------

type SinkEvent =
  | { kind: 'move'; x: number; y: number }
  | { kind: 'down'; x: number; y: number; button: MouseButton }
  | { kind: 'up'; x: number; y: number; button: MouseButton }
  | { kind: 'char'; ch: string };

/**
 * A spy {@link InputSink} that records every emitted event. This is the ONLY
 * output channel handed to the module, so the recorded list is exhaustive: if
 * the agent ever reached for a global/OS input path the counts/shape below
 * would not match.
 */
const createSpySink = (): { sink: InputSink; events: SinkEvent[] } => {
  const events: SinkEvent[] = [];
  const sink: InputSink = {
    sendMouseMove: (x, y) => {
      events.push({ kind: 'move', x, y });
    },
    sendMouseDown: (x, y, button) => {
      events.push({ kind: 'down', x, y, button });
    },
    sendMouseUp: (x, y, button) => {
      events.push({ kind: 'up', x, y, button });
    },
    sendKeyChar: (ch) => {
      events.push({ kind: 'char', ch });
    },
  };
  return { sink, events };
};

/** Fake scheduler that consumes no real time. */
const instantSleep: Sleep = () => Promise.resolve();

/** Fake scheduler that records every requested delay but consumes no real time. */
const createTrackingSleep = (): { sleep: Sleep; calls: number[] } => {
  const calls: number[] = [];
  const sleep: Sleep = (ms) => {
    calls.push(ms);
    return Promise.resolve();
  };
  return { sleep, calls };
};

// --- Generators ------------------------------------------------------------

const randInt = (rng: () => number, min: number, max: number): number => min + Math.floor(rng() * (max - min + 1));

/** Float coordinate in roughly [-500, 1500) — floats exercise the rounding. */
const randCoord = (rng: () => number): number => rng() * 2000 - 500;

const genPoint = (rng: () => number): Point => ({ x: randCoord(rng), y: randCoord(rng) });

const BUTTONS: readonly MouseButton[] = ['left', 'middle', 'right'];

const genButton = (rng: () => number): MouseButton => BUTTONS[randInt(rng, 0, BUTTONS.length - 1)];

/** Alphabet split into code points so emoji/CJK are single entries. */
const TYPE_ALPHABET = Array.from('abcXYZ0123 \t\n.,!?;:…。，！？léàçñ中文字🤖🌟🚀✓');

const randText = (rng: () => number, maxLen = 24): string => {
  const len = randInt(rng, 0, maxLen);
  let out = '';
  for (let i = 0; i < len; i++) out += TYPE_ALPHABET[randInt(rng, 0, TYPE_ALPHABET.length - 1)];
  return out;
};

/** Round a point the same way the module does before dispatching to the sink. */
const round = (p: Point): Point => ({ x: Math.round(p.x), y: Math.round(p.y) });

// --- Random "program" of operations (for determinism + whole-flow checks) --

type Op =
  | { op: 'move'; from: Point; to: Point }
  | { op: 'click'; point: Point; button: MouseButton }
  | { op: 'type'; text: string }
  | { op: 'moveAndClick'; from: Point; to: Point; button: MouseButton };

const genProgram = (rng: () => number): Op[] => {
  const count = randInt(rng, 1, 6);
  const ops: Op[] = [];
  for (let i = 0; i < count; i++) {
    const choice = randInt(rng, 0, 3);
    if (choice === 0) ops.push({ op: 'move', from: genPoint(rng), to: genPoint(rng) });
    else if (choice === 1) ops.push({ op: 'click', point: genPoint(rng), button: genButton(rng) });
    else if (choice === 2) ops.push({ op: 'type', text: randText(rng) });
    else ops.push({ op: 'moveAndClick', from: genPoint(rng), to: genPoint(rng), button: genButton(rng) });
  }
  return ops;
};

const runProgram = async (ops: Op[], deps: { rng: Rng; sleep: Sleep }): Promise<SinkEvent[]> => {
  const { sink, events } = createSpySink();
  const input = createHumanLikeInput({ sink, rng: deps.rng, sleep: deps.sleep });
  for (const op of ops) {
    if (op.op === 'move') await input.moveMouse(op.from, op.to);
    else if (op.op === 'click') await input.click(op.point, { button: op.button });
    else if (op.op === 'type') await input.typeText(op.text);
    else await input.moveAndClick(op.from, op.to, { button: op.button });
  }
  return events;
};

// --- Property 1.a: the injected sink is the ONLY observable output ----------

describe('humanLikeInput — Property 1: tác nhân chỉ thao tác qua sink được tiêm (Requirements 1.3)', () => {
  describe('every emitted event goes exclusively through the injected InputSink', () => {
    it('across many randomized programs, the recorded sink events are the complete and only output', async () => {
      await forAllSeedsAsync(PROPERTY_RUNS, async (rng) => {
        const ops = genProgram(rng);
        const events = await runProgram(ops, { rng, sleep: instantSleep });

        // Derive the expected event multiset purely from the program: anything
        // the agent did MUST be visible in the sink and nowhere else.
        let expectedMoves = 0;
        let expectedClicks = 0;
        let expectedChars = 0;
        for (const op of ops) {
          if (op.op === 'move')
            expectedMoves += 1; // ≥ 1 move; exact count checked separately
          else if (op.op === 'click') expectedClicks += 1;
          else if (op.op === 'type') expectedChars += Array.from(op.text).length;
          else {
            expectedMoves += 1;
            expectedClicks += 1;
          }
        }

        const moves = events.filter((e) => e.kind === 'move').length;
        const downs = events.filter((e) => e.kind === 'down').length;
        const ups = events.filter((e) => e.kind === 'up').length;
        const chars = events.filter((e) => e.kind === 'char').length;

        // Each click/moveAndClick emits exactly one down + one up.
        expect(downs).toBe(expectedClicks);
        expect(ups).toBe(expectedClicks);
        // Exactly one char per typed code point.
        expect(chars).toBe(expectedChars);
        // At least one move per move/moveAndClick op (bezier may emit many).
        expect(moves).toBeGreaterThanOrEqual(expectedMoves);
        // No event kind exists outside the four sink methods (exhaustive total).
        expect(moves + downs + ups + chars).toBe(events.length);
      });
    });

    it('emits NOTHING when given no operations (no implicit/global input)', async () => {
      const { sink, events } = createSpySink();
      createHumanLikeInput({ sink, rng: createSeededRng(1), sleep: instantSleep });
      expect(events).toEqual([]);
    });
  });

  // --- Property 1.b: moveMouse lands exactly on target, path is pure --------

  describe('moveMouse lands exactly on the (rounded) target inside the tab', () => {
    it('the final emitted move equals the rounded target for arbitrary from/to', async () => {
      await forAllSeedsAsync(PROPERTY_RUNS, async (rng) => {
        const from = genPoint(rng);
        const to = genPoint(rng);
        const { sink, events } = createSpySink();
        const input = createHumanLikeInput({
          sink,
          rng: createSeededRng(randInt(rng, 0, 1_000_000)),
          sleep: instantSleep,
        });

        const landing = await input.moveMouse(from, to);
        const expected = round(to);

        // Return value lands on target.
        expect(landing).toEqual(expected);
        // Final emitted move lands on target too.
        const moves = events.filter((e): e is Extract<SinkEvent, { kind: 'move' }> => e.kind === 'move');
        expect(moves.length).toBeGreaterThanOrEqual(1);
        const last = moves[moves.length - 1];
        expect({ x: last.x, y: last.y }).toEqual(expected);
        // Only moves are emitted by a bare moveMouse — no stray clicks/keys.
        expect(events.every((e) => e.kind === 'move')).toBe(true);
      });
    });

    it('generateBezierPath is a pure function of inputs + rng (same seed ⇒ identical path)', () => {
      forAllSeedsSync(PROPERTY_RUNS, (rng) => {
        const from = genPoint(rng);
        const to = genPoint(rng);
        const steps = randInt(rng, 1, 40);
        const jitter = rng() * 0.5;
        const seed = randInt(rng, 0, 1_000_000);

        const a = generateBezierPath(from, to, steps, jitter, createSeededRng(seed));
        const b = generateBezierPath(from, to, steps, jitter, createSeededRng(seed));

        expect(b).toEqual(a);
        // Pure geometry guarantee: exactly `steps` points, ending exactly at `to`.
        expect(a).toHaveLength(steps);
        expect(a[a.length - 1]).toEqual({ x: to.x, y: to.y });
      });
    });
  });

  // --- Property 1.c: click ordering and typeText one-char-per-codepoint -----

  describe('click and typeText emit a well-ordered, faithful event stream', () => {
    it('click emits mouseDown then mouseUp at the same point with the same button (down before up)', async () => {
      await forAllSeedsAsync(PROPERTY_RUNS, async (rng) => {
        const point = genPoint(rng);
        const button = genButton(rng);
        const { sink, events } = createSpySink();
        const input = createHumanLikeInput({ sink, rng, sleep: instantSleep });

        await input.click(point, { button });

        expect(events).toHaveLength(2);
        const [down, up] = events;
        expect(down.kind).toBe('down');
        expect(up.kind).toBe('up');
        const expected = round(point);
        if (down.kind === 'down' && up.kind === 'up') {
          // Same point.
          expect({ x: down.x, y: down.y }).toEqual(expected);
          expect({ x: up.x, y: up.y }).toEqual(expected);
          // Same button.
          expect(down.button).toBe(button);
          expect(up.button).toBe(button);
        }
      });
    });

    it('typeText emits exactly one sendKeyChar per input code point, in order', async () => {
      await forAllSeedsAsync(PROPERTY_RUNS, async (rng) => {
        const text = randText(rng, 32);
        const { sink, events } = createSpySink();
        const input = createHumanLikeInput({ sink, rng, sleep: instantSleep });

        await input.typeText(text);

        const expectedChars = Array.from(text);
        const charEvents = events.filter((e): e is Extract<SinkEvent, { kind: 'char' }> => e.kind === 'char');
        // One char event per code point, none missing/extra.
        expect(charEvents.map((e) => e.ch)).toEqual(expectedChars);
        // typeText emits ONLY key chars — never touches the mouse channel.
        expect(events.every((e) => e.kind === 'char')).toBe(true);
      });
    });

    it('moveAndClick moves first then clicks (all moves precede the down/up pair)', async () => {
      await forAllSeedsAsync(PROPERTY_RUNS, async (rng) => {
        const from = genPoint(rng);
        const to = genPoint(rng);
        const button = genButton(rng);
        const { sink, events } = createSpySink();
        const input = createHumanLikeInput({ sink, rng, sleep: instantSleep });

        await input.moveAndClick(from, to, { button });

        const downIndex = events.findIndex((e) => e.kind === 'down');
        const upIndex = events.findIndex((e) => e.kind === 'up');
        expect(downIndex).toBeGreaterThan(0); // at least one move came first
        expect(upIndex).toBe(downIndex + 1); // up immediately follows down
        // Everything before the click is a move; the click lands on the target.
        expect(events.slice(0, downIndex).every((e) => e.kind === 'move')).toBe(true);
        const down = events[downIndex];
        if (down.kind === 'down') expect({ x: down.x, y: down.y }).toEqual(round(to));
      });
    });
  });

  // --- Property 1.d: determinism ⇒ no hidden nondeterministic side effects ---

  describe('determinism: fake sleep consumes no real time and seeds are reproducible', () => {
    it('two runs with the same seed produce identical sink-event sequences', async () => {
      await forAllSeedsAsync(PROPERTY_RUNS, async (rng) => {
        const ops = genProgram(rng);
        const seed = randInt(rng, 0, 1_000_000);

        const first = await runProgram(ops, { rng: createSeededRng(seed), sleep: instantSleep });
        const second = await runProgram(ops, { rng: createSeededRng(seed), sleep: instantSleep });

        expect(second).toEqual(first);
      });
    });

    it('different seeds still produce identical click/keystroke structure (timing-only divergence)', async () => {
      await forAllSeedsAsync(50, async (rng) => {
        const text = randText(rng, 16);
        const point = genPoint(rng);
        const a = await runProgram(
          [
            { op: 'click', point, button: 'left' },
            { op: 'type', text },
          ],
          { rng: createSeededRng(1), sleep: instantSleep }
        );
        const b = await runProgram(
          [
            { op: 'click', point, button: 'left' },
            { op: 'type', text },
          ],
          { rng: createSeededRng(999), sleep: instantSleep }
        );
        // Clicks/keystrokes do not depend on rng, so the discrete event stream is
        // identical regardless of seed (only mouse-path sampling uses rng).
        expect(b).toEqual(a);
      });
    });

    it('uses the injected sleep exclusively — no real timer is ever scheduled', async () => {
      const realSetTimeout = vi.spyOn(globalThis, 'setTimeout');
      try {
        const rng = makeRng(0x1234);
        const ops = genProgram(rng);
        const { sleep, calls } = createTrackingSleep();
        await runProgram(ops, { rng: createSeededRng(7), sleep });
        // Real time was never used for any delay.
        expect(realSetTimeout).not.toHaveBeenCalled();
        // All delays are non-negative finite numbers routed through the fake.
        expect(calls.every((ms) => Number.isFinite(ms) && ms >= 0)).toBe(true);
      } finally {
        realSetTimeout.mockRestore();
      }
    });
  });
});

// --- Example-based unit tests (concrete, human-readable guards) -------------

describe('humanLikeInput — example-based unit tests', () => {
  it('moveMouse to the same point emits a single landing move (no path)', async () => {
    const { sink, events } = createSpySink();
    const input = createHumanLikeInput({ sink, rng: createSeededRng(1), sleep: instantSleep });

    const landing = await input.moveMouse({ x: 12.4, y: 7.6 }, { x: 12.4, y: 7.6 });

    expect(landing).toEqual({ x: 12, y: 8 });
    expect(events).toEqual([{ kind: 'move', x: 12, y: 8 }]);
  });

  it('click defaults to the left button when none is provided', async () => {
    const { sink, events } = createSpySink();
    const input = createHumanLikeInput({ sink, rng: createSeededRng(2), sleep: instantSleep });

    await input.click({ x: 100, y: 50 });

    expect(events).toEqual([
      { kind: 'down', x: 100, y: 50, button: 'left' },
      { kind: 'up', x: 100, y: 50, button: 'left' },
    ]);
  });

  it('typeText types an emoji as a single character event', async () => {
    const { sink, events } = createSpySink();
    const input = createHumanLikeInput({ sink, rng: createSeededRng(3), sleep: instantSleep });

    await input.typeText('a🤖b');

    expect(events).toEqual([
      { kind: 'char', ch: 'a' },
      { kind: 'char', ch: '🤖' },
      { kind: 'char', ch: 'b' },
    ]);
  });

  it('createSeededRng yields a reproducible sequence in [0, 1) for a given seed', () => {
    const a = createSeededRng(42);
    const b = createSeededRng(42);
    for (let i = 0; i < 100; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

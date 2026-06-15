/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Human-like input simulation for the embedded browser agent (Requirement 1 —
 * "Tích hợp trình duyệt và tác nhân duyệt web", criterion 1.3).
 *
 * When the browsing agent drives a page it MUST "mô phỏng thao tác giống người
 * để giảm khả năng bị trang lớn chặn tự động hóa" — i.e. emit mouse moves,
 * clicks and keystrokes that look human rather than instantaneous/robotic, so
 * large sites are less likely to flag the session as automation. This module
 * provides that behaviour:
 *
 *   - **Randomized delays** between every step, click phase and keystroke.
 *   - **Bezier-curve mouse movement** — the cursor follows a jittered cubic
 *     Bezier path between two points instead of teleporting or moving in a
 *     straight line.
 *   - **Human-rhythm typing** — per-character delays drawn from a human-like
 *     distribution, with longer pauses after spaces and punctuation.
 *
 * ## Process boundary & decoupling
 *
 * This is a **Main-process (Node.js / Electron) module — no DOM APIs**. It does
 * not emit input directly; instead it calls an injected {@link InputSink} whose
 * methods map onto Electron's `webContents.sendInputEvent(...)`. The sink is an
 * interface (not a concrete `webContents`) so this module stays pure-ish and
 * unit-testable, and so `browserViewManager` (Task 6.1) can later adapt its
 * `WebContentsView.webContents` to it without this file depending on Electron.
 *
 * ## Testability & reproducibility
 *
 * Every source of non-determinism is injected (see {@link HumanLikeInputDeps}):
 *
 *   - randomness flows through a single {@link Rng} (a `() => number` in
 *     `[0, 1)`); inject {@link createSeededRng} for reproducible tests,
 *   - all delays flow through an injected {@link Sleep} scheduler, so tests can
 *     advance time instantly instead of waiting in real time,
 *   - the {@link InputSink} can be a spy that records emitted events.
 *
 * The pure path-generation helper {@link generateBezierPath} is exported so it
 * can be exercised directly in unit tests.
 *
 * @remarks
 * The sink intentionally exposes **separate** `sendMouseDown` / `sendMouseUp`
 * rather than a single "click" call: a realistic click needs a measurable gap
 * between press and release (criterion of human-like input), which a one-shot
 * click event cannot express. A `browserViewManager` adapter maps these onto
 * `webContents.sendInputEvent({ type: 'mouseDown' | 'mouseUp' | 'mouseMove', ... })`
 * and `sendKeyChar` onto a `char` keyboard event.
 */

// ---------------------------------------------------------------------------
// Public value types
// ---------------------------------------------------------------------------

/** A 2-D coordinate in the page's device-independent pixel space. */
export type Point = {
  /** Horizontal position (pixels from the left edge of the view). */
  x: number;
  /** Vertical position (pixels from the top edge of the view). */
  y: number;
};

/** Mouse button identifiers, matching Electron's `sendInputEvent` button names. */
export type MouseButton = 'left' | 'middle' | 'right';

/**
 * A deterministic-or-not random source returning a float in `[0, 1)`, exactly
 * like `Math.random`. Inject {@link createSeededRng} for reproducible runs in
 * tests; production wiring may simply pass `Math.random`.
 */
export type Rng = () => number;

/**
 * Delay primitive used for every pause. Resolves after roughly `ms`
 * milliseconds. Injected so tests can replace real waiting with an instant /
 * fake-timer implementation. Defaults to a `setTimeout`-backed sleep.
 */
export type Sleep = (ms: number) => Promise<void>;

/**
 * Abstraction over the input destination. Each method corresponds to an
 * Electron `webContents.sendInputEvent(...)` call; the interface is injected so
 * this module never hard-depends on a concrete `webContents`.
 *
 * Coordinates are passed as integer-friendly numbers; the caller rounds before
 * dispatching, so implementations receive whole pixels.
 */
export type InputSink = {
  /** Emit a mouse-move to `(x, y)` (Electron `type: 'mouseMove'`). */
  sendMouseMove(x: number, y: number): void;
  /** Emit a mouse button press at `(x, y)` (Electron `type: 'mouseDown'`). */
  sendMouseDown(x: number, y: number, button: MouseButton): void;
  /** Emit a mouse button release at `(x, y)` (Electron `type: 'mouseUp'`). */
  sendMouseUp(x: number, y: number, button: MouseButton): void;
  /** Emit a single typed character (Electron keyboard `type: 'char'`). */
  sendKeyChar(ch: string): void;
};

// ---------------------------------------------------------------------------
// Timing configuration
// ---------------------------------------------------------------------------

/** A `[min, max]` millisecond range that a delay is uniformly drawn from. */
export type DelayRange = {
  /** Lower bound (inclusive) in milliseconds. */
  minMs: number;
  /** Upper bound (inclusive) in milliseconds. */
  maxMs: number;
};

/** Tunables controlling Bezier mouse movement. */
export type MouseTimingOptions = {
  /** Minimum number of intermediate points sampled along the curve. */
  minSteps: number;
  /** Maximum number of intermediate points sampled along the curve. */
  maxSteps: number;
  /** Per-step pause range applied between consecutive mouse-move events. */
  stepDelay: DelayRange;
  /**
   * Curve "bend" factor: control points are offset off the straight line by up
   * to `curveJitter * distance` pixels on each axis. `0` yields a straight line;
   * larger values bend the path more. Sane default ~0.2.
   */
  curveJitter: number;
};

/** Tunables controlling a single click's press/release rhythm. */
export type ClickTimingOptions = {
  /** Pause before pressing the button (settling on the target). */
  preDelay: DelayRange;
  /** Gap between mouse-down and mouse-up — the realistic "press" duration. */
  pressGap: DelayRange;
  /** Pause after releasing the button before the next action. */
  postDelay: DelayRange;
};

/** Tunables controlling human-rhythm typing. */
export type TypingTimingOptions = {
  /** Base per-character keystroke interval. */
  charDelay: DelayRange;
  /** Extra pause added after a whitespace space/tab character. */
  spacePause: DelayRange;
  /** Extra pause added after a punctuation character (and newlines). */
  punctuationPause: DelayRange;
};

/**
 * Full timing configuration for human-like input. Every field has a sane
 * default (see {@link DEFAULT_HUMAN_INPUT_OPTIONS}); callers override only what
 * they need via {@link DeepPartialOptions}.
 */
export type HumanInputOptions = {
  /** Mouse-movement (Bezier) tunables. */
  mouse: MouseTimingOptions;
  /** Click press/release tunables. */
  click: ClickTimingOptions;
  /** Typing-rhythm tunables. */
  typing: TypingTimingOptions;
};

/** Shallow-per-section partial override of {@link HumanInputOptions}. */
export type DeepPartialOptions = {
  /** Partial mouse overrides merged over the defaults. */
  mouse?: Partial<MouseTimingOptions>;
  /** Partial click overrides merged over the defaults. */
  click?: Partial<ClickTimingOptions>;
  /** Partial typing overrides merged over the defaults. */
  typing?: Partial<TypingTimingOptions>;
};

/**
 * Sane default timings tuned to feel human without being sluggish. All values
 * are milliseconds except {@link MouseTimingOptions.curveJitter} (a ratio) and
 * the step counts.
 */
export const DEFAULT_HUMAN_INPUT_OPTIONS: HumanInputOptions = {
  mouse: {
    minSteps: 15,
    maxSteps: 35,
    stepDelay: { minMs: 6, maxMs: 18 },
    curveJitter: 0.2,
  },
  click: {
    preDelay: { minMs: 40, maxMs: 120 },
    pressGap: { minMs: 40, maxMs: 110 },
    postDelay: { minMs: 40, maxMs: 120 },
  },
  typing: {
    charDelay: { minMs: 45, maxMs: 140 },
    spacePause: { minMs: 60, maxMs: 180 },
    punctuationPause: { minMs: 120, maxMs: 320 },
  },
};

// ---------------------------------------------------------------------------
// Per-call option types
// ---------------------------------------------------------------------------

/** Per-call overrides for {@link IHumanLikeInput.moveMouse}. */
export type MoveMouseOptions = Partial<MouseTimingOptions>;

/** Per-call overrides for {@link IHumanLikeInput.click}. */
export type ClickOptions = Partial<ClickTimingOptions> & {
  /** Which button to click. Defaults to `'left'`. */
  button?: MouseButton;
};

/** Per-call overrides for {@link IHumanLikeInput.typeText}. */
export type TypeTextOptions = Partial<TypingTimingOptions>;

// ---------------------------------------------------------------------------
// Public contract
// ---------------------------------------------------------------------------

/**
 * Human-like input emitter. All methods are asynchronous because they interleave
 * injected {@link Sleep} pauses between the emitted {@link InputSink} events.
 */
export type IHumanLikeInput = {
  /**
   * Move the cursor from `from` to `to` along a jittered cubic-Bezier path,
   * emitting a `mouseMove` for each intermediate point with a randomized pause
   * between them.
   *
   * @param from Starting cursor position.
   * @param to   Target cursor position.
   * @param opts Optional per-call mouse-timing overrides.
   * @returns The (rounded) final point, i.e. `to` — convenient for chaining.
   */
  moveMouse(from: Point, to: Point, opts?: MoveMouseOptions): Promise<Point>;

  /**
   * Click at `point`: pre-delay → mouse-down → realistic press gap → mouse-up →
   * post-delay. The cursor is assumed to already be at (or near) `point`; use
   * {@link IHumanLikeInput.moveAndClick} to move first.
   *
   * @param point Where to click.
   * @param opts  Optional per-call click-timing overrides and button.
   */
  click(point: Point, opts?: ClickOptions): Promise<void>;

  /**
   * Type `text` one character at a time with human-rhythm delays — longer pauses
   * after spaces and punctuation.
   *
   * @param text The string to type.
   * @param opts Optional per-call typing-timing overrides.
   */
  typeText(text: string, opts?: TypeTextOptions): Promise<void>;

  /**
   * Convenience: {@link IHumanLikeInput.moveMouse} from `from` to `to`, then
   * {@link IHumanLikeInput.click} at the landing point.
   *
   * @param from Starting cursor position.
   * @param to   Target to move to and click.
   * @param opts Optional per-call click-timing overrides and button.
   */
  moveAndClick(from: Point, to: Point, opts?: ClickOptions): Promise<void>;
};

/** Dependencies for {@link createHumanLikeInput}. */
export type HumanLikeInputDeps = {
  /** Destination for emitted input events (Electron `webContents` adapter). */
  sink: InputSink;
  /** Random source. Defaults to `Math.random`. Inject a seeded RNG for tests. */
  rng?: Rng;
  /** Delay primitive. Defaults to a `setTimeout`-backed sleep. */
  sleep?: Sleep;
  /** Timing overrides merged over {@link DEFAULT_HUMAN_INPUT_OPTIONS}. */
  options?: DeepPartialOptions;
};

// ---------------------------------------------------------------------------
// Seeded RNG (mulberry32) — small, fast, reproducible
// ---------------------------------------------------------------------------

/**
 * Create a deterministic {@link Rng} from a numeric `seed` using the mulberry32
 * algorithm. The same seed always yields the same sequence, so tests that drive
 * {@link IHumanLikeInput} get reproducible mouse paths and delays.
 *
 * @param seed Any 32-bit-coercible integer.
 */
export const createSeededRng = (seed: number): Rng => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// ---------------------------------------------------------------------------
// Default scheduler
// ---------------------------------------------------------------------------

/** Default sleep: resolves after `ms` via `setTimeout` (clamped to ≥ 0). */
const defaultSleep: Sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));

// ---------------------------------------------------------------------------
// Pure geometry / math helpers
// ---------------------------------------------------------------------------

/** Linear interpolation between two points at parameter `t` in `[0, 1]`. */
const lerpPoint = (from: Point, to: Point, t: number): Point => ({
  x: from.x + (to.x - from.x) * t,
  y: from.y + (to.y - from.y) * t,
});

/** Euclidean distance between two points. */
const distance = (from: Point, to: Point): number => Math.hypot(to.x - from.x, to.y - from.y);

/**
 * Evaluate a cubic Bezier curve at parameter `t` for the four control points
 * `p0, p1, p2, p3`. Uses the standard Bernstein form.
 */
const cubicBezierAt = (p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point => {
  const u = 1 - t;
  const w0 = u * u * u;
  const w1 = 3 * u * u * t;
  const w2 = 3 * u * t * t;
  const w3 = t * t * t;
  return {
    x: w0 * p0.x + w1 * p1.x + w2 * p2.x + w3 * p3.x,
    y: w0 * p0.y + w1 * p1.y + w2 * p2.y + w3 * p3.y,
  };
};

// ---------------------------------------------------------------------------
// Public pure helper (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Generate `steps` intermediate points along a cubic Bezier curve from `from`
 * to `to`, with the two interior control points jittered off the straight line
 * by up to `curveJitter * distance` pixels on each axis (drawn from `rng`).
 *
 * The returned array has exactly `steps` points sampled at `t = i / steps` for
 * `i = 1..steps`, so the **last point is always exactly `to`**. A `steps` of `0`
 * yields an empty array; callers treat that as "already there".
 *
 * This function is pure with respect to its inputs (including `rng`), which is
 * what makes seeded runs reproducible and unit-testable.
 *
 * @param from        Curve start point (`P0`).
 * @param to          Curve end point (`P3`).
 * @param steps       Number of intermediate points to sample (≥ 0).
 * @param curveJitter Control-point offset ratio relative to the move distance.
 * @param rng         Random source in `[0, 1)` for the control-point jitter.
 * @returns Sampled points along the curve, ending exactly at `to`.
 */
export const generateBezierPath = (from: Point, to: Point, steps: number, curveJitter: number, rng: Rng): Point[] => {
  if (steps <= 0) return [];

  const dist = distance(from, to);
  const jitterMag = dist * curveJitter;
  // Symmetric jitter in [-jitterMag, jitterMag] for one axis of a control point.
  const jitter = (): number => (rng() * 2 - 1) * jitterMag;

  // Anchor the control points near the 1/3 and 2/3 marks, then bend them.
  const c1Base = lerpPoint(from, to, 1 / 3);
  const c2Base = lerpPoint(from, to, 2 / 3);
  const control1: Point = { x: c1Base.x + jitter(), y: c1Base.y + jitter() };
  const control2: Point = { x: c2Base.x + jitter(), y: c2Base.y + jitter() };

  const points: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    points.push(cubicBezierAt(from, control1, control2, to, t));
  }
  // At i === steps, t === 1 so the curve already evaluates to `to`; snap the
  // final point exactly to `to` to erase any floating-point drift.
  const lastIndex = points.length - 1;
  points[lastIndex] = { x: to.x, y: to.y };
  return points;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/** Punctuation characters that earn an extra typing pause. */
const PUNCTUATION = new Set<string>(['.', ',', '!', '?', ';', ':', '…', '·', '。', '，', '！', '？', '；', '：']);

/** Whether `ch` is a space/tab that earns the "space" pause. */
const isSpace = (ch: string): boolean => ch === ' ' || ch === '\t';

/** Whether `ch` is a newline (treated like punctuation: a longer pause). */
const isNewline = (ch: string): boolean => ch === '\n' || ch === '\r';

/** Round a point to whole pixels for dispatch to the sink. */
const roundPoint = (p: Point): Point => ({ x: Math.round(p.x), y: Math.round(p.y) });

/**
 * Merge a per-section {@link DeepPartialOptions} over a base {@link HumanInputOptions}.
 * Each section is shallow-merged, which is sufficient because section fields are
 * primitives or `{ minMs, maxMs }` ranges replaced wholesale.
 */
const mergeOptions = (base: HumanInputOptions, overrides?: DeepPartialOptions): HumanInputOptions => ({
  mouse: { ...base.mouse, ...overrides?.mouse },
  click: { ...base.click, ...overrides?.click },
  typing: { ...base.typing, ...overrides?.typing },
});

/**
 * Create a {@link IHumanLikeInput} bound to the injected sink, RNG and scheduler.
 *
 * The returned object is stateless between calls (aside from the shared deps),
 * so a single instance can drive many sequential interactions on one tab.
 *
 * @param deps Sink plus optional RNG, sleep and timing overrides.
 * @returns A ready-to-use human-like input emitter.
 *
 * @example
 * ```ts
 * const input = createHumanLikeInput({ sink: webContentsSink });
 * await input.moveAndClick({ x: 0, y: 0 }, { x: 320, y: 200 });
 * await input.typeText('hello world');
 * ```
 */
export const createHumanLikeInput = (deps: HumanLikeInputDeps): IHumanLikeInput => {
  const { sink } = deps;
  const rng = deps.rng ?? Math.random;
  const sleep = deps.sleep ?? defaultSleep;
  const baseOptions = mergeOptions(DEFAULT_HUMAN_INPUT_OPTIONS, deps.options);

  /** Uniform float in `[min, max]`. */
  const randomFloat = (min: number, max: number): number => min + (max - min) * rng();

  /** Uniform integer in `[min, max]` (inclusive on both ends). */
  const randomInt = (min: number, max: number): number => Math.floor(randomFloat(min, max + 1));

  /** Draw a delay from a {@link DelayRange} and `await` it. */
  const sleepRange = (range: DelayRange): Promise<void> => sleep(randomFloat(range.minMs, range.maxMs));

  const moveMouse = async (from: Point, to: Point, opts?: MoveMouseOptions): Promise<Point> => {
    const mouse: MouseTimingOptions = { ...baseOptions.mouse, ...opts };
    const target = roundPoint(to);

    // Degenerate move: same point → emit a single move so the cursor is "there".
    if (from.x === to.x && from.y === to.y) {
      sink.sendMouseMove(target.x, target.y);
      return target;
    }

    const minSteps = Math.max(1, Math.min(mouse.minSteps, mouse.maxSteps));
    const maxSteps = Math.max(minSteps, mouse.maxSteps);
    const steps = randomInt(minSteps, maxSteps);
    const path = generateBezierPath(from, to, steps, mouse.curveJitter, rng);

    for (let i = 0; i < path.length; i++) {
      const point = roundPoint(path[i]);
      sink.sendMouseMove(point.x, point.y);
      // Pause between steps, but not after the final landing move.
      if (i < path.length - 1) await sleepRange(mouse.stepDelay);
    }

    return target;
  };

  const click = async (point: Point, opts?: ClickOptions): Promise<void> => {
    const clickOpts: ClickTimingOptions = {
      preDelay: opts?.preDelay ?? baseOptions.click.preDelay,
      pressGap: opts?.pressGap ?? baseOptions.click.pressGap,
      postDelay: opts?.postDelay ?? baseOptions.click.postDelay,
    };
    const button: MouseButton = opts?.button ?? 'left';
    const target = roundPoint(point);

    await sleepRange(clickOpts.preDelay);
    sink.sendMouseDown(target.x, target.y, button);
    await sleepRange(clickOpts.pressGap);
    sink.sendMouseUp(target.x, target.y, button);
    await sleepRange(clickOpts.postDelay);
  };

  const typeText = async (text: string, opts?: TypeTextOptions): Promise<void> => {
    const typing: TypingTimingOptions = { ...baseOptions.typing, ...opts };

    // Iterate by code point so multi-unit characters (emoji, CJK) type as one.
    const chars = Array.from(text);
    for (const ch of chars) {
      sink.sendKeyChar(ch);
      await sleepRange(typing.charDelay);
      // Layer an extra "thinking" pause after spaces, punctuation and newlines.
      if (isSpace(ch)) {
        await sleepRange(typing.spacePause);
      } else if (isNewline(ch) || PUNCTUATION.has(ch)) {
        await sleepRange(typing.punctuationPause);
      }
    }
  };

  const moveAndClick = async (from: Point, to: Point, opts?: ClickOptions): Promise<void> => {
    const landing = await moveMouse(from, to);
    await click(landing, opts);
  };

  return { moveMouse, click, typeText, moveAndClick };
};

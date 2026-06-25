/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Self-recovering CLI call template for the agent-company model (Requirement 3,
 * criteria 3.6 & 3.7).
 *
 * Each high-level company agent is invoked through a command-line tool (Claude
 * Code, Codex, Gemini CLI, ...). The exact invocation — executable, fixed flags,
 * environment, working directory — is discovered once by *probing* the CLI and
 * then **locked** as the `fixed` half of a {@link CallTemplate}. Subsequent calls
 * only splice in the per-task prompt (the `promptShape` describes *how*), so the
 * stable, expensive-to-detect configuration is not re-derived every time. This
 * mirrors the design's data model:
 *
 * ```
 * <userData>/companies/<companyId>/agents/<agentId>/call-template.json
 *   → { fixed, promptShape }
 * ```
 *
 * ## Self-recovery invariant (criterion 3.7 / Property 9)
 *
 * A locked template can go stale when the underlying CLI updates (flags renamed,
 * binary moved). When that happens the locked template's call will fail. The
 * manager MUST then, *before surfacing the error to the caller*:
 *
 *   1. re-probe the CLI configuration,
 *   2. update the in-memory template, and
 *   3. persist it (overwrite the JSON file).
 *
 * Only after the re-probe + persist does it retry once; the original error is
 * surfaced only if recovery still fails. The overwrite happens regardless of
 * whether the retry ultimately succeeds, so a fresh process always sees the
 * latest known-good configuration.
 *
 * ## Testability
 *
 * Both side-effecting collaborators are injected (see {@link CallTemplateDeps}):
 *
 *   - the **probe** ({@link TemplateProbeFn}) that detects the CLI configuration,
 *   - the **store** ({@link ICallTemplateStore}) that reads/writes the template
 *     JSON.
 *
 * This keeps the recovery state-machine pure and lets unit / property tests
 * (Task 4.6 — "self-recovering call template") drive it without spawning a real
 * CLI or touching disk. A default file-backed store is provided via
 * {@link createFileCallTemplateStore} for production wiring.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** File name used by the default file-backed store. */
const CALL_TEMPLATE_FILE = 'call-template.json';

/** Default token in a {@link PromptShape} that is replaced by the task prompt. */
const DEFAULT_PROMPT_PLACEHOLDER = '{{PROMPT}}';

/**
 * The locked, CLI-specific half of a {@link CallTemplate}.
 *
 * This is the "fixed" configuration discovered by a successful probe and reused
 * verbatim on every subsequent call until the CLI changes and a re-probe rewrites
 * it.
 */
export type TemplateFixed = {
  /** Executable to spawn (e.g. `'claude'`, `'codex'`, `'gemini'`). */
  command: string;
  /** Fixed arguments always passed before the per-task prompt. */
  args: string[];
  /** Environment variables locked at probe time. */
  env: Record<string, string>;
  /** Optional working directory for the spawned process. */
  cwd?: string;
  /** Unix-ms timestamp when this configuration was probed and locked. */
  probedAt: number;
  /** CLI version captured at probe time; helps explain drift on re-probe. */
  version?: string;
};

/**
 * Describes how a per-task prompt string is spliced into the assembled call.
 *
 * The `fixed` config is constant; the prompt is the only thing that changes call
 * to call, and `promptShape` is the recipe for injecting it.
 */
export type PromptShape = {
  /**
   * How the prompt reaches the CLI:
   * - `'arg'`   — appended to argv (using {@link PromptShape.argTemplate}).
   * - `'stdin'` — written to the process's standard input.
   */
  delivery: 'arg' | 'stdin';
  /**
   * For `delivery: 'arg'`, the argument fragments appended after `fixed.args`.
   * Every occurrence of {@link PromptShape.placeholder} in each fragment is
   * replaced by the prompt. Ignored for `delivery: 'stdin'`.
   *
   * Example: `['--prompt', '{{PROMPT}}']`.
   */
  argTemplate: string[];
  /** Token replaced by the prompt within {@link PromptShape.argTemplate}. */
  placeholder: string;
};

/**
 * A saved call template: the locked CLI config plus the prompt-splicing recipe.
 * Persisted as `call-template.json` (`{ fixed, promptShape }`).
 */
export type CallTemplate = {
  /** Locked CLI configuration discovered by probing. */
  fixed: TemplateFixed;
  /** Recipe describing how the per-task prompt is added to the call. */
  promptShape: PromptShape;
};

/**
 * The result of probing a CLI: everything needed to build a {@link CallTemplate}.
 * Structurally identical to {@link CallTemplate}; named distinctly so the probe
 * contract (detection) reads separately from the persisted artefact.
 */
export type TemplateProbeResult = {
  /** Detected, lockable CLI configuration. */
  fixed: TemplateFixed;
  /** Detected prompt-splicing recipe for this CLI. */
  promptShape: PromptShape;
};

/**
 * A fully assembled, ready-to-spawn call produced by {@link ICallTemplateManager.buildCall}.
 * The `runner` passed to {@link ICallTemplateManager.runWithRecovery} receives
 * this shape.
 */
export type AssembledCall = {
  /** Executable to spawn. */
  command: string;
  /** Final argument vector (fixed args + spliced prompt args when applicable). */
  args: string[];
  /** Environment variables for the spawned process. */
  env: Record<string, string>;
  /** Optional working directory. */
  cwd?: string;
  /** Prompt to write to stdin when `promptShape.delivery === 'stdin'`. */
  stdin?: string;
};

/**
 * Function that detects the CLI configuration for a given template `key`.
 *
 * Implementations resolve the executable on `$PATH`, probe its version and
 * supported flags, and return a {@link TemplateProbeResult}. Injected so tests
 * can supply deterministic probes and so the real implementation (which may
 * spawn processes) stays out of the recovery state-machine.
 *
 * @param key Opaque identifier for the template (e.g. `"<companyId>/<agentId>"`).
 */
export type TemplateProbeFn = (key: string) => Promise<TemplateProbeResult>;

/**
 * Persistence layer for call templates. Injected so the recovery logic can be
 * tested without disk IO; {@link createFileCallTemplateStore} is the default
 * file-backed implementation.
 */
export type ICallTemplateStore = {
  /** Load the persisted template for `key`, or `undefined` if none exists. */
  load(key: string): Promise<CallTemplate | undefined>;
  /** Persist (overwrite) the template for `key`. */
  save(key: string, template: CallTemplate): Promise<void>;
};

/**
 * Phase of the call lifecycle a {@link CallTemplateError} originated from.
 * - `'probe'` — re-probing the CLI failed, so recovery could not proceed.
 * - `'run'`   — the assembled call failed even after a successful re-probe.
 */
export type CallTemplateErrorPhase = 'probe' | 'run';

/**
 * Error surfaced to the caller only after self-recovery has been attempted.
 * Carries the originating {@link CallTemplateErrorPhase} and the underlying
 * cause so callers can distinguish "the CLI is gone" from "the call still fails".
 */
export class CallTemplateError extends Error {
  /** Template key the failure relates to. */
  readonly key: string;
  /** Which recovery phase produced this error. */
  readonly phase: CallTemplateErrorPhase;
  /** Underlying error that triggered the failure. */
  readonly cause: unknown;

  constructor(key: string, phase: CallTemplateErrorPhase, message: string, cause: unknown) {
    super(message);
    this.name = 'CallTemplateError';
    this.key = key;
    this.phase = phase;
    this.cause = cause;
  }
}

/**
 * Public contract for the call-template manager. Two read paths
 * ({@link ICallTemplateManager.getOrProbe}, {@link ICallTemplateManager.buildCall})
 * and the self-recovering execution path
 * ({@link ICallTemplateManager.runWithRecovery}).
 */
export type ICallTemplateManager = {
  /**
   * Return the locked template for `key`, probing and persisting it on first use.
   * Resolution order: in-memory cache → persisted JSON → fresh probe (then
   * locked + persisted).
   */
  getOrProbe(key: string): Promise<CallTemplate>;
  /**
   * Assemble a ready-to-spawn {@link AssembledCall} for `key` by splicing
   * `prompt` into the (locked) template per its {@link PromptShape}.
   */
  buildCall(key: string, prompt: string): Promise<AssembledCall>;
  /**
   * Execute the assembled call via `runner`, self-recovering on failure.
   *
   * Flow (criterion 3.7 / Property 9): run the locked template → on failure
   * re-probe → update + persist (overwrite) → retry once → surface the error
   * only if it still fails. The persisted overwrite happens before the error is
   * surfaced.
   *
   * @typeParam T Result type produced by the runner.
   * @param runner Executes the assembled call (e.g. spawns the CLI) and resolves
   *   with its result, or rejects on failure.
   */
  runWithRecovery<T>(key: string, prompt: string, runner: (call: AssembledCall) => Promise<T>): Promise<T>;
};

/** Dependencies for {@link createCallTemplateManager}. */
export type CallTemplateDeps = {
  /** Detects the CLI configuration. */
  probe: TemplateProbeFn;
  /** Reads/writes persisted templates. */
  store: ICallTemplateStore;
};

/**
 * Replace every occurrence of `placeholder` in `fragment` with `prompt`.
 * Uses split/join (not `replace`) so the prompt is treated as a literal, never
 * as a regexp or replacement-pattern (`$1`, `$&`, ...).
 */
const splicePrompt = (fragment: string, placeholder: string, prompt: string): string =>
  fragment.split(placeholder).join(prompt);

/**
 * Build an {@link AssembledCall} from a locked {@link CallTemplate} and a prompt.
 * The fixed config is copied (never mutated) and the prompt is spliced per the
 * template's {@link PromptShape}.
 */
const assembleCall = (template: CallTemplate, prompt: string): AssembledCall => {
  const { fixed, promptShape } = template;
  const base: AssembledCall = {
    command: fixed.command,
    args: [...fixed.args],
    env: { ...fixed.env },
    ...(fixed.cwd === undefined ? {} : { cwd: fixed.cwd }),
  };

  if (promptShape.delivery === 'stdin') {
    return { ...base, stdin: prompt };
  }

  const placeholder = promptShape.placeholder || DEFAULT_PROMPT_PLACEHOLDER;
  const promptArgs = promptShape.argTemplate.map((fragment) => splicePrompt(fragment, placeholder, prompt));
  return { ...base, args: [...base.args, ...promptArgs] };
};

/**
 * Create a {@link ICallTemplateManager} backed by the injected probe and store.
 *
 * The manager keeps an in-memory cache of locked templates and de-duplicates
 * concurrent first-time probes for the same key, so a burst of calls cannot
 * trigger redundant CLI detection.
 */
export const createCallTemplateManager = (deps: CallTemplateDeps): ICallTemplateManager => {
  const { probe, store } = deps;

  /** Locked templates resolved this session, keyed by template key. */
  const cache = new Map<string, CallTemplate>();
  /** In-flight first-time resolutions, so concurrent callers share one probe. */
  const inFlight = new Map<string, Promise<CallTemplate>>();

  /** Probe the CLI, lock the result, persist (overwrite), and cache it. */
  const probeLockAndPersist = async (key: string): Promise<CallTemplate> => {
    const probed = await probe(key);
    const template: CallTemplate = { fixed: probed.fixed, promptShape: probed.promptShape };
    // Persist BEFORE caching so a save failure does not leave an unpersisted
    // template masquerading as locked across the rest of the session.
    await store.save(key, template);
    cache.set(key, template);
    return template;
  };

  const getOrProbe = async (key: string): Promise<CallTemplate> => {
    const cached = cache.get(key);
    if (cached) return cached;

    const pending = inFlight.get(key);
    if (pending) return pending;

    const resolution = (async (): Promise<CallTemplate> => {
      const persisted = await store.load(key);
      if (persisted) {
        cache.set(key, persisted);
        return persisted;
      }
      return probeLockAndPersist(key);
    })();

    inFlight.set(key, resolution);
    try {
      return await resolution;
    } finally {
      inFlight.delete(key);
    }
  };

  const buildCall = async (key: string, prompt: string): Promise<AssembledCall> => {
    const template = await getOrProbe(key);
    return assembleCall(template, prompt);
  };

  const runWithRecovery = async <T>(
    key: string,
    prompt: string,
    runner: (call: AssembledCall) => Promise<T>
  ): Promise<T> => {
    const template = await getOrProbe(key);

    try {
      return await runner(assembleCall(template, prompt));
    } catch (firstError) {
      // The locked template failed (e.g. the CLI updated). Self-recover by
      // re-probing and persisting the fresh template BEFORE surfacing any error.
      let recovered: CallTemplate;
      try {
        recovered = await probeLockAndPersist(key);
      } catch (probeError) {
        // Re-probe itself failed — recovery is impossible; surface the error.
        throw new CallTemplateError(
          key,
          'probe',
          `Call template for "${key}" failed and re-probing the CLI also failed.`,
          probeError
        );
      }

      // Template is now updated and persisted (overwrite done). Retry once.
      try {
        return await runner(assembleCall(recovered, prompt));
      } catch (secondError) {
        throw new CallTemplateError(
          key,
          'run',
          `Call template for "${key}" still failed after re-probing and updating the locked configuration.`,
          secondError
        );
      }
    }
  };

  return { getOrProbe, buildCall, runWithRecovery };
};

/**
 * Minimal subset of `fs/promises` used by the file-backed store. Declared
 * explicitly so tests can supply an in-memory implementation. Mirrors the
 * adapter shape used by `process/resource/resourceState.ts`.
 */
export type CallTemplateFs = {
  readFile(filePath: string, encoding: 'utf-8'): Promise<string>;
  writeFile(filePath: string, data: string, options: { encoding: 'utf-8'; mode?: number }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  mkdir(dirPath: string, options: { recursive: true }): Promise<string | undefined>;
};

/** Default file-system adapter backed by Node's `fs/promises`. */
const defaultFs: CallTemplateFs = {
  readFile: (filePath, encoding) => fs.promises.readFile(filePath, encoding),
  writeFile: (filePath, data, options) => fs.promises.writeFile(filePath, data, options),
  rename: (oldPath, newPath) => fs.promises.rename(oldPath, newPath),
  mkdir: (dirPath, options) => fs.promises.mkdir(dirPath, options),
};

/** Options for {@link createFileCallTemplateStore}. */
export type FileCallTemplateStoreOptions = {
  /**
   * Base directory templates live under. The default `resolvePath` builds
   * `<baseDir>/<key>/call-template.json`, matching the design's
   * `<userData>/companies/<companyId>/agents/<agentId>/call-template.json` layout
   * when `key` is `"<companyId>/agents/<agentId>"` (or similar).
   */
  baseDir: string;
  /** File-system implementation. Injectable for tests; defaults to `fs/promises`. */
  fs?: CallTemplateFs;
  /**
   * Map a template `key` to its absolute JSON path. Defaults to
   * `path.join(baseDir, key, 'call-template.json')`.
   */
  resolvePath?: (key: string) => string;
};

/** Type guard: a parsed JSON value is shaped like a {@link CallTemplate}. */
const isCallTemplateShape = (value: unknown): value is CallTemplate => {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<CallTemplate>;
  const fixed = candidate.fixed as Partial<TemplateFixed> | undefined;
  const shape = candidate.promptShape as Partial<PromptShape> | undefined;
  if (!fixed || typeof fixed.command !== 'string' || !Array.isArray(fixed.args)) return false;
  if (!shape || (shape.delivery !== 'arg' && shape.delivery !== 'stdin')) return false;
  return Array.isArray(shape.argTemplate);
};

const isFileNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/**
 * Create a file-backed {@link ICallTemplateStore} that reads/writes
 * `call-template.json` per template key.
 *
 * Writes go to a sibling `.tmp` file and are renamed into place so a process
 * kill mid-write cannot corrupt a locked template — the same atomic strategy used
 * by `resourceState.ts`. A missing or malformed file resolves to `undefined`
 * (never throws), letting the manager fall back to probing.
 */
export const createFileCallTemplateStore = (options: FileCallTemplateStoreOptions): ICallTemplateStore => {
  const fsImpl = options.fs ?? defaultFs;
  const resolvePath =
    options.resolvePath ?? ((key: string): string => path.join(options.baseDir, key, CALL_TEMPLATE_FILE));

  return {
    async load(key: string): Promise<CallTemplate | undefined> {
      const filePath = resolvePath(key);
      try {
        const raw = await fsImpl.readFile(filePath, 'utf-8');
        const parsed: unknown = JSON.parse(raw);
        if (!isCallTemplateShape(parsed)) {
          console.warn(`[Company] ${CALL_TEMPLATE_FILE} for "${key}" has unexpected shape; will re-probe`);
          return undefined;
        }
        return parsed;
      } catch (error) {
        if (!isFileNotFound(error)) {
          console.warn(`[Company] Failed to read ${CALL_TEMPLATE_FILE} for "${key}"; will re-probe:`, error);
        }
        return undefined;
      }
    },

    async save(key: string, template: CallTemplate): Promise<void> {
      const filePath = resolvePath(key);
      const dir = path.dirname(filePath);
      const tmpPath = `${filePath}.tmp`;

      await fsImpl.mkdir(dir, { recursive: true });
      const payload = JSON.stringify(template, null, 2) + '\n';
      await fsImpl.writeFile(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 });
      await fsImpl.rename(tmpPath, filePath);
    },
  };
};

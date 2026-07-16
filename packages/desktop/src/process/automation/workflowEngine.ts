/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The Automation workflow engine — a small **interpreter** over a node tree.
 *
 * The backbone is still a deterministic, ordered pipeline (each node's output
 * becomes the next node's `input`), but the engine now understands a handful of
 * `control.*` nodes that branch, loop, run sub-pipelines in parallel, catch
 * errors, filter, merge, or stop the run. Everything else is a *leaf* action
 * resolved through the injected {@link NodeExecutorMap}.
 *
 * Semantics:
 *  - Emits `run-start`, then per node `node-start` → `node-finish`, then
 *    `run-finish` (control nodes emit their own start/finish around their
 *    children so the run log reads naturally).
 *  - **Fail-fast** by default: a throwing node fails the run — UNLESS it sits
 *    inside a `control.tryCatch` `try` branch (routed to `catch`) or declares an
 *    `onError` policy with `continueOnError`/`retries`.
 *  - **Cooperative cancellation**: `signal.aborted` is checked before each node.
 *  - **control.stop** ends the run early and successfully.
 *
 * The executor table and the `emit` sink are injected so the engine is pure and
 * unit-testable (fake executors + captured events, no real IO).
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { randomUUID } from 'node:crypto';
import type { NodeExecutorMap } from './nodeExecutors';
import { conditionFromConfig, evaluateCondition, resolveValue } from './conditions';
import type { NodeContext, RunEvent, Workflow, WorkflowNode } from './automationTypes';

/** Options for a single {@link IWorkflowEngine.run}. */
export type RunOptions = {
  /** Cooperative cancellation; checked between nodes. */
  signal?: AbortSignal;
  /** Externally-assigned run id (so the returned id matches streamed events). */
  runId?: string;
  /** Seed value for the first node's `input` (e.g. a webhook/trigger payload). */
  input?: unknown;
};

/** Outcome of a workflow run. */
export type RunResult = {
  /** Id assigned to this run (also present on every emitted event). */
  runId: string;
  /** Whether the whole pipeline completed without an unhandled failure/abort. */
  ok: boolean;
  /** The final pipeline value (the last node's output). */
  output?: unknown;
};

/** Dependencies for {@link createWorkflowEngine}. */
export type WorkflowEngineDeps = {
  /** Executor table — one function per leaf node kind. */
  executors: NodeExecutorMap;
  /** Sink for streamed lifecycle events. */
  emit: (event: RunEvent) => void;
  /** Clock for event timestamps. Defaults to `Date.now`. Injectable for tests. */
  now?: () => number;
  /** Run-id generator. Defaults to `crypto.randomUUID`. Injectable for tests. */
  newRunId?: () => string;
  /** Max nesting depth for control-flow recursion (guards against cycles). Default 20. */
  maxDepth?: number;
  /** Max total leaf-node executions per run (guards runaway loops). Default 10000. */
  maxSteps?: number;
};

/** Public contract of the workflow engine. */
export type IWorkflowEngine = {
  /** Execute a workflow's node tree, emitting events; resolves with the outcome. */
  run(workflow: Workflow, options?: RunOptions): Promise<RunResult>;
};

/** Signal used internally to unwind the stack when `control.stop` runs. */
class StopRun extends Error {
  constructor() {
    super('control.stop');
    this.name = 'StopRun';
  }
}

/** The set of kinds the interpreter handles itself (not via the executor map). */
const CONTROL_KINDS = new Set<string>([
  'control.if',
  'control.switch',
  'control.loop',
  'control.parallel',
  'control.tryCatch',
  'control.filter',
  'control.merge',
  'control.stop',
]);

const numOf = (config: Record<string, unknown>, key: string, fallback: number): number =>
  typeof config[key] === 'number' && Number.isFinite(config[key]) ? (config[key] as number) : fallback;

/**
 * Create a workflow engine bound to an executor table and an event sink.
 */
export const createWorkflowEngine = (deps: WorkflowEngineDeps): IWorkflowEngine => {
  const now = deps.now ?? Date.now;
  const newRunId = deps.newRunId ?? randomUUID;
  const maxDepth = deps.maxDepth ?? 20;
  const maxSteps = deps.maxSteps ?? 10000;

  return {
    async run(workflow, options) {
      const runId = options?.runId ?? newRunId();
      const signal = options?.signal;
      deps.emit({ type: 'run-start', runId, at: now() });

      const state = { steps: 0 };

      /** Run an ordered list of nodes, threading output→input. Returns last output. */
      const runPipeline = async (nodes: WorkflowNode[], seed: unknown, depth: number): Promise<unknown> => {
        if (depth > maxDepth) throw new Error(`Automation exceeded max nesting depth (${maxDepth}).`);
        let value = seed;
        for (const node of nodes) {
          if (signal?.aborted) throw new StopRun();
          value = await runNode(node, value, depth);
        }
        return value;
      };

      /** Run one node (control or leaf) and return its output. */
      const runNode = async (node: WorkflowNode, input: unknown, depth: number): Promise<unknown> => {
        if (CONTROL_KINDS.has(node.kind)) return runControl(node, input, depth);
        return runLeaf(node, input);
      };

      /** Run a leaf action via the executor map, honouring its `onError` policy. */
      const runLeaf = async (node: WorkflowNode, input: unknown): Promise<unknown> => {
        if (++state.steps > maxSteps) throw new Error(`Automation exceeded max steps (${maxSteps}).`);
        deps.emit({ type: 'node-start', runId, nodeId: node.id, name: node.name, at: now() });
        const ctx: NodeContext = { input };
        const retries = Math.max(0, node.onError?.retries ?? 0);
        const retryDelayMs = Math.max(0, node.onError?.retryDelayMs ?? 0);

        let lastError: unknown;
        for (let attempt = 0; attempt <= retries; attempt++) {
          try {
            // Control kinds never reach here; cast narrows to a leaf executor key.
            const executor = deps.executors[node.kind as keyof NodeExecutorMap];
            const output = await executor(node, ctx, signal);
            deps.emit({ type: 'node-finish', runId, nodeId: node.id, ok: true, output, at: now() });
            return output;
          } catch (error) {
            lastError = error;
            if (attempt < retries) {
              if (retryDelayMs > 0) await delay(retryDelayMs, signal);
              continue;
            }
          }
        }
        const message = lastError instanceof Error ? lastError.message : String(lastError);
        deps.emit({ type: 'node-finish', runId, nodeId: node.id, ok: false, error: message, at: now() });
        if (node.onError?.continueOnError) return null;
        throw lastError instanceof Error ? lastError : new Error(message);
      };

      /** Interpret a control-flow node, recursing into its branches. */
      const runControl = async (node: WorkflowNode, input: unknown, depth: number): Promise<unknown> => {
        const branches = node.branches ?? {};
        deps.emit({ type: 'node-start', runId, nodeId: node.id, name: node.name, at: now() });
        try {
          let output: unknown = input;
          switch (node.kind) {
            case 'control.if': {
              const taken = evaluateCondition(conditionFromConfig(node.config), input) ? 'then' : 'else';
              output = await runPipeline(branches[taken] ?? [], input, depth + 1);
              break;
            }
            case 'control.switch': {
              const value = resolveValue(
                typeof node.config.value === 'string' ? node.config.value : '{{input}}',
                input
              );
              const key = branches[`case:${value}`] ? `case:${value}` : 'default';
              output = await runPipeline(branches[key] ?? [], input, depth + 1);
              break;
            }
            case 'control.filter': {
              const pass = evaluateCondition(conditionFromConfig(node.config), input);
              if (!pass) throw new StopRun();
              output = input;
              break;
            }
            case 'control.loop': {
              output = await runLoop(node, input, depth + 1, branches.body ?? []);
              break;
            }
            case 'control.parallel': {
              const keys = Object.keys(branches)
                .filter((k) => k.startsWith('branch:'))
                .toSorted();
              const results = await Promise.all(keys.map((k) => runPipeline(branches[k], input, depth + 1)));
              output = { branches: results };
              break;
            }
            case 'control.tryCatch': {
              try {
                output = await runPipeline(branches.try ?? [], input, depth + 1);
              } catch (error) {
                if (error instanceof StopRun) throw error;
                const message = error instanceof Error ? error.message : String(error);
                output = await runPipeline(branches.catch ?? [], { error: message, input }, depth + 1);
              }
              break;
            }
            case 'control.merge': {
              // Merge mode: pass the input through (parallel already aggregated).
              output = input;
              break;
            }
            case 'control.stop': {
              deps.emit({ type: 'node-finish', runId, nodeId: node.id, ok: true, output: input, at: now() });
              throw new StopRun();
            }
            default:
              output = input;
          }
          deps.emit({ type: 'node-finish', runId, nodeId: node.id, ok: true, output, at: now() });
          return output;
        } catch (error) {
          if (error instanceof StopRun) throw error;
          const message = error instanceof Error ? error.message : String(error);
          deps.emit({ type: 'node-finish', runId, nodeId: node.id, ok: false, error: message, at: now() });
          throw error;
        }
      };

      /** Run a `control.loop` over an array (`forEach`) or a fixed count (`times`). */
      const runLoop = async (
        node: WorkflowNode,
        input: unknown,
        depth: number,
        body: WorkflowNode[]
      ): Promise<unknown> => {
        const mode = typeof node.config.mode === 'string' ? node.config.mode : 'forEach';
        const results: unknown[] = [];
        if (mode === 'times') {
          const times = Math.max(0, Math.floor(numOf(node.config, 'times', 1)));
          for (let i = 0; i < times; i++) {
            if (signal?.aborted) throw new StopRun();
            results.push(await runPipeline(body, { index: i, input }, depth));
          }
        } else {
          const items = Array.isArray(input)
            ? input
            : extractArray(input, typeof node.config.itemsPath === 'string' ? node.config.itemsPath : undefined);
          for (let i = 0; i < items.length; i++) {
            if (signal?.aborted) throw new StopRun();
            results.push(await runPipeline(body, { item: items[i], index: i }, depth));
          }
        }
        return { items: results, count: results.length };
      };

      // ---- run the top-level pipeline ----
      let ok = true;
      let finalOutput: unknown;
      try {
        finalOutput = await runPipeline(workflow.nodes, options?.input, 0);
      } catch (error) {
        if (error instanceof StopRun) {
          ok = !signal?.aborted; // a deliberate stop is success; an abort is not.
        } else {
          ok = false;
        }
      }

      deps.emit({ type: 'run-finish', runId, ok, at: now() });
      return { runId, ok, output: finalOutput };
    },
  };
};

/** Pull an array out of an object by path (`a.b`) for `control.loop` forEach. */
const extractArray = (input: unknown, itemsPath?: string): unknown[] => {
  if (Array.isArray(input)) return input;
  if (itemsPath && input != null && typeof input === 'object') {
    let cur: unknown = input;
    for (const part of itemsPath.split('.').filter(Boolean)) {
      if (cur == null || typeof cur !== 'object') return [];
      cur = (cur as Record<string, unknown>)[part];
    }
    return Array.isArray(cur) ? cur : [];
  }
  return [];
};

/** A `setTimeout` that rejects promptly if the signal aborts. */
const delay = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Aborted'));
      return;
    }
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms)
    );
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

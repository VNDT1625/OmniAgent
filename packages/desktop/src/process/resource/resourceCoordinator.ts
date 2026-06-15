/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Core of the ResourceCoordinator (Requirement 5 — anti-lag resource
 * management). This service is the **mandatory gate** for every heavy task in
 * the OmniAgent spec: no service may spawn a worker / BrowserView / emulator /
 * patch-build without first obtaining a {@link Lease} here (criterion 5.9).
 *
 * Responsibilities (see `design.md`, Yêu cầu 5):
 * - **Lease accounting (criterion 5.4):** grant a lease immediately when it fits
 *   inside the current {@link ResourceBudget} (per-kind concurrency *and* the
 *   total heavy-task memory ceiling); otherwise queue the request and resolve it
 *   later, in priority order, when a release frees enough budget. The invariant
 *   the property tests assert is that the summed `estCostMB` of all *active*
 *   leases never exceeds `budget.maxTotalMemoryMB`.
 * - **Tier B real-time self-balancing:** a periodic timer samples live resource
 *   pressure and asks `balancePolicy.evaluateAdjustment` whether to scale the
 *   budget; any adjustment is applied and persisted with its reason
 *   (criterion 5.8). Only runs in `suggest` mode (criterion 5.2).
 * - **On-demand suspend (criterion 5.5):** services register an `idleHook` per
 *   {@link TaskKind}; the coordinator fires the hook when a kind has had no
 *   active leases for longer than the idle timeout, so idle components can free
 *   memory and be reloaded on demand.
 *
 * ## Testability
 *
 * Every source of non-determinism — the machine probe, the live pressure
 * sampler, the clock, the timer scheduler, the lease-id generator, and the
 * persistence directory/fs — is injected via {@link ResourceCoordinatorOptions}.
 * Tests construct an instance with {@link createResourceCoordinator} supplying a
 * fake scheduler and deterministic samples, so the queue/budget invariants
 * (subtasks 1.7 / 1.8) can be checked without real timers or disk. The shared
 * application instance is exposed lazily via {@link getResourceCoordinator}.
 *
 * Tier A (preset suggestion) and Tier B (the adjustment rule engine) live in
 * `balancePolicy.ts`; Tier C (AI deep analysis) lives in `balanceAdvisor.ts`
 * (subtask 1.9). This module owns only the side effects and orchestration.
 */

import { randomUUID } from 'node:crypto';
import * as os from 'node:os';
import {
  BALANCE_INTERVAL_MS,
  evaluateAdjustment,
  presetBudget,
  suggestPreset,
  type ResourceSample,
} from './balancePolicy';
import type {
  ApplicablePreset,
  BudgetAdjustment,
  Lease,
  LeaseRequest,
  MachineProfile,
  ResourceBudget,
  ResourceMode,
  ResourceState,
  TaskKind,
} from './leaseTypes';
import {
  appendBudgetAdjustment,
  loadResourceState,
  saveResourceState,
  type ResourceStateStoreOptions,
} from './resourceState';
import { probeSystem } from './systemProbe';

/** Number of bytes in one megabyte (MiB), for byte → MB conversion. */
const BYTES_PER_MB = 1024 * 1024;

/** Default idle timeout (ms) before an unused {@link TaskKind} is suspended. */
const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60_000;

/** Conservative placeholder machine used before {@link IResourceCoordinator.init} runs. */
const PLACEHOLDER_MACHINE: MachineProfile = { totalMemMB: 0, cpuCores: 1, hasDiscreteGPU: false, freeDiskMB: 0 };

/** Clamp `value` into the inclusive range `[min, max]`. */
const clamp = (value: number, min: number, max: number): number => Math.min(Math.max(value, min), max);

/**
 * Opaque handle returned by the {@link Scheduler}. Kept as `unknown` so a fake
 * scheduler (tests) and the real Node timers can both satisfy the interface
 * without leaking their concrete handle types.
 */
export type TimerHandle = unknown;

/**
 * Timer abstraction so the balancing loop and idle timeouts can be driven by a
 * fake clock in tests. Mirrors the subset of the Node timer API the coordinator
 * needs. The default implementation wraps the global timers.
 */
export type Scheduler = {
  setInterval: (handler: () => void, ms: number) => TimerHandle;
  clearInterval: (handle: TimerHandle) => void;
  setTimeout: (handler: () => void, ms: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
};

/** Default scheduler backed by the global Node timers. */
const defaultScheduler: Scheduler = {
  setInterval: (handler, ms) => setInterval(handler, ms),
  clearInterval: (handle) => {
    clearInterval(handle as ReturnType<typeof setInterval>);
  },
  setTimeout: (handler, ms) => setTimeout(handler, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

/** A function that reads a live {@link ResourceSample} of system pressure. */
export type ResourceSampler = () => ResourceSample | Promise<ResourceSample>;

/** Callback a service registers to be told its {@link TaskKind} should suspend. */
export type IdleHook = () => void | Promise<void>;

/**
 * Injectable dependencies and tunables for {@link createResourceCoordinator}.
 * Every field is optional; omitted fields use the real, production defaults.
 */
export type ResourceCoordinatorOptions = {
  /** Reads the static machine profile at startup. Defaults to the real probe. */
  probe?: () => Promise<MachineProfile>;
  /** Reads live resource pressure each Tier B tick. Defaults to an `os`-based sampler. */
  sampler?: ResourceSampler;
  /** Wall-clock source (Unix ms). Defaults to `Date.now`. */
  now?: () => number;
  /** Timer scheduler. Defaults to the global Node timers. */
  scheduler?: Scheduler;
  /** Where/how to persist {@link ResourceState}. Defaults to the app data dir. */
  store?: ResourceStateStoreOptions;
  /** Idle timeout (ms) before an unused kind is suspended. */
  idleTimeoutMs?: number;
  /** Interval (ms) of the Tier B balancing loop. Defaults to {@link BALANCE_INTERVAL_MS}. */
  balanceIntervalMs?: number;
  /** Unique lease-id generator. Defaults to `crypto.randomUUID`. */
  generateId?: () => string;
  /** Whether {@link IResourceCoordinator.init} starts the Tier B loop. Defaults to `true`. */
  autoStartBalanceLoop?: boolean;
};

/**
 * Public surface of the ResourceCoordinator, matching the `IResourceCoordinator`
 * interface in `design.md` plus the idle-hook registration (criterion 5.5) and a
 * `dispose` for deterministic teardown.
 */
export type IResourceCoordinator = {
  /** Tier A: probe the machine, restore or derive the budget, start Tier B. */
  init: () => Promise<ResourceState>;
  /** Request a lease; resolves immediately if it fits, otherwise when it does. */
  requestLease: (req: LeaseRequest) => Promise<Lease>;
  /** Release a held lease and grant any newly-fitting queued requests. */
  releaseLease: (id: string) => void;
  /** Switch between `detailed` (manual) and `suggest` (self-balancing) modes. */
  setMode: (mode: ResourceMode) => void;
  /** Merge a partial budget; marks the preset as `custom`. */
  setBudget: (budget: Partial<ResourceBudget>) => void;
  /** Apply a built-in quick level (`saver | balanced | performance`). */
  applyPreset: (preset: ApplicablePreset) => void;
  /** Snapshot of the current in-memory state (safe to mutate by the caller). */
  getState: () => ResourceState;
  /** Subscribe to state changes; returns an unsubscribe function. */
  onStateChange: (cb: (state: ResourceState) => void) => () => void;
  /** Register a per-kind suspend hook; returns an unregister function. */
  registerIdleHook: (kind: TaskKind, onSuspend: IdleHook) => () => void;
  /** Stop all timers and drop all listeners. */
  dispose: () => void;
};

/** Internal record for a request waiting in the queue (criterion 5.4). */
type PendingRequest = {
  kind: TaskKind;
  estCostMB: number;
  priority: number;
  enqueuedAt: number;
  resolve: (lease: Lease) => void;
};

/** Sum the idle and total CPU times across all cores from `os.cpus()`. */
const readCpuTimes = (): { idle: number; total: number } => {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
};

/**
 * Build the default `os`-based sampler. CPU load is estimated from the change in
 * idle/total CPU time between successive calls (the first call has no baseline
 * and reports `0`). Free RAM is read directly from `os.freemem()`.
 */
const createDefaultSampler = (): ResourceSampler => {
  let previous = readCpuTimes();
  return () => {
    const current = readCpuTimes();
    const idleDelta = current.idle - previous.idle;
    const totalDelta = current.total - previous.total;
    previous = current;
    const cpuLoad = totalDelta > 0 ? clamp(1 - idleDelta / totalDelta, 0, 1) : 0;
    return { freeMemMB: Math.round(os.freemem() / BYTES_PER_MB), cpuLoad };
  };
};

/** Deep-clone a {@link ResourceBudget} so snapshots cannot be mutated in place. */
const cloneBudget = (budget: ResourceBudget): ResourceBudget => ({
  maxConcurrent: { ...budget.maxConcurrent },
  maxTotalMemoryMB: budget.maxTotalMemoryMB,
  reserveForUserMB: budget.reserveForUserMB,
});

/** Deep-clone a {@link ResourceState} for safe external consumption. */
const cloneState = (state: ResourceState): ResourceState => ({
  machine: { ...state.machine },
  mode: state.mode,
  preset: state.preset,
  budget: cloneBudget(state.budget),
  active: state.active.map((lease) => ({ ...lease })),
  queued: state.queued.map((task) => ({ ...task })),
  lastAdjustments: state.lastAdjustments.map((adjustment) => ({
    at: adjustment.at,
    reason: adjustment.reason,
    from: cloneBudget(adjustment.from),
    to: cloneBudget(adjustment.to),
  })),
});

/**
 * Concrete coordinator. Not exported directly — callers use
 * {@link createResourceCoordinator} (factory) or {@link getResourceCoordinator}
 * (shared instance) so the construction options stay the single entry point.
 */
class ResourceCoordinatorImpl implements IResourceCoordinator {
  private readonly probe: () => Promise<MachineProfile>;
  private readonly sampler: ResourceSampler;
  private readonly now: () => number;
  private readonly scheduler: Scheduler;
  private readonly store?: ResourceStateStoreOptions;
  private readonly idleTimeoutMs: number;
  private readonly balanceIntervalMs: number;
  private readonly generateId: () => string;
  private readonly autoStartBalanceLoop: boolean;

  private state: ResourceState;
  private readonly pending: PendingRequest[] = [];
  private readonly listeners = new Set<(state: ResourceState) => void>();
  private readonly idleHooks = new Map<TaskKind, IdleHook>();
  private readonly idleTimers = new Map<TaskKind, TimerHandle>();
  private readonly suspended = new Set<TaskKind>();
  private balanceHandle: TimerHandle | undefined;
  private balancing = false;

  constructor(options: ResourceCoordinatorOptions = {}) {
    this.probe = options.probe ?? probeSystem;
    this.sampler = options.sampler ?? createDefaultSampler();
    this.now = options.now ?? (() => Date.now());
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.store = options.store;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.balanceIntervalMs = options.balanceIntervalMs ?? BALANCE_INTERVAL_MS;
    this.generateId = options.generateId ?? (() => randomUUID());
    this.autoStartBalanceLoop = options.autoStartBalanceLoop ?? true;
    this.state = ResourceCoordinatorImpl.buildDefaultState(PLACEHOLDER_MACHINE);
  }

  /** Build a usable default state for the given machine (preset: `balanced`). */
  private static buildDefaultState(machine: MachineProfile): ResourceState {
    const preset = suggestPreset(machine);
    return {
      machine,
      mode: 'suggest',
      preset,
      budget: presetBudget(preset, machine),
      active: [],
      queued: [],
      lastAdjustments: [],
    };
  }

  async init(): Promise<ResourceState> {
    const machine = await this.probe();
    const persisted = await loadResourceState(this.store);
    if (persisted) {
      // Active leases and the queue are per-process and do not survive a
      // restart, so reset them; keep the user's budget/mode/preset/history.
      this.state = { ...persisted, machine, active: [], queued: [] };
    } else {
      this.state = ResourceCoordinatorImpl.buildDefaultState(machine);
    }
    this.pending.length = 0;
    await this.persist();
    if (this.autoStartBalanceLoop) this.startBalanceLoop();
    this.emit();
    return this.getState();
  }

  async requestLease(req: LeaseRequest): Promise<Lease> {
    const estCostMB = Math.max(0, req.estCostMB);
    if (this.canGrant(req.kind, estCostMB)) {
      const lease = this.grantInternal(req.kind, estCostMB);
      this.emit();
      return lease;
    }
    return new Promise<Lease>((resolve) => {
      this.pending.push({ kind: req.kind, estCostMB, priority: req.priority ?? 0, enqueuedAt: this.now(), resolve });
      this.syncQueuedState();
      this.emit();
    });
  }

  releaseLease(id: string): void {
    const index = this.state.active.findIndex((lease) => lease.id === id);
    if (index === -1) return; // unknown / already released — idempotent
    const [removed] = this.state.active.splice(index, 1);
    if (this.activeCountOfKind(removed.kind) === 0) this.startIdleTimer(removed.kind);
    this.emit();
    this.drainQueue();
  }

  setMode(mode: ResourceMode): void {
    if (this.state.mode === mode) return;
    this.state.mode = mode;
    this.emit();
    void this.persist();
  }

  setBudget(budget: Partial<ResourceBudget>): void {
    this.state.budget = {
      maxConcurrent: { ...this.state.budget.maxConcurrent, ...budget.maxConcurrent },
      maxTotalMemoryMB: budget.maxTotalMemoryMB ?? this.state.budget.maxTotalMemoryMB,
      reserveForUserMB: budget.reserveForUserMB ?? this.state.budget.reserveForUserMB,
    };
    this.state.preset = 'custom';
    this.emit();
    void this.persist();
    this.drainQueue();
  }

  applyPreset(preset: ApplicablePreset): void {
    this.state.budget = presetBudget(preset, this.state.machine);
    this.state.preset = preset;
    this.emit();
    void this.persist();
    this.drainQueue();
  }

  getState(): ResourceState {
    return cloneState(this.state);
  }

  onStateChange(cb: (state: ResourceState) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  registerIdleHook(kind: TaskKind, onSuspend: IdleHook): () => void {
    this.idleHooks.set(kind, onSuspend);
    // If the kind is already idle, begin its suspend countdown immediately.
    if (this.activeCountOfKind(kind) === 0) this.startIdleTimer(kind);
    return () => {
      if (this.idleHooks.get(kind) === onSuspend) {
        this.idleHooks.delete(kind);
        this.cancelIdleTimer(kind);
        this.suspended.delete(kind);
      }
    };
  }

  dispose(): void {
    this.stopBalanceLoop();
    for (const handle of this.idleTimers.values()) this.scheduler.clearTimeout(handle);
    this.idleTimers.clear();
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------
  // Lease accounting
  // -------------------------------------------------------------------------

  /** Count active leases of a given kind. */
  private activeCountOfKind(kind: TaskKind): number {
    return this.state.active.reduce((count, lease) => (lease.kind === kind ? count + 1 : count), 0);
  }

  /** Total `estCostMB` of all active leases (the invariant of criterion 5.4). */
  private activeMemoryMB(): number {
    return this.state.active.reduce((sum, lease) => sum + lease.estCostMB, 0);
  }

  /**
   * Whether a lease fits the budget right now: under the per-kind concurrency
   * cap *and* the total heavy-task memory ceiling would not be exceeded.
   */
  private canGrant(kind: TaskKind, estCostMB: number): boolean {
    if (this.activeCountOfKind(kind) >= this.state.budget.maxConcurrent[kind]) return false;
    return this.activeMemoryMB() + estCostMB <= this.state.budget.maxTotalMemoryMB;
  }

  /** Add an active lease and clear any idle/suspend bookkeeping for its kind. */
  private grantInternal(kind: TaskKind, estCostMB: number): Lease {
    const lease: Lease = { id: this.generateId(), kind, grantedAt: this.now(), estCostMB };
    this.state.active.push(lease);
    this.cancelIdleTimer(kind);
    this.suspended.delete(kind);
    return lease;
  }

  /**
   * Grant as many queued requests as now fit, in priority order (higher
   * `priority` first, then FIFO by enqueue time). Resolves each granted
   * request's promise. A single descending pass suffices because granting only
   * consumes budget.
   */
  private drainQueue(): void {
    if (this.pending.length === 0) return;
    const ordered = [...this.pending].toSorted((a, b) => b.priority - a.priority || a.enqueuedAt - b.enqueuedAt);
    const granted: Array<{ request: PendingRequest; lease: Lease }> = [];
    for (const request of ordered) {
      if (this.canGrant(request.kind, request.estCostMB)) {
        granted.push({ request, lease: this.grantInternal(request.kind, request.estCostMB) });
      }
    }
    if (granted.length === 0) return;
    const grantedRequests = new Set(granted.map((entry) => entry.request));
    for (let i = this.pending.length - 1; i >= 0; i--) {
      if (grantedRequests.has(this.pending[i])) this.pending.splice(i, 1);
    }
    this.syncQueuedState();
    this.emit();
    for (const { request, lease } of granted) request.resolve(lease);
  }

  /** Mirror the internal pending list into the serializable `state.queued`. */
  private syncQueuedState(): void {
    this.state.queued = this.pending.map((request) => ({ kind: request.kind, enqueuedAt: request.enqueuedAt }));
  }

  // -------------------------------------------------------------------------
  // Tier B — real-time self-balancing loop
  // -------------------------------------------------------------------------

  /** Start the periodic balancing loop (no-op if already running). */
  private startBalanceLoop(): void {
    if (this.balanceHandle !== undefined) return;
    this.balanceHandle = this.scheduler.setInterval(() => {
      void this.runBalanceTick();
    }, this.balanceIntervalMs);
  }

  /** Stop the periodic balancing loop. */
  private stopBalanceLoop(): void {
    if (this.balanceHandle === undefined) return;
    this.scheduler.clearInterval(this.balanceHandle);
    this.balanceHandle = undefined;
  }

  /**
   * One Tier B tick: sample pressure, ask the policy whether to adjust, and
   * apply any adjustment. Self-balancing only runs in `suggest` mode
   * (criterion 5.2); overlapping ticks are skipped while one is in flight.
   */
  private async runBalanceTick(): Promise<void> {
    if (this.balancing || this.state.mode !== 'suggest') return;
    this.balancing = true;
    try {
      const sample = await this.sampler();
      const decision = evaluateAdjustment({
        current: this.state.budget,
        sample,
        machine: this.state.machine,
        recentAdjustmentsAt: this.state.lastAdjustments.map((adjustment) => adjustment.at),
        now: this.now(),
      });
      if (decision.action !== 'none') await this.applyAdjustment(decision.adjustment);
    } catch (error) {
      console.warn('[Resource] Balance tick failed:', error);
    } finally {
      this.balancing = false;
    }
  }

  /** Apply and persist an automatic budget adjustment, then re-drain the queue. */
  private async applyAdjustment(adjustment: BudgetAdjustment): Promise<void> {
    try {
      this.state = await appendBudgetAdjustment(this.state, adjustment, this.store);
    } catch (error) {
      // Persistence failed; still apply the adjustment in memory so balancing
      // continues to function even if disk is unavailable.
      console.warn('[Resource] Failed to persist budget adjustment:', error);
      this.state = {
        ...this.state,
        budget: adjustment.to,
        lastAdjustments: [...this.state.lastAdjustments, adjustment],
      };
    }
    this.emit();
    this.drainQueue();
  }

  // -------------------------------------------------------------------------
  // On-demand suspend (idle hooks, criterion 5.5)
  // -------------------------------------------------------------------------

  /** Schedule the suspend hook for a kind that has just gone idle. */
  private startIdleTimer(kind: TaskKind): void {
    if (!this.idleHooks.has(kind)) return;
    this.cancelIdleTimer(kind);
    const handle = this.scheduler.setTimeout(() => {
      this.idleTimers.delete(kind);
      if (this.activeCountOfKind(kind) !== 0) return;
      const hook = this.idleHooks.get(kind);
      if (!hook) return;
      this.suspended.add(kind);
      void Promise.resolve()
        .then(hook)
        .catch((error) => {
          console.warn(`[Resource] Idle hook for "${kind}" failed:`, error);
        });
    }, this.idleTimeoutMs);
    this.idleTimers.set(kind, handle);
  }

  /** Cancel a pending idle suspend timer for a kind, if any. */
  private cancelIdleTimer(kind: TaskKind): void {
    const handle = this.idleTimers.get(kind);
    if (handle === undefined) return;
    this.scheduler.clearTimeout(handle);
    this.idleTimers.delete(kind);
  }

  // -------------------------------------------------------------------------
  // Persistence + notification
  // -------------------------------------------------------------------------

  /** Persist the current state, swallowing (logging) any write error. */
  private async persist(): Promise<void> {
    try {
      await saveResourceState(this.state, this.store);
    } catch (error) {
      console.warn('[Resource] Failed to persist resource state:', error);
    }
  }

  /** Notify every listener with a fresh snapshot. */
  private emit(): void {
    const snapshot = cloneState(this.state);
    for (const listener of this.listeners) {
      try {
        listener(snapshot);
      } catch (error) {
        console.warn('[Resource] State-change listener threw:', error);
      }
    }
  }
}

/**
 * Create a new, independent ResourceCoordinator. Prefer this in tests so each
 * case gets an isolated instance with injected timers/probe/sampler/store.
 *
 * @param options Optional dependency and tunable overrides.
 * @returns A fresh {@link IResourceCoordinator}.
 */
export const createResourceCoordinator = (options?: ResourceCoordinatorOptions): IResourceCoordinator =>
  new ResourceCoordinatorImpl(options);

/** Lazily-created shared instance backing the IPC bridge and MCP server. */
let sharedCoordinator: IResourceCoordinator | undefined;

/**
 * Get the shared, application-wide ResourceCoordinator, creating it on first
 * use with production defaults. The caller is responsible for invoking `init()`
 * once during Main-process startup.
 */
export const getResourceCoordinator = (): IResourceCoordinator => {
  if (!sharedCoordinator) sharedCoordinator = createResourceCoordinator();
  return sharedCoordinator;
};

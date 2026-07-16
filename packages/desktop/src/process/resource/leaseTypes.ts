/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Core type definitions for the ResourceCoordinator (Requirement 5 — anti-lag
 * resource management). These types model the resource budget, the leases that
 * gate every heavy task, and the persisted coordinator state.
 *
 * This module contains types only (no runtime behaviour) so that it can be
 * imported safely by both Main-process services (`systemProbe`, `resourceState`,
 * `balancePolicy`, `resourceCoordinator`, ...) and, where needed, by the renderer
 * Dashboard UI without dragging in Node.js dependencies.
 */

/**
 * Category of heavy task that must be throttled by the ResourceCoordinator.
 *
 * Every expensive capability across the Tomni Agentic spec maps onto exactly one of
 * these kinds so that concurrency can be budgeted per category:
 * - `agent`         — spawning an AI agent / CLI session
 * - `browser`       — an embedded browser (WebContentsView) tab
 * - `emulator`      — an Android emulator instance
 * - `windowsTest`   — a Windows .exe test session in a virtual display
 * - `patchBuild`    — building and testing a candidate bug-fix patch
 * - `ocr`           — optical character recognition of scanned documents
 * - `transcription` — audio/video speech-to-text
 * - `docConvert`    — document conversion (e.g. PDF ⇄ Word)
 * - `semanticIndex` — embedding / vector index work for semantic tool selection
 */
export type TaskKind =
  | 'agent'
  | 'browser'
  | 'emulator'
  | 'windowsTest'
  | 'patchBuild'
  | 'ocr'
  | 'transcription'
  | 'docConvert'
  | 'semanticIndex';

/**
 * Coordinator operating mode (criterion 5.2).
 * - `detailed` — the user sets every limit manually.
 * - `suggest`  — the coordinator evaluates the machine and self-balances.
 */
export type ResourceMode = 'detailed' | 'suggest';

/**
 * A preset that can be applied to the budget via `applyPreset` (criterion 5.3).
 * These are the user-selectable quick levels.
 */
export type ApplicablePreset = 'saver' | 'balanced' | 'performance';

/**
 * The preset currently reflected in {@link ResourceState}.
 *
 * Extends {@link ApplicablePreset} with `custom`, which represents a budget that
 * was edited manually (in `detailed` mode) and therefore no longer matches any
 * built-in preset.
 */
export type ResourcePreset = ApplicablePreset | 'custom';

/**
 * The resource budget the coordinator enforces.
 */
export type ResourceBudget = {
  /** Maximum number of concurrent tasks allowed per {@link TaskKind}. */
  maxConcurrent: Record<TaskKind, number>;
  /** Upper bound on total RAM (MB) dedicated to heavy tasks. */
  maxTotalMemoryMB: number;
  /** RAM (MB) reserved for the user so the machine stays responsive. */
  reserveForUserMB: number;
};

/**
 * A request a service submits before running a heavy task. The coordinator
 * resolves it with a {@link Lease} once enough resources are free (the request
 * may wait in the queue until then).
 */
export type LeaseRequest = {
  /** Category of the task being requested. */
  kind: TaskKind;
  /** Estimated RAM (MB) the task will consume while it runs. */
  estCostMB: number;
  /** Optional scheduling priority; higher values are granted sooner. */
  priority?: number;
};

/**
 * A granted permission ("ticket") to run one heavy task. The holder must call
 * `releaseLease(id)` when the task finishes so the budget is freed.
 */
export type Lease = {
  /** Unique identifier for this lease. */
  id: string;
  /** Category of the task this lease was granted for. */
  kind: TaskKind;
  /** Timestamp (Unix ms) when the lease was granted. */
  grantedAt: number;
  /** Estimated RAM (MB) accounted against the budget while the lease is held. */
  estCostMB: number;
};

/**
 * An entry in the wait queue for a task that could not be granted a lease
 * immediately because the budget was exhausted (criterion 5.4).
 */
export type QueuedTask = {
  /** Category of the queued task. */
  kind: TaskKind;
  /** Timestamp (Unix ms) when the task entered the queue. */
  enqueuedAt: number;
};

/**
 * A record of a single automatic budget adjustment (criterion 5.8).
 *
 * `from`/`to` are full {@link ResourceBudget} snapshots taken immediately before
 * and after the change. Full snapshots (rather than partial diffs) are stored so
 * the Dashboard can render an unambiguous before/after view and so the history
 * remains self-describing even as the budget shape evolves.
 */
export type BudgetAdjustment = {
  /** Timestamp (Unix ms) when the adjustment was applied. */
  at: number;
  /** Human-readable reason for the adjustment, surfaced to the user. */
  reason: string;
  /** Budget snapshot before the adjustment. */
  from: ResourceBudget;
  /** Budget snapshot after the adjustment. */
  to: ResourceBudget;
};

/**
 * Static profile of the host machine, read once at startup by `systemProbe`
 * (criterion 5.1) and used to derive the suggested preset.
 */
export type MachineProfile = {
  /** Total physical RAM (MB). */
  totalMemMB: number;
  /** Number of logical CPU cores. */
  cpuCores: number;
  /** Whether a discrete GPU is present. */
  hasDiscreteGPU: boolean;
  /** Free disk space (MB) on the relevant volume. */
  freeDiskMB: number;
};

/**
 * The complete, persisted state of the ResourceCoordinator.
 *
 * Stored as `resource-state.json` in the app data directory. Mirrors the Data
 * Models section of `design.md`.
 */
export type ResourceState = {
  /** Static machine profile read at startup. */
  machine: MachineProfile;
  /** Current operating mode. */
  mode: ResourceMode;
  /** Preset currently reflected by {@link ResourceState.budget}. */
  preset: ResourcePreset;
  /** Active resource budget being enforced. */
  budget: ResourceBudget;
  /** Leases currently held by running tasks. */
  active: Lease[];
  /** Tasks waiting for a lease because the budget is exhausted. */
  queued: QueuedTask[];
  /** History of automatic budget adjustments and their reasons. */
  lastAdjustments: BudgetAdjustment[];
};

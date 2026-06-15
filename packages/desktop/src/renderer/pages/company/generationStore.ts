/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Background "design a company" store.
 *
 * Designing a company from a description is a long single model call. If the
 * work lived in a React component's state, switching tabs would unmount the
 * Company page and the user would lose the in-flight progress (it *looks* like
 * the generation stopped, even though the Main-process call keeps running).
 *
 * This module-level store decouples the task from any component: the generation
 * runs here, survives unmount/remount, and notifies subscribers. The Company
 * page (via {@link useCompanyState}) subscribes on mount and reads the current
 * state — so leaving and returning to the tab shows the live progress and the
 * final result, never a silent reset.
 *
 * Process boundary: Renderer module. No Node.js APIs — the actual work is the
 * injected `run` function (the company bridge call).
 */

import type { CreateOutcome } from './useCompanyState';

/** Live state of a background generation for one company id. */
export type GenerationState = {
  /** Whether a generation is currently running for this company. */
  running: boolean;
  /** When the current/last run started (Unix ms), for an elapsed timer. */
  startedAt?: number;
  /** The outcome of the last finished run (cleared while running). */
  outcome?: CreateOutcome;
};

/** A snapshot per company id. */
type StoreState = Record<string, GenerationState>;

const IDLE: GenerationState = { running: false };

let state: StoreState = {};
const listeners = new Set<() => void>();
/** In-flight promises keyed by company id, so a duplicate start is a no-op. */
const inFlight = new Map<string, Promise<CreateOutcome>>();

const notify = (): void => {
  for (const l of listeners) l();
};

const setFor = (companyId: string, patch: Partial<GenerationState>): void => {
  state = { ...state, [companyId]: { ...(state[companyId] ?? IDLE), ...patch } };
  notify();
};

/** Subscribe to store changes; returns an unsubscribe function. */
export const subscribeGeneration = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Read the current generation state for a company id (stable IDLE when unknown). */
export const getGenerationState = (companyId: string | null): GenerationState =>
  companyId ? (state[companyId] ?? IDLE) : IDLE;

/** Whether any company currently has a generation running. */
export const isAnyGenerationRunning = (): boolean => Object.values(state).some((s) => s.running);

/**
 * Start (or join) a background generation for `companyId`.
 *
 * The work runs detached from the caller's component: it keeps going across tab
 * switches / unmounts. If a generation is already running for this id, the
 * existing promise is returned (no duplicate run). Always resolves with the
 * {@link CreateOutcome}; never rejects.
 *
 * @param companyId The company being designed.
 * @param run       The actual generation call (the bridge `createFromDescription`).
 */
export const startGeneration = (companyId: string, run: () => Promise<CreateOutcome>): Promise<CreateOutcome> => {
  const existing = inFlight.get(companyId);
  if (existing) return existing;

  setFor(companyId, { running: true, startedAt: Date.now(), outcome: undefined });

  const promise = (async (): Promise<CreateOutcome> => {
    try {
      const outcome = await run();
      setFor(companyId, { running: false, outcome });
      return outcome;
    } catch (error) {
      const outcome: CreateOutcome = {
        ok: false,
        reason: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
      setFor(companyId, { running: false, outcome });
      return outcome;
    } finally {
      inFlight.delete(companyId);
    }
  })();

  inFlight.set(companyId, promise);
  return promise;
};

/** Clear the remembered outcome for a company (e.g. after the UI has shown it). */
export const clearGenerationOutcome = (companyId: string): void => {
  const current = state[companyId];
  if (current && !current.running && current.outcome) {
    setFor(companyId, { outcome: undefined });
  }
};

/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { resource } from '@/common/adapter/ipcBridge';
import type { ApplicablePreset, ResourceBudget, ResourceMode, ResourceState } from '@process/resource/leaseTypes';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Status of the initial {@link ResourceState} fetch.
 * - `loading` — the first `getState` invoke is in flight.
 * - `ready`   — a state snapshot is available.
 * - `error`   — the coordinator could not be reached (e.g. the IPC handler is
 *   not registered yet — see task 15.1).
 */
export type ResourceLoadStatus = 'loading' | 'ready' | 'error';

/**
 * Shape returned by {@link useResourceState}: the live coordinator snapshot plus
 * the mutating actions wired to the typed `ipcBridge.resource` providers.
 */
export type UseResourceState = {
  state: ResourceState | null;
  status: ResourceLoadStatus;
  setMode: (mode: ResourceMode) => Promise<void>;
  applyPreset: (preset: ApplicablePreset) => Promise<void>;
  setBudget: (budget: Partial<ResourceBudget>) => Promise<void>;
};

/**
 * Subscribe to the ResourceCoordinator state for the Dashboard (Requirement 5.2).
 *
 * Reads the current snapshot once via `getState`, then live-updates by listening
 * to the `stateChanged` emitter (main → renderer push) so the UI reflects leases
 * being granted/released and the Tier-B self-balancing in real time. Each
 * mutating action returns the freshly-computed state from the bridge, which is
 * applied immediately so the UI does not wait for the broadcast round-trip.
 */
export function useResourceState(): UseResourceState {
  const [state, setState] = useState<ResourceState | null>(null);
  const [status, setStatus] = useState<ResourceLoadStatus>('loading');
  // Guard against state updates after the component unmounts.
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;

    const load = async () => {
      try {
        const snapshot = await resource.getState.invoke();
        if (!aliveRef.current) return;
        if (snapshot) {
          setState(snapshot);
          setStatus('ready');
        } else {
          setStatus('error');
        }
      } catch {
        if (!aliveRef.current) return;
        setStatus('error');
      }
    };

    void load();

    // Live updates: every coordinator state change is pushed here.
    const unsubscribe = resource.stateChanged.on((next) => {
      if (!aliveRef.current || !next) return;
      setState(next);
      setStatus('ready');
    });

    return () => {
      aliveRef.current = false;
      unsubscribe();
    };
  }, []);

  const setMode = useCallback(async (mode: ResourceMode) => {
    const next = await resource.setMode.invoke({ mode });
    if (aliveRef.current && next) setState(next);
  }, []);

  const applyPreset = useCallback(async (preset: ApplicablePreset) => {
    const next = await resource.applyPreset.invoke({ preset });
    if (aliveRef.current && next) setState(next);
  }, []);

  const setBudget = useCallback(async (budget: Partial<ResourceBudget>) => {
    const next = await resource.setBudget.invoke({ budget });
    if (aliveRef.current && next) setState(next);
  }, []);

  return { state, status, setMode, applyPreset, setBudget };
}

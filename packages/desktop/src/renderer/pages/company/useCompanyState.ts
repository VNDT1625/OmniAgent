/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CompanyStructure, RoleAssignment, RoleNode } from '@process/company/companyOrchestrator';
import type { ListAgentsResponse, StructureDivisionInput } from '@process/company/companyBridge';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { companyClient } from './companyBridgeClient';
import { startGeneration, subscribeGeneration, getGenerationState } from './generationStore';
import {
  consumeRequestedActiveCompany,
  loadKnownCompanies,
  loadStrengthsGuidance,
  saveKnownCompanies,
  saveStrengthsGuidance,
} from './constants';

/**
 * Loading status for an async company resource (structure or rules).
 * - `idle`    — nothing requested yet (no active company).
 * - `loading` — a fetch is in flight.
 * - `ready`   — data is available.
 * - `error`   — the company service could not be reached (e.g. the IPC handler
 *   is not registered yet — see Task 15.1).
 */
export type CompanyLoadStatus = 'idle' | 'loading' | 'ready' | 'error';

/**
 * Outcome of a {@link UseCompanyState.createFromDescription} call.
 *
 * A flat shape (rather than a discriminated union) so consumers can read
 * `reason` without relying on control-flow narrowing — the project tsconfig
 * runs without `strictNullChecks`, where discriminant narrowing after an early
 * `return` does not reliably drop the success member. `reason` is only
 * meaningful when `ok` is `false`. `message` carries the backend error text.
 */
export type CreateOutcome = { ok: boolean; reason?: 'notWired' | 'error'; message?: string };

/**
 * Shape returned by {@link useCompanyState}: the company roster, the active
 * company's structure and rules, and the actions wired to {@link companyClient}.
 */
export type UseCompanyState = {
  knownIds: string[];
  activeId: string | null;
  selectCompany: (companyId: string) => void;
  addCompany: (companyId: string) => void;
  forgetCompany: (companyId: string) => Promise<boolean>;
  structure: CompanyStructure | null;
  structureStatus: CompanyLoadStatus;
  refreshStructure: () => void;
  rules: string[];
  rulesStatus: CompanyLoadStatus;
  saveRules: (rules: string[]) => Promise<boolean>;
  createFromDescription: (companyId: string, description: string) => Promise<CreateOutcome>;
  /** User-authored guidance on which executor is strong at what (app-level, reused per company). */
  strengthsGuidance: string;
  /** Persist the executor-strengths guidance; reused by every future company generation. */
  saveStrengthsGuidance: (guidance: string) => void;
  /** Assignable executor pool (CLIs + assistants + provider models). */
  agents: ListAgentsResponse;
  /** Assign an executor to one role; refreshes the structure on success. */
  setAssignment: (roleId: string, assignment: RoleAssignment) => Promise<boolean>;
  /** Accept all draft assistants in the active company; returns the created count. */
  acceptDrafts: () => Promise<number>;
  /** Number of roles in the current structure backed by a draft assignment. */
  draftCount: number;
  /** Manually replace the active company's structure (divisions/workers/names). */
  updateStructure: (input: {
    presidentName?: string;
    divisions: StructureDivisionInput[];
    directWorkerCount?: number;
    directDivisionId?: string;
  }) => Promise<boolean>;
  /**
   * Whether a "design from description" generation is currently running for the
   * active company (survives tab switches — the task runs in the background store).
   */
  generationRunning: boolean;
  /** Unix ms when the current/last generation started (for an elapsed timer). */
  generationStartedAt?: number;
};

/** Count roles in a structure whose assignment is still a pending draft. */
const countDrafts = (structure: CompanyStructure | null): number => {
  if (!structure) return 0;
  let count = 0;
  const walk = (node: RoleNode): void => {
    if (node.assignment?.kind === 'draft') count += 1;
    for (const child of node.children) walk(child);
  };
  walk(structure.root);
  return count;
};

const EMPTY_AGENTS: ListAgentsResponse = {
  clis: [],
  assistants: [],
  engineIds: [],
  models: [],
  mcpServers: [],
  skills: [],
  modes: [],
};

/**
 * Manage the Company UI state (Requirement 3.1).
 *
 * The company bridge addresses companies by id and exposes no "list" channel, so
 * the roster of known company ids is kept locally (persisted to `localStorage`).
 * Selecting a company loads its role structure (`getStructure`) and rules
 * (`getRules`); both degrade to an `error` status if the Main-process bridge is
 * not registered yet, which the UI renders as a friendly empty/error state.
 */
export function useCompanyState(): UseCompanyState {
  const [knownIds, setKnownIds] = useState<string[]>(() => loadKnownCompanies());
  const [activeId, setActiveId] = useState<string | null>(() => {
    const known = loadKnownCompanies();
    // Honour a Quick Active hand-off when the requested company is already known.
    const requested = consumeRequestedActiveCompany();
    if (requested && known.includes(requested)) return requested;
    return known[0] ?? null;
  });

  const [structure, setStructure] = useState<CompanyStructure | null>(null);
  const [structureStatus, setStructureStatus] = useState<CompanyLoadStatus>('idle');
  const [rules, setRules] = useState<string[]>([]);
  const [rulesStatus, setRulesStatus] = useState<CompanyLoadStatus>('idle');
  const [agents, setAgents] = useState<ListAgentsResponse>(EMPTY_AGENTS);
  const [strengthsGuidance, setStrengthsGuidanceState] = useState<string>(() => loadStrengthsGuidance());

  // Guard against state updates after the component unmounts.
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  // Persist the roster whenever it changes.
  useEffect(() => {
    saveKnownCompanies(knownIds);
  }, [knownIds]);

  // Load the assignable executor pool once on mount.
  useEffect(() => {
    void (async () => {
      try {
        const res = await companyClient.listAgents.invoke();
        if (!aliveRef.current) return;
        const ok = (res as { ok?: boolean } | undefined)?.ok;
        const data = (res as { data?: ListAgentsResponse } | undefined)?.data;
        if (ok && data) setAgents(data);
      } catch {
        // Pool is non-critical; leave empty on failure.
      }
    })();
  }, []);

  const rememberId = useCallback((companyId: string) => {
    setKnownIds((prev) => (prev.includes(companyId) ? prev : [...prev, companyId]));
  }, []);

  const loadStructure = useCallback(async (companyId: string) => {
    setStructureStatus('loading');
    try {
      const res = await companyClient.getStructure.invoke({ companyId });
      if (!aliveRef.current) return;
      if (res && res.ok && res.data) {
        setStructure(res.data);
        setStructureStatus('ready');
      } else {
        setStructure(null);
        setStructureStatus('error');
      }
    } catch {
      if (!aliveRef.current) return;
      setStructure(null);
      setStructureStatus('error');
    }
  }, []);

  const loadRules = useCallback(async (companyId: string) => {
    setRulesStatus('loading');
    try {
      const res = await companyClient.getRules.invoke({ companyId });
      if (!aliveRef.current) return;
      setRules(res && res.ok && Array.isArray(res.data) ? res.data : []);
      setRulesStatus(res && res.ok ? 'ready' : 'error');
    } catch {
      if (!aliveRef.current) return;
      setRules([]);
      setRulesStatus('error');
    }
  }, []);

  // Load the active company's structure + rules whenever it changes.
  useEffect(() => {
    if (!activeId) {
      setStructure(null);
      setStructureStatus('idle');
      setRules([]);
      setRulesStatus('idle');
      return;
    }
    void loadStructure(activeId);
    void loadRules(activeId);
  }, [activeId, loadStructure, loadRules]);

  const selectCompany = useCallback(
    (companyId: string) => {
      rememberId(companyId);
      setActiveId(companyId);
    },
    [rememberId]
  );

  const addCompany = useCallback(
    (companyId: string) => {
      rememberId(companyId);
      setActiveId(companyId);
    },
    [rememberId]
  );

  const forgetCompany = useCallback(async (companyId: string): Promise<boolean> => {
    // Delete the company on disk FIRST and await the result, so the UI only
    // forgets the roster id when the on-disk folder is actually gone. Without
    // awaiting, a failed/slow delete left a stale company.json behind and a
    // later create-with-the-same-id merged the old structure/assignments back.
    let deletedOk = false;
    try {
      const res = await companyClient.deleteCompany.invoke({ companyId });
      deletedOk = (res as { ok?: boolean } | undefined)?.ok === true;
    } catch {
      deletedOk = false;
    }
    // Forget remembered role→conversation mappings for this company so re-creating
    // it does not re-open the previous (now stale) president/employee chats.
    if (typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem('github.com/VNDT1625/OmniAgentpany.roleConversations');
        if (raw) {
          const parsed: unknown = JSON.parse(raw);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const next: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
              if (!key.startsWith(`${companyId}::`)) next[key] = value;
            }
            window.localStorage.setItem('github.com/VNDT1625/OmniAgentpany.roleConversations', JSON.stringify(next));
          }
        }
      } catch {
        // Storage failures are non-critical.
      }
    }
    if (aliveRef.current) {
      setKnownIds((prev) => {
        const next = prev.filter((id) => id !== companyId);
        setActiveId((current) => (current === companyId ? (next[0] ?? null) : current));
        return next;
      });
    }
    return deletedOk;
  }, []);

  const refreshStructure = useCallback(() => {
    if (activeId) void loadStructure(activeId);
  }, [activeId, loadStructure]);

  const saveRules = useCallback(
    async (nextRules: string[]): Promise<boolean> => {
      if (!activeId) return false;
      try {
        const res = await companyClient.setRules.invoke({ companyId: activeId, rules: nextRules });
        if (res && res.ok && res.data) {
          if (aliveRef.current) {
            setRules(res.data.rules);
            setRulesStatus('ready');
          }
          return true;
        }
        return false;
      } catch {
        return false;
      }
    },
    [activeId]
  );

  const createFromDescription = useCallback(
    async (companyId: string, description: string): Promise<CreateOutcome> => {
      // BUG FIX: switch the active company to `companyId` IMMEDIATELY (before the
      // async work) so the progress bar — which reads `getGenerationState(activeId)`
      // — tracks the in-flight generation right away. Without this, activeId is
      // still the previous id, getGenerationState returns IDLE, and the bar
      // appears empty until the gen finishes.
      rememberId(companyId);
      setActiveId(companyId);

      // Delegate to the background store so the task survives tab switches.
      // If a generation is already running for this id, startGeneration returns
      // the existing promise (no duplicate run).
      const outcome = await startGeneration(companyId, async () => {
        try {
          const res = await companyClient.createFromDescription.invoke({
            companyId,
            description,
            strengthsGuidance: strengthsGuidance.trim() || undefined,
          });
          if (res && res.ok && res.data) {
            const config = res.data;
            // The id may have been canonicalised by the backend; re-sync.
            if (config.companyId !== companyId) {
              rememberId(config.companyId);
              setActiveId(config.companyId);
            }
            void loadStructure(config.companyId);
            void loadRules(config.companyId);
            return { ok: true };
          }
          const failure = res as { ok: false; error?: string; code?: 'no-model' | 'error' } | undefined;
          return {
            ok: false,
            reason: failure && failure.code === 'no-model' ? 'notWired' : 'error',
            message: failure ? failure.error : undefined,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return { ok: false, reason: 'error', message };
        }
      });
      return outcome;
    },
    [rememberId, loadStructure, loadRules, strengthsGuidance]
  );

  // Subscribe to the background generation store so the component re-renders
  // when the generation finishes — even if it was started before this mount.
  const genState = useSyncExternalStore(subscribeGeneration, () => getGenerationState(activeId));

  const setAssignment = useCallback(
    async (roleId: string, assignment: RoleAssignment): Promise<boolean> => {
      if (!activeId) return false;
      try {
        const res = await companyClient.setAssignment.invoke({ companyId: activeId, roleId, assignment });
        const ok = (res as { ok?: boolean } | undefined)?.ok === true;
        if (ok) void loadStructure(activeId);
        return ok;
      } catch {
        return false;
      }
    },
    [activeId, loadStructure]
  );

  const acceptDrafts = useCallback(async (): Promise<number> => {
    if (!activeId) return 0;
    try {
      const res = await companyClient.acceptDrafts.invoke({ companyId: activeId });
      const data = res as { ok?: boolean; data?: { created?: number } } | undefined;
      if (data?.ok && data.data) {
        void loadStructure(activeId);
        return data.data.created ?? 0;
      }
      return 0;
    } catch {
      return 0;
    }
  }, [activeId, loadStructure]);

  const draftCount = useMemo(() => countDrafts(structure), [structure]);

  const persistStrengthsGuidance = useCallback((guidance: string): void => {
    setStrengthsGuidanceState(guidance);
    saveStrengthsGuidance(guidance);
  }, []);

  const updateStructure = useCallback(
    async (input: {
      presidentName?: string;
      divisions: StructureDivisionInput[];
      directWorkerCount?: number;
      directDivisionId?: string;
    }): Promise<boolean> => {
      if (!activeId) return false;
      try {
        const res = await companyClient.updateStructure.invoke({ companyId: activeId, ...input });
        const ok = (res as { ok?: boolean } | undefined)?.ok === true;
        if (ok) void loadStructure(activeId);
        return ok;
      } catch {
        return false;
      }
    },
    [activeId, loadStructure]
  );

  return {
    knownIds,
    activeId,
    selectCompany,
    addCompany,
    forgetCompany,
    structure,
    structureStatus,
    refreshStructure,
    rules,
    rulesStatus,
    saveRules,
    createFromDescription,
    strengthsGuidance,
    saveStrengthsGuidance: persistStrengthsGuidance,
    agents,
    setAssignment,
    acceptDrafts,
    draftCount,
    updateStructure,
    generationRunning: genState.running,
    generationStartedAt: genState.startedAt,
  };
}

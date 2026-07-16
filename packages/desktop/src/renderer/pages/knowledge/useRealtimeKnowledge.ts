/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * State hook for the Realtime Knowledge inspector.
 *
 * Loads the stored facts on mount, exposes a semantic lookup, and a per-fact
 * refresh. All bridge access goes through the renderer client, which resolves
 * with `{ ok }` envelopes — so the hook degrades to an `error` status (rather
 * than throwing) when the Main-process bridge is unavailable (e.g. WebUI mode).
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { useCallback, useEffect, useState } from 'react';
import type { GroundedFact } from '@process/knowledge/realtime/rtkService';
import type { KnowledgeFact } from '@process/knowledge/realtime/rtkTypes';
import { fetchFacts, lookupFacts, refreshFact } from './realtimeKnowledgeBridgeClient';

/** Loading status for the facts list. */
export type RtkStatus = 'loading' | 'ready' | 'error';

/** The hook's public state + actions. */
export type RealtimeKnowledgeState = {
  facts: KnowledgeFact[];
  status: RtkStatus;
  /** Reload the full facts list. */
  reload: () => Promise<void>;
  /** Semantic lookup; returns grounded results (or null on failure). */
  lookup: (query: string, topK?: number) => Promise<GroundedFact[] | null>;
  /** The last lookup's notice (e.g. "one or more facts are expired"). */
  lookupNotice?: string;
  /** Force-refresh a fact; returns the updated fact (or null on failure). */
  refresh: (topicOrId: string) => Promise<KnowledgeFact | null>;
  /** Topic/id currently being refreshed, if any. */
  refreshing?: string;
};

/** Drive the Realtime Knowledge inspector. */
export const useRealtimeKnowledge = (): RealtimeKnowledgeState => {
  const [facts, setFacts] = useState<KnowledgeFact[]>([]);
  const [status, setStatus] = useState<RtkStatus>('loading');
  const [lookupNotice, setLookupNotice] = useState<string | undefined>(undefined);
  const [refreshing, setRefreshing] = useState<string | undefined>(undefined);

  const reload = useCallback(async () => {
    setStatus('loading');
    const result = await fetchFacts();
    if (result.ok) {
      setFacts(result.data);
      setStatus('ready');
    } else {
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const lookup = useCallback(async (query: string, topK?: number): Promise<GroundedFact[] | null> => {
    const result = await lookupFacts(query, topK);
    if (!result.ok) return null;
    setLookupNotice(result.data.notice);
    return result.data.facts;
  }, []);

  const refresh = useCallback(async (topicOrId: string): Promise<KnowledgeFact | null> => {
    setRefreshing(topicOrId);
    try {
      const result = await refreshFact(topicOrId);
      if (!result.ok) return null;
      // Reflect the updated fact into the list.
      setFacts((prev) => prev.map((f) => (f.id === result.data.id ? result.data : f)));
      return result.data;
    } finally {
      setRefreshing(undefined);
    }
  }, []);

  return { facts, status, reload, lookup, lookupNotice, refresh, refreshing };
};

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Gather the "currently active" surfaces for the Quick Active sidebar section
 * (Requirement: a quick-access group in the left sidebar — alongside
 * Conversations / Team / Company — that lists what is running now, e.g. open
 * browser tabs like Youtube.com and active test sessions, and jumps straight
 * there).
 *
 * This hook is a thin, read-only aggregator over the existing renderer-safe
 * bridge clients. It never throws: each source degrades to an empty list when
 * its Main-process bridge is not wired yet, so the section simply shows fewer
 * rows (or hides itself) instead of breaking the sidebar. It re-probes on window
 * focus so it stays in sync when tabs open/close or a test session starts.
 *
 * Process boundary: renderer module — no Node.js APIs.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { browserClient, type BrowserTabInfo } from '@/renderer/pages/browser/browserBridgeClient';
import { testingClient, type TestingSessionSummary } from '@/renderer/pages/testing/testingBridgeClient';

/** A single open browser tab the section can focus. */
export type ActiveBrowserTab = {
  id: string;
  /** Page title (may be empty before first navigation / load). */
  title: string;
  /** Current URL (may be empty before first navigation). */
  url: string;
};

/** A test session the section can open. */
export type ActiveTestSession = {
  id: string;
  /** Human scenario name. */
  name: string;
  /** Target platform (web / android / windows). */
  platform: string;
  /** Lifecycle status. */
  status: TestingSessionSummary['status'];
};

/** Snapshot of every active surface, plus a manual refresh trigger. */
export type ActiveSurfaces = {
  browserTabs: ActiveBrowserTab[];
  testSessions: ActiveTestSession[];
  /** Total count across all groups — handy for the empty-state / hide check. */
  total: number;
  /** Re-probe all sources. */
  refresh: () => void;
};

const EMPTY_TABS: ActiveBrowserTab[] = [];
const EMPTY_SESSIONS: ActiveTestSession[] = [];

/**
 * Aggregate the active surfaces for the sidebar. Pass `enabled = false` (e.g. on
 * non-desktop) to skip the bridge probes entirely.
 */
export function useActiveSurfaces(enabled: boolean): ActiveSurfaces {
  const [browserTabs, setBrowserTabs] = useState<ActiveBrowserTab[]>(EMPTY_TABS);
  const [testSessions, setTestSessions] = useState<ActiveTestSession[]>(EMPTY_SESSIONS);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(() => {
    if (!enabled) {
      setBrowserTabs(EMPTY_TABS);
      setTestSessions(EMPTY_SESSIONS);
      return;
    }

    browserClient
      .listTabs()
      .then((tabs: BrowserTabInfo[]) => {
        if (!aliveRef.current) return;
        setBrowserTabs(
          (Array.isArray(tabs) ? tabs : []).map((tab) => ({ id: tab.id, title: tab.title, url: tab.url }))
        );
      })
      .catch(() => {
        // Browser bridge not wired yet → no tabs, no error surfaced.
        if (aliveRef.current) setBrowserTabs(EMPTY_TABS);
      });

    testingClient
      .listSessions()
      .then((list: TestingSessionSummary[]) => {
        if (!aliveRef.current) return;
        setTestSessions(
          (Array.isArray(list) ? list : []).map((s) => ({
            id: s.sessionId,
            name: s.name,
            platform: s.platform,
            status: s.status,
          }))
        );
      })
      .catch(() => {
        // Testing bridge not wired yet → no sessions, no error surfaced.
        if (aliveRef.current) setTestSessions(EMPTY_SESSIONS);
      });
  }, [enabled]);

  // Probe on mount / when enabled changes, and keep fresh on focus.
  useEffect(() => {
    refresh();
    if (!enabled) return;
    const onFocus = () => refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled, refresh]);

  return {
    browserTabs,
    testSessions,
    total: browserTabs.length + testSessions.length,
    refresh,
  };
}

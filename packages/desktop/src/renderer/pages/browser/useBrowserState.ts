/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TabBounds } from '@process/browser/browserViewManager';
import { useCallback, useEffect, useRef, useState } from 'react';
import { browserClient, type BrowserTabInfo } from './browserBridgeClient';
import { consumeRequestedActiveTab, loadAgentModel, normalizeUrl, saveAgentModel } from './constants';

/**
 * Connection status of the Main-process browser bridge.
 * - `connecting` — the first `listTabs` probe is in flight.
 * - `ready`      — the bridge answered; tab operations work.
 * - `unavailable`— the bridge did not answer (not wired yet — see Task 15.1).
 */
export type BrowserBridgeStatus = 'connecting' | 'ready' | 'unavailable';

/**
 * Shape returned by {@link useBrowserState}: the tab roster, the active tab and
 * its agent-mode state, plus the actions wired to {@link browserClient}.
 */
export type UseBrowserState = {
  status: BrowserBridgeStatus;
  tabs: BrowserTabInfo[];
  activeTabId: string | null;
  activeTab: BrowserTabInfo | null;
  /** The AI model chosen to drive the web agent (criterion 1.2), or null. */
  agentModel: string | null;
  /** Whether the active tab is currently in web-agent mode (criterion 1.2). */
  agentMode: boolean;
  selectTab: (id: string) => void;
  openTab: (url?: string) => Promise<void>;
  closeTab: (id: string) => Promise<void>;
  navigate: (input: string) => Promise<void>;
  /** Go back in the active tab's history. */
  goBack: () => void;
  /** Go forward in the active tab's history. */
  goForward: () => void;
  setAgentModel: (model: string | null) => void;
  toggleAgentMode: (enabled: boolean) => Promise<void>;
  /** Push the viewport rectangle for the active tab to the Main process. */
  reportBounds: (bounds: TabBounds) => void;
  /**
   * Begin/end an "overlay" (modal, dropdown, popover). While any overlay is
   * open the native browser view is hidden so DOM popups are not occluded by it
   * (WebContentsView always paints above the renderer DOM). Calls are
   * reference-counted so nested overlays work.
   */
  beginOverlay: () => void;
  endOverlay: () => void;
  /** Re-probe the bridge after a failure (used by the retry button). */
  retry: () => void;
};

/**
 * Manage the Browser UI state (Requirement 1, criteria 1.1, 1.2).
 *
 * Tabs live in the Main process (each backed by a `WebContentsView`); this hook
 * is a thin renderer mirror that opens / lists / navigates / closes them through
 * the IPC bridge and tracks which tab is active and whether it is a web agent.
 * Every bridge call degrades gracefully: if the bridge is not wired yet the
 * status becomes `unavailable` and the page renders a friendly notice instead of
 * hanging.
 */
export function useBrowserState(): UseBrowserState {
  const [status, setStatus] = useState<BrowserBridgeStatus>('connecting');
  const [tabs, setTabs] = useState<BrowserTabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [agentMode, setAgentMode] = useState(false);
  const [agentModel, setAgentModelState] = useState<string | null>(() => loadAgentModel());

  // Guard against state updates after the component unmounts.
  const aliveRef = useRef(true);
  // A tab id the Quick Active dock asked us to focus on mount (consumed once).
  const requestedTabRef = useRef<string | null>(consumeRequestedActiveTab());
  // Latest bounds requested by the viewport; pushed (rAF-throttled + deduped) per active tab.
  const lastBoundsRef = useRef<TabBounds | null>(null);
  // The bounds we most recently SENT, so we can skip redundant IPC pushes.
  const sentBoundsRef = useRef<TabBounds | null>(null);
  const boundsRafRef = useRef<number | null>(null);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      if (boundsRafRef.current !== null) cancelAnimationFrame(boundsRafRef.current);
      // Leaving the Browser page: hide every native WebContentsView so it stops
      // painting over whatever screen the user navigates to next (the views are
      // Main-process overlays that are NOT part of the React tree). They are
      // shown again on return via the active-tab effect below.
      void browserClient.hideAll().catch(() => {});
    };
  }, []);

  const refreshTabs = useCallback(async () => {
    try {
      const list = await browserClient.listTabs();
      if (!aliveRef.current) return;
      setTabs(Array.isArray(list) ? list : []);
      setStatus('ready');
    } catch {
      if (!aliveRef.current) return;
      setStatus('unavailable');
    }
  }, []);

  // Probe the bridge once on mount (and on explicit retry).
  const [probeToken, setProbeToken] = useState(0);
  useEffect(() => {
    setStatus('connecting');
    void refreshTabs();
  }, [refreshTabs, probeToken]);

  const retry = useCallback(() => setProbeToken((n) => n + 1), []);

  // Apply live URL/title changes pushed from the Main process (incl. in-page SPA
  // navigations like switching YouTube videos) so the address bar tracks the
  // page without polling. Patches the matching tab in place.
  useEffect(() => {
    const unsubscribe = browserClient.onTabUpdated((update) => {
      if (!aliveRef.current) return;
      setTabs((prev) => {
        let changed = false;
        const next = prev.map((tab) => {
          if (tab.id !== update.id) return tab;
          if (tab.url === update.url && tab.title === update.title) return tab;
          changed = true;
          return { ...tab, url: update.url, title: update.title };
        });
        return changed ? next : prev;
      });
    });
    return unsubscribe;
  }, []);

  // Keep the active-tab pointer valid as the roster changes.
  useEffect(() => {
    if (tabs.length === 0) {
      if (activeTabId !== null) setActiveTabId(null);
      return;
    }
    // Honour a Quick Active hand-off: focus the requested tab if it still exists.
    const requested = requestedTabRef.current;
    if (requested) {
      requestedTabRef.current = null;
      if (tabs.some((tab) => tab.id === requested)) {
        if (activeTabId !== requested) setActiveTabId(requested);
        return;
      }
    }
    if (!activeTabId || !tabs.some((tab) => tab.id === activeTabId)) {
      setActiveTabId(tabs[0].id);
    }
  }, [tabs, activeTabId]);

  // Load the active tab's agent-mode flag whenever it changes.
  useEffect(() => {
    if (!activeTabId) {
      setAgentMode(false);
      return;
    }
    let cancelled = false;
    browserClient
      .getAgentMode({ id: activeTabId })
      .then((state) => {
        if (!cancelled && aliveRef.current) setAgentMode(Boolean(state?.enabled));
      })
      .catch(() => {
        if (!cancelled && aliveRef.current) setAgentMode(false);
      });
    return () => {
      cancelled = true;
    };
  }, [activeTabId]);

  const selectTab = useCallback((id: string) => {
    setActiveTabId(id);
    void browserClient.show({ id }).catch(() => {});
  }, []);

  const openTab = useCallback(
    async (url?: string) => {
      try {
        const target = url ? normalizeUrl(url) : undefined;
        const result = await browserClient.openTab(target ? { url: target } : {});
        if (!aliveRef.current) return;
        setActiveTabId(result.id);
        await refreshTabs();
      } catch {
        if (aliveRef.current) setStatus('unavailable');
      }
    },
    [refreshTabs]
  );

  const closeTab = useCallback(
    async (id: string) => {
      try {
        await browserClient.destroyTab({ id });
        if (!aliveRef.current) return;
        await refreshTabs();
      } catch {
        if (aliveRef.current) setStatus('unavailable');
      }
    },
    [refreshTabs]
  );

  const navigate = useCallback(
    async (input: string) => {
      const url = normalizeUrl(input);
      if (url.length === 0) return;
      let targetId = activeTabId;
      try {
        if (!targetId) {
          const result = await browserClient.openTab({ url });
          if (!aliveRef.current) return;
          targetId = result.id;
          setActiveTabId(result.id);
        } else {
          await browserClient.navigate({ id: targetId, url });
        }
        await refreshTabs();
      } catch {
        if (aliveRef.current) setStatus('unavailable');
      }
    },
    [activeTabId, refreshTabs]
  );

  const goBack = useCallback(() => {
    if (!activeTabId) return;
    void browserClient
      .goBack({ id: activeTabId })
      .then(() => refreshTabs())
      .catch(() => {});
  }, [activeTabId, refreshTabs]);

  const goForward = useCallback(() => {
    if (!activeTabId) return;
    void browserClient
      .goForward({ id: activeTabId })
      .then(() => refreshTabs())
      .catch(() => {});
  }, [activeTabId, refreshTabs]);

  const setAgentModel = useCallback((model: string | null) => {
    setAgentModelState(model);
    saveAgentModel(model);
  }, []);

  const toggleAgentMode = useCallback(
    async (enabled: boolean) => {
      if (!activeTabId) return;
      try {
        const state = await browserClient.setAgentMode({ id: activeTabId, enabled });
        if (aliveRef.current) setAgentMode(Boolean(state?.enabled));
      } catch {
        // Surface as "no change"; the caller shows a message.
        throw new Error('agent-mode-failed');
      }
    },
    [activeTabId]
  );

  const reportBounds = useCallback((bounds: TabBounds) => {
    lastBoundsRef.current = bounds;
    // Throttle to one push per animation frame, and skip when the rectangle is
    // unchanged from the last one we sent. This collapses bursts of resize/scroll
    // events into at most ~60 IPC calls/sec, and usually far fewer (deduped).
    if (boundsRafRef.current !== null) return;
    boundsRafRef.current = requestAnimationFrame(() => {
      boundsRafRef.current = null;
      const id = activeTabIdRef.current;
      const next = lastBoundsRef.current;
      if (!id || !next) return;
      const prev = sentBoundsRef.current;
      if (prev && prev.x === next.x && prev.y === next.y && prev.width === next.width && prev.height === next.height) {
        return; // identical rect — no need to bother the Main process
      }
      sentBoundsRef.current = next;
      void browserClient.setBounds({ id, bounds: next }).catch(() => {});
    });
  }, []);

  // Reference-counted overlay suspension: while >0 overlays are open, the native
  // view is hidden so DOM modals/dropdowns/popovers are visible above it.
  const overlayCountRef = useRef(0);
  const beginOverlay = useCallback(() => {
    overlayCountRef.current += 1;
    if (overlayCountRef.current === 1) {
      void browserClient.hideAll().catch(() => {});
    }
  }, []);
  const endOverlay = useCallback(() => {
    overlayCountRef.current = Math.max(0, overlayCountRef.current - 1);
    if (overlayCountRef.current === 0) {
      const id = activeTabIdRef.current;
      if (id) void browserClient.show({ id }).catch(() => {});
    }
  }, []);

  // Keep a ref to the active id so the debounced bounds push reads the latest.
  const activeTabIdRef = useRef<string | null>(activeTabId);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
    if (activeTabId) {
      // Show the active tab exclusively (hides any other tab's view) and re-push
      // its bounds so it repositions — covers both tab-switch and returning to
      // the Browser page after it was hidden on unmount.
      void browserClient.show({ id: activeTabId }).catch(() => {});
      if (lastBoundsRef.current) {
        void browserClient.setBounds({ id: activeTabId, bounds: lastBoundsRef.current }).catch(() => {});
      }
    }
  }, [activeTabId]);

  const activeTab = activeTabId ? (tabs.find((tab) => tab.id === activeTabId) ?? null) : null;

  return {
    status,
    tabs,
    activeTabId,
    activeTab,
    agentModel,
    agentMode,
    selectTab,
    openTab,
    closeTab,
    navigate,
    goBack,
    goForward,
    setAgentModel,
    toggleAgentMode,
    reportBounds,
    beginOverlay,
    endOverlay,
    retry,
  };
}

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useLiveBrowserTabs` — a renderer mirror of the live **surfaces** the Super
 * agent is driving, for the in-conversation multi-frame watch panel.
 *
 * Super is end-to-end: the agent can drive several app capabilities at once,
 * each shown as its own live frame in the chat. Today that means:
 *  - **browser** tabs (native `WebContentsView`s) — from `browserClient.listTabs`;
 *  - **editor** frames (Studio `UniversalEditor`) — from `editorControlClient`.
 *
 * This hook lists both and keeps them fresh (poll + live `browser.tab-updated`
 * patches), so the grid can render browser frames and editor frames side by
 * side. Visibility for browser tabs is non-exclusive (each frame shows its own
 * view); hidden/background tabs (e.g. the agent's research tab) are filtered out.
 *
 * Read-only watching: it never opens/navigates/edits — the agent does. When the
 * panel closes, `hideAll()` stops every native browser view.
 *
 * Renderer-only module: talks to the Main process via the bridge clients.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { browserClient, type BrowserTabInfo } from '@renderer/pages/browser/browserBridgeClient';
import {
  editorControlClient,
  type EditorFrameInfo,
} from '@renderer/pages/conversation/components/superWatch/editorControlClient';

/** How often (ms) the watch panel re-lists surfaces so new ones appear. */
const WATCH_POLL_MS = 1500;

/** Public shape returned by {@link useLiveBrowserTabs}. */
export type UseLiveBrowserTabs = {
  /** Live browser tabs the agent has open (one frame each). */
  tabs: BrowserTabInfo[];
  /** Live editor frames the agent has open (one frame each). */
  editors: EditorFrameInfo[];
  /** Total live surfaces (browser + editor). */
  total: number;
  /** Whether the first probe is still in flight. */
  loading: boolean;
};

/**
 * Mirror the live surfaces (browser tabs + editor frames) for the watch panel.
 *
 * @param active When false (panel closed) all native browser views are hidden
 *   and no probing happens, so a closed panel never paints over the chat.
 */
export function useLiveBrowserTabs(active: boolean): UseLiveBrowserTabs {
  const [tabs, setTabs] = useState<BrowserTabInfo[]>([]);
  const [editors, setEditors] = useState<EditorFrameInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const aliveRef = useRef(true);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    // Fetch both planes in parallel; neither blocks the other.
    const [list, frames] = await Promise.all([
      browserClient.listTabs().catch((): BrowserTabInfo[] => []),
      editorControlClient.listFrames().catch((): EditorFrameInfo[] => []),
    ]);
    if (!aliveRef.current) return;
    // Only foreground browser tabs become frames; hidden research tabs are
    // off-screen and must not show.
    const foreground = (Array.isArray(list) ? list : []).filter((tab) => tab.visible !== false);
    setTabs(foreground);
    setEditors(Array.isArray(frames) ? frames : []);
    setLoading(false);
  }, []);

  // Probe + poll while the panel is open; hide every native view when it closes.
  useEffect(() => {
    if (!active) {
      void browserClient.hideAll().catch(() => {});
      return;
    }
    setLoading(true);
    void refresh();
    const timer = setInterval(() => void refresh(), WATCH_POLL_MS);
    return () => {
      clearInterval(timer);
      void browserClient.hideAll().catch(() => {});
    };
  }, [active, refresh]);

  // Live URL/title patches for browser tabs (in-page SPA nav, e.g. YouTube).
  useEffect(() => {
    if (!active) return;
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
  }, [active]);

  return { tabs, editors, total: tabs.length + editors.length, loading };
}

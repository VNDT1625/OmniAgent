/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `ConversationWatchOverlay` — host for the in-chat live-browser frames.
 *
 * Rendered INSIDE the chat content column (via `ChatLayout`'s
 * `chatColumnOverlay` slot), so the agent's browser frames appear as part of the
 * conversation — like ChatGPT's agent canvas — rather than a panel glued to the
 * window's right edge.
 *
 * It owns the open/auto-open state:
 *  - it auto-opens the moment the agent opens its first browser tab (a light
 *    poll watches for that while closed);
 *  - the header "Watch" button toggles it via the `super.watch.toggle` event;
 *  - it announces its open state back via `super.watch.state` so the header
 *    button stays in sync.
 *
 * Only mounts its machinery when Super is on for this conversation. Desktop-only.
 *
 * Renderer-only module: positions native views via IPC; no Node.js APIs.
 */

import { isElectronDesktop } from '@/renderer/utils/platform';
import { emitter, useAddEventListener } from '@/renderer/utils/emitter';
import { browserClient } from '@renderer/pages/browser/browserBridgeClient';
import { editorControlClient } from './editorControlClient';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useSuperMode } from '../../hooks/useSuperMode';
import LiveBrowserWatch from './LiveBrowserWatch';

/** Props for {@link ConversationWatchOverlay}. */
export type ConversationWatchOverlayProps = {
  /** The conversation this overlay belongs to. */
  conversationId?: string;
};

/** Poll interval (ms) for detecting the agent's first opened tab while closed. */
const TAB_POLL_MS = 1500;

/**
 * Invisible poller: while closed but Super is on, polls the live tab count so
 * the overlay can auto-open the moment the agent opens its first browser tab.
 */
const TabPoller: React.FC<{ onCount: (count: number) => void }> = ({ onCount }) => {
  useEffect(() => {
    let alive = true;
    const probe = () => {
      // Count foreground browser tabs + open editor frames. A hidden research
      // tab must not auto-open; an editor frame should.
      const browserP = browserClient
        .listTabs()
        .then((tabs) => (Array.isArray(tabs) ? tabs.filter((t) => t.visible !== false).length : 0))
        .catch(() => 0);
      const editorP = editorControlClient
        .listFrames()
        .then((frames) => (Array.isArray(frames) ? frames.length : 0))
        .catch(() => 0);
      void Promise.all([browserP, editorP]).then(([b, e]) => {
        if (alive) onCount(b + e);
      });
    };
    probe();
    const timer = setInterval(probe, TAB_POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [onCount]);
  return null;
};

/** Owns the in-chat live-browser overlay state and renders it in the chat column. */
const ConversationWatchOverlay: React.FC<ConversationWatchOverlayProps> = ({ conversationId }) => {
  const sup = useSuperMode(conversationId);
  const [open, setOpen] = useState(false);

  const autoOpenedRef = useRef(false);
  const openRef = useRef(false);
  const superEnabledRef = useRef(sup.enabled);
  useEffect(() => {
    superEnabledRef.current = sup.enabled;
  }, [sup.enabled]);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  // Broadcast open state so the header Watch button can reflect it.
  useEffect(() => {
    if (conversationId) emitter.emit('super.watch.state', conversationId, open);
  }, [conversationId, open]);

  // Header button → toggle; header switch-off → explicit set.
  useAddEventListener(
    'super.watch.toggle',
    (id: string) => {
      if (id === conversationId) setOpen((v) => !v);
    },
    [conversationId]
  );
  useAddEventListener(
    'super.watch.set',
    (id: string, next: boolean) => {
      if (id === conversationId) setOpen(next);
    },
    [conversationId]
  );

  // Close + reset when Super turns off or the conversation changes.
  useEffect(() => {
    if (!sup.enabled) {
      setOpen(false);
      autoOpenedRef.current = false;
    }
  }, [sup.enabled]);
  useEffect(() => {
    setOpen(false);
    autoOpenedRef.current = false;
  }, [conversationId]);

  // Auto-open the first time the agent opens a tab.
  const handleTabCount = useCallback((count: number): void => {
    if (superEnabledRef.current && count > 0 && !openRef.current && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      setOpen(true);
    }
    if (count === 0) autoOpenedRef.current = false;
  }, []);

  if (!isElectronDesktop() || !sup.available || !conversationId) return null;

  return (
    <>
      <LiveBrowserWatch open={sup.enabled && open} onClose={() => setOpen(false)} onTabCountChange={handleTabCount} />
      {/* While closed but Super on, watch for the agent's first tab to auto-open. */}
      {sup.enabled && !open && <TabPoller onCount={handleTabCount} />}
    </>
  );
};

export default ConversationWatchOverlay;

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { isElectronDesktop } from '@/renderer/utils/platform';
import { useAddEventListener } from '@/renderer/utils/emitter';
import { Compass } from '@icon-park/react';
import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import AddressBar from './components/AddressBar';
import AgentChatPanel from './components/AgentChatPanel';
import AgentModePicker from './components/AgentModePicker';
import BridgeNotice from './components/BridgeNotice';
import BrowserToolbar from './components/BrowserToolbar';
import BrowserViewport from './components/BrowserViewport';
import TabStrip from './components/TabStrip';
import { browserClient } from './browserBridgeClient';
import {
  clampZoom,
  consumeRequestedChatOpen,
  DEFAULT_ZOOM,
  loadChatSide,
  saveChatSide,
  stepZoom,
  type ChatSide,
  type SubtitleCue,
} from './constants';
import { useAgentChat } from './useAgentChat';
import { useBrowserState } from './useBrowserState';

/**
 * Embedded browser + web-agent surface (Requirement 1 — criteria 1.1, 1.2,
 * 1.6).
 *
 * Composes the tab strip, address bar, view toolbar (zoom / fullscreen / chat),
 * the reserved viewport region (where the Main-process `WebContentsView`
 * paints), the movable web-agent chat dock, and the Vietnamese subtitle overlay.
 * All browser-service access flows through {@link useBrowserState} /
 * {@link useAgentChat}, which degrade gracefully to a friendly notice when the
 * Main-process bridge is not wired yet.
 *
 * The page depends on the native IPC browser bridge + `WebContentsView`, so it
 * is gated to the desktop app — in WebUI mode it shows a short notice instead.
 */
const BrowserPage: React.FC = () => {
  const { t } = useTranslation();
  const isDesktop = isElectronDesktop();

  const {
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
  } = useBrowserState();

  const chat = useAgentChat(activeTabId, agentModel);

  // Subtitle overlay is presentational for now; the live cue stream is wired in
  // a later task. It starts empty so the overlay shows its idle state.
  const [subtitlesEnabled, setSubtitlesEnabled] = useState(false);
  const [subtitleCues] = useState<SubtitleCue[]>([]);

  // View affordances (criterion 1.1): zoom, fullscreen, chat dock side + draft.
  const [zoom, setZoom] = useState(DEFAULT_ZOOM);
  const [fullscreen, setFullscreen] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [chatSide, setChatSide] = useState<ChatSide>(() => loadChatSide());
  const [chatDraft, setChatDraft] = useState('');
  // Whether the agent-controls row (model picker + toolbar) is shown. Collapsed
  // by default for a compact, browser-like bar; the chevron in the URL bar toggles it.
  const [controlsExpanded, setControlsExpanded] = useState(false);

  const hasActiveTab = Boolean(activeTabId);
  const controlsDisabled = status === 'unavailable';

  // Open the chat dock automatically the first time agent mode is enabled, and
  // reveal the controls row so the model picker / toggle are visible.
  useEffect(() => {
    if (agentMode) {
      setChatOpen(true);
      setControlsExpanded(true);
    }
  }, [agentMode]);

  // When a URL is opened from OUTSIDE the app (deep link / default-browser
  // hand-off), auto-open the chat dock so the page lands with the AI panel
  // ready — that surface has no other obvious entry point to ask the AI.
  useEffect(() => {
    if (consumeRequestedChatOpen()) {
      setChatOpen(true);
      setControlsExpanded(true);
    }
  }, []);

  // Also react when the page is ALREADY mounted (user was on the Browser page)
  // and a new external URL arrives — the mount effect above won't re-fire.
  useAddEventListener(
    'browser.openChat',
    () => {
      setChatOpen(true);
      setControlsExpanded(true);
    },
    []
  );

  // Push the zoom factor to the active tab whenever it or the tab changes.
  useEffect(() => {
    if (!activeTabId) return;
    void browserClient.setZoom({ id: activeTabId, factor: zoom }).catch(() => {});
  }, [activeTabId, zoom]);

  // Esc exits fullscreen.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const applyZoom = useCallback((next: number) => setZoom(clampZoom(next)), []);
  const swapChatSide = useCallback(() => {
    setChatSide((prev) => {
      const next: ChatSide = prev === 'right' ? 'left' : 'right';
      saveChatSide(next);
      return next;
    });
  }, []);

  const [allowControl, setAllowControl] = useState(false);

  const handleSend = useCallback(() => {
    const value = chatDraft;
    setChatDraft('');
    void chat.send(value, allowControl);
  }, [chat, chatDraft, allowControl]);

  if (!isDesktop) {
    return (
      <div className='flex flex-col h-full w-full'>
        <PageHeader />
        <div className='flex flex-col items-center gap-12px py-56px text-center'>
          <span className='size-48px flex-center rd-full bg-fill-2 text-t-tertiary'>
            <Compass theme='outline' size='24' />
          </span>
          <p className='m-0 max-w-420px text-13px text-t-secondary'>{t('browser.desktopOnly')}</p>
        </div>
      </div>
    );
  }

  if (status === 'unavailable') {
    return (
      <div className='flex flex-col h-full w-full'>
        <PageHeader />
        <BridgeNotice onRetry={retry} />
      </div>
    );
  }

  const showChat = chatOpen;
  const chatNode = showChat ? (
    <div className='w-360px shrink-0 min-h-0'>
      <AgentChatPanel
        messages={chat.messages}
        status={chat.status}
        ready={Boolean(agentModel) && hasActiveTab}
        draft={chatDraft}
        onDraftChange={setChatDraft}
        onSend={handleSend}
        onStop={chat.stop}
        onClear={chat.clear}
        onClose={() => setChatOpen(false)}
        onSwapSide={swapChatSide}
        allowControl={allowControl}
        onAllowControlChange={setAllowControl}
        onOverlayOpen={beginOverlay}
        onOverlayClose={endOverlay}
      />
    </div>
  ) : null;

  // Fullscreen breaks the page out of the settings content flow to cover the
  // whole window. It is rendered through a portal into document.body so no
  // ancestor stacking-context / transform / overflow can trap the fixed overlay
  // or let the app sidebar bleed over the browser toolbar.
  const innerClass = fullscreen ? 'flex flex-col gap-10px h-full w-full' : 'flex flex-col gap-12px min-h-0 flex-1';

  const shellContent = (
    <div className={innerClass}>
      <div className='flex flex-col gap-8px shrink-0'>
        {controlsExpanded && (
          <div className='flex items-center justify-between gap-12px flex-wrap'>
            <TabStrip
              tabs={tabs}
              activeTabId={activeTabId}
              disabled={controlsDisabled}
              onSelect={selectTab}
              onClose={(id) => void closeTab(id)}
              onNewTab={() => void openTab()}
            />
            <div className='flex items-center gap-10px flex-wrap'>
              <AgentModePicker
                hasActiveTab={hasActiveTab}
                agentModel={agentModel}
                agentMode={agentMode}
                onModelChange={setAgentModel}
                onToggle={toggleAgentMode}
                onOverlayOpen={beginOverlay}
                onOverlayClose={endOverlay}
              />
              <BrowserToolbar
                zoom={zoom}
                fullscreen={fullscreen}
                chatOpen={chatOpen}
                disabled={controlsDisabled || !hasActiveTab}
                onZoomIn={() => applyZoom(stepZoom(zoom, 'in'))}
                onZoomOut={() => applyZoom(stepZoom(zoom, 'out'))}
                onZoomReset={() => applyZoom(DEFAULT_ZOOM)}
                onToggleFullscreen={() => setFullscreen((v) => !v)}
                onToggleChat={() => setChatOpen((v) => !v)}
              />
            </div>
          </div>
        )}
        <AddressBar
          currentUrl={activeTab?.url ?? ''}
          disabled={controlsDisabled}
          subtitlesEnabled={subtitlesEnabled}
          controlsExpanded={controlsExpanded}
          onSubmit={(input) => void navigate(input)}
          onBack={goBack}
          onForward={goForward}
          onReload={() => activeTab && void navigate(activeTab.url)}
          onToggleSubtitles={setSubtitlesEnabled}
          onToggleControls={() => setControlsExpanded((v) => !v)}
        />
      </div>

      <div className='flex gap-12px flex-1 min-h-0'>
        {showChat && chatSide === 'left' && chatNode}
        <BrowserViewport
          hasActiveTab={hasActiveTab}
          subtitlesEnabled={subtitlesEnabled}
          subtitleCues={subtitleCues}
          onBoundsChange={reportBounds}
          onOpenTab={() => void openTab()}
        />
        {showChat && chatSide === 'right' && chatNode}
      </div>
    </div>
  );

  if (fullscreen) {
    // Top-level overlay above all app chrome (sider ~z-100, modals ~z-1001+).
    return createPortal(
      <div className='fixed inset-0 z-[2000] flex flex-col gap-10px p-12px bg-base'>{shellContent}</div>,
      document.body
    );
  }

  return (
    <div className='flex flex-col h-full w-full'>
      <PageHeader />
      {shellContent}
    </div>
  );
};

/** Compact page heading (title + one-line subtitle). */
const PageHeader: React.FC = () => {
  const { t } = useTranslation();
  return (
    <header className='mb-12px'>
      <h2 className='m-0 text-20px font-700 text-t-primary'>{t('browser.title')}</h2>
      <p className='m-0 mt-2px text-13px text-t-secondary'>{t('browser.subtitle')}</p>
    </header>
  );
};

export default BrowserPage;

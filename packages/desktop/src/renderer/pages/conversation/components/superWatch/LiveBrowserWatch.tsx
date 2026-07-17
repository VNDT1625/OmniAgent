/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `LiveBrowserWatch` — the in-chat live surface for browser and editor work.
 *
 * The watch card uses the full chat column and presents its live surfaces as a
 * tab strip. Only the selected surface is mounted, giving its native browser
 * view the full useful canvas while keeping other tabs alive in the background.
 * Collapsing or hiding this card only detaches presentation; the close button on
 * an individual browser tab is the only action here that destroys that tab.
 *
 * Renderer-only module: positions views via IPC; never renders web content.
 */

import { Button, Spin } from '@arco-design/web-react';
import { CloseSmall, Compass, Down, FileEditing, Refresh, Up } from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BrowserTabInfo } from '@renderer/pages/browser/browserBridgeClient';
import type { EditorFrameInfo } from './editorControlClient';
import { useLiveBrowserTabs } from '../../hooks/useLiveBrowserTabs';
import LiveBrowserFrame from './LiveBrowserFrame';
import LiveEditorFrame from './LiveEditorFrame';

/** Props for {@link LiveBrowserWatch}. */
export type LiveBrowserWatchProps = {
  /** Whether the surface is open (false → fully hidden, no native views shown). */
  open: boolean;
  /** Hide the surface without closing any browser tab. */
  onClose: () => void;
  /** Notify the host how many live tabs exist (so it can auto-open on first tab). */
  onTabCountChange?: (count: number) => void;
};

type BrowserSurface = { id: string; kind: 'browser'; tab: BrowserTabInfo };
type EditorSurface = { id: string; kind: 'editor'; editor: EditorFrameInfo };
type WatchSurface = BrowserSurface | EditorSurface;

/** Derive a short label for a browser tab (title → host → fallback). */
const browserLabel = (tab: BrowserTabInfo, fallback: string): string => {
  const title = tab.title.trim();
  if (title) return title;
  try {
    return new URL(tab.url).hostname.replace(/^www\./, '');
  } catch {
    return fallback;
  }
};

/** The in-chat live surface with one full-width selected tab. */
const LiveBrowserWatch: React.FC<LiveBrowserWatchProps> = ({ open, onClose, onTabCountChange }) => {
  const { t } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const [activeSurfaceId, setActiveSurfaceId] = useState<string | null>(null);
  const live = useLiveBrowserTabs(open);

  const fallback = t('workspace.watchUntitled', { defaultValue: 'Untitled' });
  const surfaces = useMemo<WatchSurface[]>(
    () => [
      ...live.tabs.map((tab): BrowserSurface => ({ id: `browser:${tab.id}`, kind: 'browser', tab })),
      ...live.editors.map((editor): EditorSurface => ({ id: `editor:${editor.filePath}`, kind: 'editor', editor })),
    ],
    [live.editors, live.tabs]
  );
  const activeSurface = surfaces.find((surface) => surface.id === activeSurfaceId) ?? null;

  useEffect(() => {
    onTabCountChange?.(live.total);
  }, [live.total, onTabCountChange]);

  useEffect(() => {
    if (!open) setCollapsed(false);
  }, [open]);

  useEffect(() => {
    setActiveSurfaceId((current) =>
      current && surfaces.some((surface) => surface.id === current) ? current : (surfaces[0]?.id ?? null)
    );
  }, [surfaces]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <section
      className={
        collapsed
          ? 'relative z-[20] mb-10px w-full min-w-0 flex shrink-0 flex-col overflow-hidden rd-14px border border-solid border-line-2 bg-base shadow-sm'
          : 'relative z-[20] mb-10px h-[min(58vh,640px)] min-h-320px w-full min-w-0 flex shrink-0 flex-col overflow-hidden rd-14px border border-solid border-line-2 bg-base shadow-sm'
      }
      aria-label={t('workspace.watchTitle')}
      data-testid='live-browser-card'
    >
      <div className='flex items-center justify-between gap-12px px-14px py-10px border-b border-solid border-line-2 bg-fill-1 shrink-0'>
        <div className='flex items-center gap-10px min-w-0'>
          <span className='size-26px flex-center rd-8px bg-primary-light-1 text-primary shrink-0'>
            <Compass theme='outline' size='15' />
          </span>
          <div className='flex flex-col min-w-0'>
            <span className='text-13px font-700 text-t-primary leading-tight'>{t('workspace.watchTitle')}</span>
            <span className='text-11px text-t-secondary truncate'>{t('workspace.watchSubtitle')}</span>
          </div>
        </div>
        <div className='flex items-center gap-8px shrink-0'>
          {live.total > 0 && (
            <span className='flex items-center gap-4px text-11px text-t-tertiary'>
              <Refresh theme='outline' size='11' />
              {t('workspace.watchLiveBadge')}
            </span>
          )}
          <Button
            shape='circle'
            size='small'
            type='secondary'
            icon={collapsed ? <Down theme='outline' size='14' /> : <Up theme='outline' size='14' />}
            aria-label={collapsed ? t('common.expand') : t('common.collapse')}
            aria-expanded={!collapsed}
            onClick={() => setCollapsed((value) => !value)}
          />
          <Button
            shape='circle'
            size='small'
            type='secondary'
            icon={<CloseSmall theme='outline' size='16' />}
            aria-label={t('common.close', { defaultValue: 'Close' })}
            onClick={onClose}
          />
        </div>
      </div>

      {!collapsed && live.total === 0 ? (
        <div className='flex-1 min-h-0 flex flex-col items-center justify-center gap-12px text-center px-24px'>
          {live.loading ? (
            <Spin />
          ) : (
            <>
              <span className='size-52px flex-center rd-full bg-fill-2 text-t-tertiary'>
                <Compass theme='outline' size='26' />
              </span>
              <p className='m-0 max-w-300px text-13px text-t-secondary'>{t('workspace.watchEmpty')}</p>
            </>
          )}
        </div>
      ) : !collapsed ? (
        <>
          <div className='w-full min-w-0 overflow-x-auto border-b border-solid border-line-2 bg-fill-1 shrink-0'>
            <ul className='flex items-center gap-6px m-0 px-10px py-8px list-none min-w-max' role='tablist'>
              {surfaces.map((surface) => {
                const active = surface.id === activeSurfaceId;
                const label = surface.kind === 'browser' ? browserLabel(surface.tab, fallback) : surface.editor.title;
                return (
                  <li
                    key={surface.id}
                    className={`flex items-center gap-2px h-32px max-w-240px rd-8px pr-4px transition-colors ${
                      active ? 'bg-fill-3' : 'bg-fill-1'
                    }`}
                  >
                    <Button
                      type='text'
                      size='small'
                      role='tab'
                      aria-selected={active}
                      className='min-w-0 max-w-190px !px-8px'
                      icon={
                        surface.kind === 'browser' ? (
                          <Compass theme='outline' size='13' />
                        ) : (
                          <FileEditing theme='outline' size='13' />
                        )
                      }
                      onClick={() => setActiveSurfaceId(surface.id)}
                    >
                      <span className='block truncate'>{label}</span>
                    </Button>
                    {surface.kind === 'browser' && (
                      <Button
                        type='text'
                        size='mini'
                        aria-label={t('browser.tab.close')}
                        icon={<CloseSmall theme='outline' size='13' />}
                        onClick={() => void live.closeBrowserTab(surface.tab.id)}
                      />
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
          <div className='flex-1 min-h-0 w-full p-10px box-border'>
            {activeSurface?.kind === 'browser' ? (
              <LiveBrowserFrame key={activeSurface.tab.id} tab={activeSurface.tab} fallbackLabel={fallback} />
            ) : activeSurface?.kind === 'editor' ? (
              <LiveEditorFrame
                key={activeSurface.editor.filePath}
                filePath={activeSurface.editor.filePath}
                title={activeSurface.editor.title}
                version={activeSurface.editor.version}
              />
            ) : null}
          </div>
        </>
      ) : null}
    </section>
  );
};

export default LiveBrowserWatch;

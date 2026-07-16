/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `LiveBrowserWatch` — the in-chat multi-frame live-browser surface for **Super**.
 *
 * When Super is ON the agent opens one or more embedded browser tabs (open a
 * site, watch a YouTube video, …). This component renders **one live frame per
 * tab, all at once in a grid, INSIDE the chat column** — so the browsers read as
 * part of the conversation (like ChatGPT's agent canvas), not a panel glued to
 * the window's right edge.
 *
 * It is positioned as an absolute overlay that fills its parent (the chat
 * content column), so it covers the message list while active and leaves the
 * rest of the app (sidebar, header) untouched. Each frame positions its own
 * native `WebContentsView` over its region via the non-exclusive `setVisible`,
 * so several views paint simultaneously.
 *
 * Read-only watching: it never opens/navigates tabs — the agent does. Closing
 * it hides every native view so nothing paints over the chat.
 *
 * Renderer-only module: positions views via IPC; never renders web content.
 */

import { Button, Spin } from '@arco-design/web-react';
import { CloseSmall, Compass, Refresh } from '@icon-park/react';
import React, { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useLiveBrowserTabs } from '../../hooks/useLiveBrowserTabs';
import LiveBrowserFrame from './LiveBrowserFrame';

/** Props for {@link LiveBrowserWatch}. */
export type LiveBrowserWatchProps = {
  /** Whether the surface is open (false → fully hidden, no native views shown). */
  open: boolean;
  /** Close the surface. */
  onClose: () => void;
  /** Notify the host how many live tabs exist (so it can auto-open on first tab). */
  onTabCountChange?: (count: number) => void;
};

/** The in-chat live-browser surface (fills the chat column, multi-frame grid). */
const LiveBrowserWatch: React.FC<LiveBrowserWatchProps> = ({ open, onClose, onTabCountChange }) => {
  const { t } = useTranslation();
  const live = useLiveBrowserTabs(open);

  const fallback = t('workspace.watchUntitled', { defaultValue: 'Untitled' });

  // Report live-tab count up so the host can auto-open on the first tab.
  const tabCount = live.tabs.length;
  useEffect(() => {
    onTabCountChange?.(tabCount);
  }, [tabCount, onTabCountChange]);

  // Close on Escape, like a dismissible surface.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  // Grid: 1 column for a single frame, 2 columns for 2+ (two browsers side by
  // side); extra frames wrap to the next row.
  const columns = live.tabs.length <= 1 ? 1 : 2;

  return (
    <div className='absolute inset-0 z-[40] flex flex-col bg-base'>
      {/* Header */}
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
          {live.tabs.length > 0 && (
            <span className='flex items-center gap-4px text-11px text-t-tertiary'>
              <Refresh theme='outline' size='11' />
              {t('workspace.watchLiveBadge')}
            </span>
          )}
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

      {/* Body: one live frame per tab, all visible at once (grid). */}
      {live.tabs.length === 0 ? (
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
      ) : (
        <div
          className='grid gap-10px flex-1 min-h-0 overflow-auto p-10px auto-rows-fr'
          style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
        >
          {live.tabs.map((tab) => (
            <LiveBrowserFrame key={tab.id} tab={tab} fallbackLabel={fallback} />
          ))}
        </div>
      )}
    </div>
  );
};

export default LiveBrowserWatch;

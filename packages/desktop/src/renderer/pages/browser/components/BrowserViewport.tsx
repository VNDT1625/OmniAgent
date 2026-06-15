/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button } from '@arco-design/web-react';
import { Compass } from '@icon-park/react';
import type { TabBounds } from '@process/browser/browserViewManager';
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import type { SubtitleCue } from '../constants';
import SubtitleOverlay from './SubtitleOverlay';

/**
 * The browser viewport region (criterion 1.1).
 *
 * Important architectural note: the actual web content is **not** rendered by
 * the renderer. It is painted by a Main-process `WebContentsView` positioned by
 * a rectangle the renderer reports. This component therefore only *reserves* a
 * region: it measures its own on-screen rectangle (relative to the window
 * content's top-left, which is where the renderer document origin sits) and
 * pushes it down via `onBoundsChange` → the `setBounds` IPC channel. The native
 * view then renders on top of this region.
 *
 * Because the native view paints over this element, the placeholder below is
 * only visible when there is no active tab (empty state) — once a tab exists the
 * `WebContentsView` covers it. The Vietnamese subtitle overlay (criterion 1.6)
 * is layered above so its captions remain visible over the native content.
 */
const BrowserViewport: React.FC<{
  hasActiveTab: boolean;
  subtitlesEnabled: boolean;
  subtitleCues: SubtitleCue[];
  onBoundsChange: (bounds: TabBounds) => void;
  onOpenTab: () => void;
}> = ({ hasActiveTab, subtitlesEnabled, subtitleCues, onBoundsChange, onOpenTab }) => {
  const { t } = useTranslation();
  const regionRef = useRef<HTMLDivElement>(null);

  // Measure the region and report its rectangle whenever it resizes or scrolls.
  useEffect(() => {
    const element = regionRef.current;
    if (!element) return;

    // Coalesce bursts of resize/scroll events into one measurement per frame to
    // avoid forced synchronous layout (getBoundingClientRect) on every event.
    let rafId: number | null = null;
    const measure = () => {
      rafId = null;
      const rect = element.getBoundingClientRect();
      onBoundsChange({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      });
    };
    const schedule = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(measure);
    };

    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [onBoundsChange]);

  return (
    <div
      ref={regionRef}
      className='relative flex-1 min-h-0 w-full rd-12px overflow-hidden bg-fill-1 b b-solid b-line-2'
    >
      {!hasActiveTab && (
        <div className='absolute inset-0 flex flex-col items-center justify-center gap-14px text-center px-24px'>
          <span className='size-56px flex-center rd-full bg-fill-2 text-t-tertiary'>
            <Compass theme='outline' size='28' />
          </span>
          <div className='flex flex-col gap-4px'>
            <p className='m-0 text-15px font-600 text-t-primary'>{t('browser.viewport.emptyTitle')}</p>
            <p className='m-0 max-w-360px text-13px text-t-secondary'>{t('browser.viewport.emptyHint')}</p>
          </div>
          <Button type='primary' icon={<Compass theme='outline' size='14' />} onClick={onOpenTab}>
            {t('browser.viewport.openFirst')}
          </Button>
        </div>
      )}

      <SubtitleOverlay enabled={subtitlesEnabled && hasActiveTab} cues={subtitleCues} />
    </div>
  );
};

export default BrowserViewport;

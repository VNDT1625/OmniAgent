/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Tooltip } from '@arco-design/web-react';
import { FullScreen, OffScreen, Minus, Plus, Robot } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Viewport toolbar (Requirement 1, criterion 1.1 — fit-to-frame / larger view).
 *
 * Groups the view-affordance controls that make a cramped embedded page usable:
 * zoom out / current level / zoom in / reset, a fullscreen (immersive) toggle,
 * and a button to show/hide the web-agent chat dock (criterion 1.2). Purely
 * presentational — all state + handlers come from the page.
 */
const BrowserToolbar: React.FC<{
  zoom: number;
  fullscreen: boolean;
  chatOpen: boolean;
  disabled?: boolean;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomReset: () => void;
  onToggleFullscreen: () => void;
  onToggleChat: () => void;
}> = ({ zoom, fullscreen, chatOpen, disabled, onZoomIn, onZoomOut, onZoomReset, onToggleFullscreen, onToggleChat }) => {
  const { t } = useTranslation();
  const percent = `${Math.round(zoom * 100)}%`;

  return (
    <div className='flex items-center gap-4px'>
      <div className='flex items-center gap-2px h-32px px-4px rd-8px bg-fill-1'>
        <Tooltip content={t('browser.toolbar.zoomOut')} position='bottom'>
          <Button
            type='text'
            size='mini'
            disabled={disabled || zoom <= 0.5}
            aria-label={t('browser.toolbar.zoomOut')}
            icon={<Minus theme='outline' size='15' />}
            onClick={onZoomOut}
          />
        </Tooltip>
        <Tooltip content={t('browser.toolbar.zoomReset')} position='bottom'>
          <Button
            type='text'
            size='mini'
            disabled={disabled}
            className='min-w-44px text-13px font-600 text-t-secondary'
            onClick={onZoomReset}
          >
            {percent}
          </Button>
        </Tooltip>
        <Tooltip content={t('browser.toolbar.zoomIn')} position='bottom'>
          <Button
            type='text'
            size='mini'
            disabled={disabled || zoom >= 2}
            aria-label={t('browser.toolbar.zoomIn')}
            icon={<Plus theme='outline' size='15' />}
            onClick={onZoomIn}
          />
        </Tooltip>
      </div>

      <Tooltip content={chatOpen ? t('browser.toolbar.hideChat') : t('browser.toolbar.showChat')} position='bottom'>
        <Button
          shape='circle'
          type={chatOpen ? 'primary' : 'secondary'}
          aria-label={chatOpen ? t('browser.toolbar.hideChat') : t('browser.toolbar.showChat')}
          icon={<Robot theme={chatOpen ? 'filled' : 'outline'} size='15' />}
          onClick={onToggleChat}
        />
      </Tooltip>

      <Tooltip
        content={fullscreen ? t('browser.toolbar.exitFullscreen') : t('browser.toolbar.fullscreen')}
        position='bottom'
      >
        <Button
          shape='circle'
          type={fullscreen ? 'primary' : 'secondary'}
          disabled={disabled}
          aria-label={fullscreen ? t('browser.toolbar.exitFullscreen') : t('browser.toolbar.fullscreen')}
          icon={fullscreen ? <OffScreen theme='outline' size='15' /> : <FullScreen theme='outline' size='15' />}
          onClick={onToggleFullscreen}
        />
      </Tooltip>
    </div>
  );
};

export default BrowserToolbar;

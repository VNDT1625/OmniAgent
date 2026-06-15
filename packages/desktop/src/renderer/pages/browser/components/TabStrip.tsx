/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Tooltip } from '@arco-design/web-react';
import { CloseSmall, Plus } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { BrowserTabInfo } from '../browserBridgeClient';

/** Human label for a tab: its title, else its URL, else a placeholder. */
const tabLabel = (tab: BrowserTabInfo, fallback: string): string => {
  if (tab.title && tab.title.length > 0) return tab.title;
  if (tab.url && tab.url.length > 0) return tab.url;
  return fallback;
};

/**
 * Horizontal strip of open browser tabs plus a "new tab" button (criterion
 * 1.1). Selecting a tab makes its `WebContentsView` the visible one; closing a
 * tab destroys it in the Main process.
 */
const TabStrip: React.FC<{
  tabs: BrowserTabInfo[];
  activeTabId: string | null;
  disabled?: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onNewTab: () => void;
}> = ({ tabs, activeTabId, disabled, onSelect, onClose, onNewTab }) => {
  const { t } = useTranslation();

  return (
    <div className='flex items-center gap-6px w-full overflow-x-auto'>
      <ul className='flex items-center gap-6px m-0 p-0 list-none min-w-0'>
        {tabs.map((tab) => {
          const active = tab.id === activeTabId;
          return (
            <li
              key={tab.id}
              className={`group flex items-center gap-6px max-w-200px h-30px pl-12px pr-6px rd-8px cursor-pointer transition-colors ${active ? '!bg-fill-3' : 'bg-fill-1 hover:bg-fill-2'}`}
              onClick={() => onSelect(tab.id)}
            >
              <span className={`size-6px rd-full shrink-0 ${active ? 'bg-primary' : 'bg-fill-4'}`} />
              <span className='text-12px truncate text-t-primary'>{tabLabel(tab, t('browser.tab.untitled'))}</span>
              <Button
                type='text'
                size='mini'
                className='shrink-0 opacity-0 group-hover:opacity-100'
                aria-label={t('browser.tab.close')}
                icon={<CloseSmall theme='outline' size='13' />}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
              />
            </li>
          );
        })}
      </ul>

      <Tooltip content={t('browser.tab.new')} position='bottom'>
        <Button
          shape='circle'
          type='secondary'
          size='small'
          disabled={disabled}
          aria-label={t('browser.tab.new')}
          icon={<Plus theme='outline' size='14' />}
          onClick={onNewTab}
        />
      </Tooltip>
    </div>
  );
};

export default TabStrip;

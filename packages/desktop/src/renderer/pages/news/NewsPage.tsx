/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * NewsPage — realtime feed reader. Single scrollable content area with a
 * right sidebar (weather + trending). Feed management lives in a dropdown on
 * the toolbar (see ArticleList) rather than a left sidebar.
 *
 * Process boundary: Renderer. No Node.js APIs.
 */

import { Button, Radio, Result, Spin } from '@arco-design/web-react';
import { ChartLine, NewspaperFolding } from '@icon-park/react';
import { isElectronDesktop } from '@renderer/utils/platform';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import ArticleList, { type CategoryTab } from './components/ArticleList';
import MarketView from './components/MarketView';
import { useNewsState } from './useNewsState';

/** Top-level view of the Realtime page. */
type RealtimeView = 'news' | 'stocks';

const NewsPage: React.FC = () => {
  const { t } = useTranslation();
  const isDesktop = isElectronDesktop();
  const state = useNewsState();
  const [selectedFeedId, setSelectedFeedId] = useState<string | null>(null);
  const [activeCategory, setActiveCategory] = useState<CategoryTab>('all');
  const [view, setView] = useState<RealtimeView>('news');

  // Desktop-only guard.
  if (!isDesktop) {
    return <Result status='warning' title={t('news.desktopOnly')} className='mt-48px' />;
  }

  // Loading state.
  if (state.status === 'loading') {
    return (
      <div className='flex items-center justify-center h-full'>
        <Spin size={24} />
      </div>
    );
  }

  // Bridge not wired yet.
  if (state.status === 'unavailable') {
    return (
      <Result
        status='info'
        title={t('news.bridgeUnavailable')}
        extra={
          <Button type='primary' onClick={() => window.location.reload()}>
            {t('news.retry')}
          </Button>
        }
        className='mt-48px'
      />
    );
  }

  // Error state.
  if (state.status === 'error' || !state.data) {
    return (
      <Result
        status='error'
        title={state.errorMessage || 'Unknown error'}
        extra={
          <Button type='primary' onClick={() => window.location.reload()}>
            {t('news.retry')}
          </Button>
        }
        className='mt-48px'
      />
    );
  }

  const { data } = state;

  // Filter items by selected feed.
  const visibleItems = selectedFeedId ? data.items.filter((i) => i.feedId === selectedFeedId) : data.items;

  const ViewSwitch = (
    <div className='flex items-center gap-4px px-20px py-8px shrink-0 border-b border-solid border-border-2 bg-bg-1'>
      <Radio.Group type='button' value={view} onChange={(val: RealtimeView) => setView(val)}>
        <Radio value='news'>
          <span className='inline-flex items-center gap-6px'>
            <NewspaperFolding theme='outline' size='14' />
            {t('news.view.news')}
          </span>
        </Radio>
        <Radio value='stocks'>
          <span className='inline-flex items-center gap-6px'>
            <ChartLine theme='outline' size='14' />
            {t('news.view.stocks')}
          </span>
        </Radio>
      </Radio.Group>
    </div>
  );

  return (
    <div className='h-full overflow-hidden bg-bg-1 flex flex-col'>
      {ViewSwitch}
      <div className='flex-1 min-h-0'>
        {view === 'stocks' ? (
          <MarketView
            customSymbols={data.settings.marketSymbols}
            onUpdateSymbols={(symbols) => void state.updateSettings({ marketSymbols: symbols })}
          />
        ) : (
          <ArticleList
            items={visibleItems}
            feeds={data.feeds}
            selectedFeedId={selectedFeedId}
            activeCategory={activeCategory}
            onCategoryChange={setActiveCategory}
            onSelectFeed={(id) => {
              setSelectedFeedId(id);
              setActiveCategory('all');
            }}
            onAddFeed={state.addFeed}
            onUpdateFeed={state.updateFeed}
            onRemoveFeed={state.removeFeed}
            onRefreshFeed={state.refreshFeed}
            onValidateFeed={state.validateFeed}
            onMarkRead={state.markRead}
            onMarkAllRead={state.markAllRead}
            refreshing={state.refreshing}
            onRefreshAll={state.refreshAll}
            settings={data.settings}
            onUpdateSettings={state.updateSettings}
          />
        )}
      </div>
    </div>
  );
};

export default NewsPage;

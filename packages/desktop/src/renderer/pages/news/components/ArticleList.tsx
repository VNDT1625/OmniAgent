/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ArticleList — realtime Discover-style layout with a repeating rhythm:
 *
 *   hero (1 big)  →  3 image cards
 *   2 large cards →  3 image cards
 *   1 large card  →  3 image cards
 *   …repeat…
 *
 * The toolbar carries category tabs + a "Sources" dropdown (feed management,
 * moved off the old left sidebar) + refresh actions. The right sidebar shows
 * the weather widget and a top-5 trending list.
 *
 * Process boundary: Renderer. No Node.js APIs.
 */

import { Badge, Button, Dropdown, Empty, Space, Tooltip, Typography } from '@arco-design/web-react';
import { CheckOne, Down, LinkOne, Refresh, Rss, Translate, Broadcast } from '@icon-park/react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { NewsCategoryId, NewsFeed, NewsItem, NewsSettings } from '@process/news/newsTypes';
import type { NewFeedInput } from '@process/news/newsStore';
import FeedManager from './FeedList';
import TrendingPanel from './TrendingPanel';
dayjs.extend(relativeTime);

const { Text, Title } = Typography;

export type CategoryTab = NewsCategoryId | 'all';

/** App locale → translation cache base key (`vi-VN` → `vi`, `zh-CN` → `zh`). */
const baseLocale = (locale: string): string => locale.toLowerCase().split('-')[0];

type ArticleListProps = {
  items: NewsItem[];
  feeds: NewsFeed[];
  selectedFeedId: string | null;
  activeCategory: CategoryTab;
  onCategoryChange: (cat: CategoryTab) => void;
  onSelectFeed: (id: string | null) => void;
  onAddFeed: (input: NewFeedInput) => Promise<boolean>;
  onUpdateFeed: (id: string, patch: Partial<Omit<NewsFeed, 'id' | 'createdAt'>>) => Promise<boolean>;
  onRemoveFeed: (id: string) => Promise<boolean>;
  onRefreshFeed: (id: string) => Promise<boolean>;
  onValidateFeed: (url: string) => Promise<{ ok: true; title: string } | { ok: false; error: string }>;
  onMarkRead: (id: string, read: boolean) => Promise<void>;
  onMarkAllRead: () => Promise<void>;
  refreshing: boolean;
  onRefreshAll: () => Promise<void>;
  settings: NewsSettings;
  onUpdateSettings: (patch: Partial<NewsSettings>) => Promise<boolean>;
};

const useCategoryTabs = (items: NewsItem[]): CategoryTab[] =>
  useMemo(() => {
    const seen = new Set<NewsCategoryId>();
    for (const item of items) seen.add(item.category);
    const order: NewsCategoryId[] = [
      'world',
      'politics',
      'business',
      'technology',
      'science',
      'health',
      'sports',
      'entertainment',
      'general',
    ];
    return ['all', ...order.filter((c) => seen.has(c))] as CategoryTab[];
  }, [items]);

const openArticle = (item: NewsItem) => {
  if (item.link) window.open(item.link, '_blank', 'noopener,noreferrer');
};

/** Subtle category + time label — muted text, not a bright tag (Perplexity-style). */
const MetaLabel: React.FC<{ item: NewsItem; t: (k: string) => string }> = ({ item, t }) => (
  <div className='flex items-center gap-6px text-11px text-t-tertiary'>
    <span className='font-600 uppercase tracking-wide text-t-secondary'>{t(`news.category.${item.category}`)}</span>
    {item.publishedAt != null && (
      <>
        <span className='w-3px h-3px rd-full bg-fill-4 shrink-0' />
        <span>{dayjs(item.publishedAt).fromNow()}</span>
      </>
    )}
  </div>
);

const ArticleActions: React.FC<{
  item: NewsItem;
  onMarkRead: (id: string, read: boolean) => Promise<void>;
}> = ({ item, onMarkRead }) => (
  <Space size={0} className='opacity-0 group-hover:opacity-100 transition-opacity shrink-0'>
    <Button
      type='text'
      size='mini'
      icon={<CheckOne theme='outline' size='13' className={item.read ? 'text-success' : 'text-t-tertiary'} />}
      onClick={(e) => {
        e.stopPropagation();
        void onMarkRead(item.id, !item.read);
      }}
    />
    <Button
      type='text'
      size='mini'
      icon={<LinkOne theme='outline' size='13' className='text-t-tertiary' />}
      onClick={(e) => {
        e.stopPropagation();
        openArticle(item);
      }}
    />
  </Space>
);

const Thumb: React.FC<{ item: NewsItem; className: string; fontSize: string }> = ({ item, className, fontSize }) => {
  const [imgError, setImgError] = useState(false);
  const hasImage = Boolean(item.imageUrl) && !imgError;
  return (
    <div className={`overflow-hidden bg-fill-1 ${className}`}>
      {hasImage ? (
        <img
          src={item.imageUrl!}
          alt=''
          className='w-full h-full object-cover transition-transform duration-500 group-hover:scale-105'
          onError={() => setImgError(true)}
          loading='lazy'
          referrerPolicy='no-referrer'
        />
      ) : (
        <div className='w-full h-full bg-gradient-to-br from-fill-1 to-fill-2 flex items-center justify-center'>
          <Text className={`text-t-tertiary font-700 opacity-30 select-none ${fontSize}`}>
            {item.title.slice(0, 2).toUpperCase()}
          </Text>
        </div>
      )}
    </div>
  );
};

// --- Hero: text left + image right (big) -----------------------------------

const HeroCard: React.FC<{ item: NewsItem; onMarkRead: (id: string, read: boolean) => Promise<void> }> = ({
  item,
  onMarkRead,
}) => {
  const { t } = useTranslation();
  return (
    <div
      className='group flex gap-24px cursor-pointer'
      onClick={() => {
        void onMarkRead(item.id, true);
        openArticle(item);
      }}
    >
      <div className='flex-1 min-w-0 flex flex-col gap-10px justify-center'>
        <MetaLabel item={item} t={t} />
        <Title
          heading={3}
          className='!text-22px !font-700 !leading-30px !mb-0 group-hover:!text-primary-6 transition-colors'
          style={{ wordBreak: 'break-word' }}
        >
          {item.title}
        </Title>
        {item.summary && (
          <Text className='text-13px text-t-secondary leading-21px line-clamp-2' style={{ wordBreak: 'break-word' }}>
            {item.summary}
          </Text>
        )}
        <div className='flex items-center gap-8px mt-2px h-22px'>
          {item.author && (
            <Text className='text-11px text-t-tertiary truncate flex-1'>{t('news.by', { author: item.author })}</Text>
          )}
          <ArticleActions item={item} onMarkRead={onMarkRead} />
        </div>
      </div>
      <Thumb item={item} className='shrink-0 w-220px h-150px rd-12px' fontSize='text-28px' />
    </div>
  );
};

// --- Large: text left + image right (medium), for the "2 large / 1 large" rows ---

const LargeCard: React.FC<{ item: NewsItem; onMarkRead: (id: string, read: boolean) => Promise<void> }> = ({
  item,
  onMarkRead,
}) => {
  const { t } = useTranslation();
  return (
    <div
      className={`group flex gap-14px cursor-pointer ${item.read ? 'opacity-55 hover:opacity-100 transition-opacity' : ''}`}
      onClick={() => {
        void onMarkRead(item.id, true);
        openArticle(item);
      }}
    >
      <div className='flex-1 min-w-0 flex flex-col gap-6px justify-center'>
        <Title
          heading={6}
          className='!text-15px !font-600 !leading-21px !mb-0 line-clamp-3 group-hover:!text-primary-6 transition-colors'
          style={{ wordBreak: 'break-word' }}
        >
          {item.title}
        </Title>
        <div className='flex items-center gap-6px h-20px'>
          <MetaLabel item={item} t={t} />
          <span className='ml-auto'>
            <ArticleActions item={item} onMarkRead={onMarkRead} />
          </span>
        </div>
      </div>
      <Thumb item={item} className='shrink-0 w-120px h-84px rd-10px' fontSize='text-18px' />
    </div>
  );
};

// --- Image card: image top + title below (the 3-card rows) -----------------

const ImageCard: React.FC<{ item: NewsItem; onMarkRead: (id: string, read: boolean) => Promise<void> }> = ({
  item,
  onMarkRead,
}) => {
  const { t } = useTranslation();
  return (
    <div
      className={`group flex flex-col cursor-pointer ${item.read ? 'opacity-55 hover:opacity-100 transition-opacity' : ''}`}
      onClick={() => {
        void onMarkRead(item.id, true);
        openArticle(item);
      }}
    >
      <Thumb item={item} className='w-full h-130px rd-10px mb-8px' fontSize='text-20px' />
      <div
        className={`text-14px font-600 leading-19px line-clamp-2 mb-6px group-hover:text-primary-6 transition-colors ${item.read ? 'text-t-secondary' : 'text-t-primary'}`}
        style={{ wordBreak: 'break-word' }}
      >
        {item.title}
      </div>
      <div className='flex items-center gap-6px h-20px mt-auto'>
        <MetaLabel item={item} t={t} />
        <span className='ml-auto'>
          <ArticleActions item={item} onMarkRead={onMarkRead} />
        </span>
      </div>
    </div>
  );
};

// --- Layout block builder ---------------------------------------------------

type Block =
  | { kind: 'hero'; items: NewsItem[] }
  | { kind: 'large2'; items: NewsItem[] }
  | { kind: 'large1'; items: NewsItem[] }
  | { kind: 'grid3'; items: NewsItem[] };

/**
 * Slice the sorted article list into a repeating rhythm of blocks:
 *   hero(1) → grid3 → large2 → grid3 → large1 → grid3 → (repeat large2…)
 *
 * Exported for unit testing the count-preservation invariant.
 */
export const buildBlocks = (items: NewsItem[]): Block[] => {
  const blocks: Block[] = [];
  let i = 0;
  // Lead block: hero.
  if (i < items.length) {
    blocks.push({ kind: 'hero', items: [items[i]] });
    i += 1;
  }
  // Repeating pattern after the hero.
  const pattern: Array<{ kind: Block['kind']; take: number }> = [
    { kind: 'grid3', take: 3 },
    { kind: 'large2', take: 2 },
    { kind: 'grid3', take: 3 },
    { kind: 'large1', take: 1 },
  ];
  let p = 0;
  while (i < items.length) {
    const step = pattern[p % pattern.length];
    const slice = items.slice(i, i + step.take);
    if (slice.length === 0) break;
    blocks.push({ kind: step.kind, items: slice });
    i += slice.length;
    p += 1;
  }
  return blocks;
};

// ---------------------------------------------------------------------------

const ArticleList: React.FC<ArticleListProps> = ({
  items,
  feeds,
  selectedFeedId,
  activeCategory,
  onCategoryChange,
  onSelectFeed,
  onAddFeed,
  onUpdateFeed,
  onRemoveFeed,
  onRefreshFeed,
  onValidateFeed,
  onMarkRead,
  onMarkAllRead,
  refreshing,
  onRefreshAll,
  settings,
  onUpdateSettings,
}) => {
  const { t, i18n } = useTranslation();
  const tabs = useCategoryTabs(items);

  // No-LLM translation: when enabled, swap each item's title/summary for the
  // cached translation in the current app language (falls back to original).
  const lang = baseLocale(i18n.language);
  const translateEnabled = settings.translateEnabled;
  const localizedItems = useMemo(() => {
    if (!translateEnabled) return items;
    return items.map((it) => {
      const tr = it.translations?.[lang];
      return tr ? { ...it, title: tr.title, summary: tr.summary || it.summary } : it;
    });
  }, [items, lang, translateEnabled]);

  /** Toggle translation: flips the setting and pins the target language to the app locale. */
  const onToggleTranslate = () => {
    void onUpdateSettings({
      translateEnabled: !translateEnabled,
      translateTargetLang: i18n.language,
    });
  };

  const realtimeEnabled = settings.realtimeEnabled !== false;
  const onToggleRealtime = () => {
    void onUpdateSettings({ realtimeEnabled: !realtimeEnabled });
  };

  // Keep the backend translation target in sync with the app locale while
  // translation is on (so switching app language re-translates into it).
  useEffect(() => {
    if (translateEnabled && settings.translateTargetLang !== i18n.language) {
      void onUpdateSettings({ translateTargetLang: i18n.language });
    }
  }, [translateEnabled, settings.translateTargetLang, i18n.language, onUpdateSettings]);

  /** How many articles to render initially / per "load more" click. */
  const PAGE_SIZE = 20;
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  const filtered = useMemo(
    () => (activeCategory === 'all' ? localizedItems : localizedItems.filter((i) => i.category === activeCategory)),
    [localizedItems, activeCategory]
  );

  const unreadCount = useMemo(() => filtered.filter((i) => !i.read).length, [filtered]);

  const sorted = useMemo(() => {
    // Dedupe by id first: some feeds emit items with a duplicate guid (or no
    // guid, so the fallback id collides), which would otherwise drop a React
    // key and render one fewer card than expected (e.g. 19 instead of 20).
    const seen = new Set<string>();
    const unique = filtered.filter((i) => {
      if (seen.has(i.id)) return false;
      seen.add(i.id);
      return true;
    });
    return unique.toSorted((a, b) => {
      if (a.read !== b.read) return a.read ? 1 : -1;
      return (b.publishedAt ?? b.fetchedAt) - (a.publishedAt ?? a.fetchedAt);
    });
  }, [filtered]);

  // Reset pagination when the filter (category/feed) or the dataset shrinks.
  React.useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [activeCategory, selectedFeedId]);

  const visible = useMemo(() => sorted.slice(0, visibleCount), [sorted, visibleCount]);
  const hasMore = sorted.length > visible.length;
  const blocks = useMemo(() => buildBlocks(visible), [visible]);

  const selectedFeed = feeds.find((f) => f.id === selectedFeedId);

  return (
    <div className='flex flex-col h-full'>
      {/* Toolbar */}
      <div className='flex items-center justify-between gap-12px px-20px py-10px shrink-0 border-b border-solid border-border-2'>
        {/* Sources dropdown */}
        <Dropdown
          trigger='click'
          position='bl'
          droplist={
            <div
              className='bg-bg-2 rd-8px shadow-lg border border-solid border-border-2 overflow-hidden'
              style={{ width: 300, maxHeight: 460 }}
            >
              <FeedManager
                feeds={feeds}
                selectedFeedId={selectedFeedId}
                onSelect={onSelectFeed}
                onAdd={onAddFeed}
                onUpdate={onUpdateFeed}
                onRemove={onRemoveFeed}
                onRefresh={onRefreshFeed}
                onValidate={onValidateFeed}
              />
            </div>
          }
        >
          <Button size='small' icon={<Rss theme='outline' size='14' />} className='shrink-0'>
            <span className='mx-2px'>{selectedFeed ? selectedFeed.title : t('news.allSources')}</span>
            <Down theme='outline' size='12' />
          </Button>
        </Dropdown>

        {/* Category tabs */}
        <div className='flex items-center gap-4px overflow-x-auto scrollbar-none flex-1'>
          {tabs.map((cat) => {
            const count =
              cat === 'all'
                ? items.filter((i) => !i.read).length
                : items.filter((i) => i.category === cat && !i.read).length;
            const isActive = cat === activeCategory;
            return (
              <Button
                key={cat}
                type='text'
                size='mini'
                className={`!flex items-center gap-4px !px-10px !py-4px !rd-6px !text-12px !font-500 whitespace-nowrap ${
                  isActive
                    ? '!bg-primary-1 !text-primary-6'
                    : '!bg-transparent !text-t-secondary hover:!bg-fill-2 hover:!text-t-primary'
                }`}
                onClick={() => onCategoryChange(cat)}
              >
                {t(`news.category.${cat}`)}
                {count > 0 && <Badge count={count} maxCount={99} className='scale-85' />}
              </Button>
            );
          })}
        </div>

        {/* Actions */}
        <Space size={4} className='shrink-0'>
          <Tooltip content={realtimeEnabled ? t('news.realtime.on') : t('news.realtime.off')}>
            <Button
              type='text'
              size='small'
              aria-label={realtimeEnabled ? t('news.realtime.on') : t('news.realtime.off')}
              icon={
                <Broadcast
                  theme={realtimeEnabled ? 'filled' : 'outline'}
                  size='14'
                  className={realtimeEnabled ? 'text-success-6' : 'text-t-tertiary'}
                />
              }
              onClick={onToggleRealtime}
            />
          </Tooltip>
          <Tooltip content={translateEnabled ? t('news.translate.showOriginal') : t('news.translate.translate')}>
            <Button
              type='text'
              size='small'
              aria-label={translateEnabled ? t('news.translate.showOriginal') : t('news.translate.translate')}
              icon={
                <Translate
                  theme={translateEnabled ? 'filled' : 'outline'}
                  size='14'
                  className={translateEnabled ? 'text-primary-6' : 'text-t-tertiary'}
                />
              }
              onClick={onToggleTranslate}
            />
          </Tooltip>
          {unreadCount > 0 && (
            <Tooltip content={t('news.markAllRead')}>
              <Button
                type='text'
                size='small'
                icon={<CheckOne theme='outline' size='14' />}
                onClick={() => void onMarkAllRead()}
              />
            </Tooltip>
          )}
          <Tooltip content={t('news.refresh')}>
            <Button
              type='text'
              size='small'
              loading={refreshing}
              icon={<Refresh theme='outline' size='14' />}
              onClick={() => void onRefreshAll()}
            />
          </Tooltip>
        </Space>
      </div>

      {/* Body: main + sidebar */}
      <div className='flex-1 overflow-hidden flex min-h-0'>
        {sorted.length === 0 ? (
          <div className='flex-1 flex items-center justify-center'>
            <Empty description={activeCategory === 'all' ? t('news.empty') : t('news.emptyCategory')} />
          </div>
        ) : (
          <>
            {/* Main content */}
            <div className='flex-1 min-w-0 overflow-y-auto'>
              <div className='mx-auto w-full px-28px py-20px flex flex-col' style={{ maxWidth: 920 }}>
                {blocks.map((block, idx) => {
                  const divider =
                    idx > 0 ? <div className='border-t border-solid border-border-2 my-18px opacity-60' /> : null;
                  if (block.kind === 'hero') {
                    return (
                      <React.Fragment key={idx}>
                        {divider}
                        <HeroCard item={block.items[0]} onMarkRead={onMarkRead} />
                      </React.Fragment>
                    );
                  }
                  if (block.kind === 'grid3') {
                    return (
                      <React.Fragment key={idx}>
                        {divider}
                        <div className='grid grid-cols-3 gap-x-18px gap-y-4px'>
                          {block.items.map((item) => (
                            <ImageCard key={item.id} item={item} onMarkRead={onMarkRead} />
                          ))}
                        </div>
                      </React.Fragment>
                    );
                  }
                  // large2 / large1
                  return (
                    <React.Fragment key={idx}>
                      {divider}
                      <div
                        className={`grid gap-x-24px gap-y-16px ${block.kind === 'large2' ? 'grid-cols-2' : 'grid-cols-1'}`}
                      >
                        {block.items.map((item) => (
                          <LargeCard key={item.id} item={item} onMarkRead={onMarkRead} />
                        ))}
                      </div>
                    </React.Fragment>
                  );
                })}

                {/* Load more — show the next page instead of rendering everything */}
                {hasMore && (
                  <div className='flex justify-center pt-20px pb-4px'>
                    <Button type='outline' shape='round' onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}>
                      {t('news.loadMore', { count: sorted.length - visible.length })}
                    </Button>
                  </div>
                )}
              </div>
            </div>

            {/* Right sidebar */}
            <div
              className='shrink-0 overflow-y-auto border-l border-solid border-border-2 px-16px py-18px bg-bg-1'
              style={{ width: 248 }}
            >
              <TrendingPanel items={localizedItems} activeCategory={activeCategory} />
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default ArticleList;

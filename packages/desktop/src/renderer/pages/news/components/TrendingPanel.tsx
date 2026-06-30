/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * TrendingPanel — right sidebar: weather widget on top, then a compact
 * top-5 trending list (scrollable), then a market placeholder for future
 * realtime data (stocks/crypto).
 *
 * Process boundary: Renderer. No Node.js APIs.
 */

import { Typography } from '@arco-design/web-react';
import { Fire } from '@icon-park/react';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { NewsItem } from '@process/news/newsTypes';
import { computeTrending } from '../trending';
import GithubTrendingPanel from './GithubTrendingPanel';
import WeatherWidget from './WeatherWidget';

dayjs.extend(relativeTime);

const { Text } = Typography;

type TrendingPanelProps = {
  items: NewsItem[];
  activeCategory: string;
};

const TrendingPanel: React.FC<TrendingPanelProps> = ({ items, activeCategory }) => {
  const { t } = useTranslation();
  const { entries, isRealTrend } = useMemo(() => computeTrending(items, 5), [items]);

  // On the technology tab, the "featured" slot becomes Top 10 GitHub trending.
  const showGithub = activeCategory === 'technology';

  // Real cross-source trend → "Trending"; otherwise be honest → "Latest".
  const base = isRealTrend ? t('news.trendingNews') : t('news.latestNews');
  const label = activeCategory === 'all' ? base : `${base} · ${t(`news.category.${activeCategory}`)}`;

  return (
    <div className='flex flex-col gap-16px'>
      {/* Weather — on top */}
      <WeatherWidget />

      {showGithub ? (
        <GithubTrendingPanel />
      ) : (
        /* Trending — top 5, scrollable if overflow */
        <div className='flex flex-col'>
          <div className='flex items-center gap-8px mb-10px'>
            <Fire theme='filled' size='15' className={isRealTrend ? 'text-danger' : 'text-t-tertiary'} />
            <Text className='text-12px font-700 text-t-primary uppercase tracking-wider truncate'>{label}</Text>
          </div>

          {entries.length === 0 ? (
            <Text className='text-12px text-t-tertiary'>{t('news.empty')}</Text>
          ) : (
            <div className='flex flex-col max-h-360px overflow-y-auto -mx-4px px-4px'>
              {entries.map(({ item, sourceCount }, idx) => (
                <div
                  key={item.id}
                  className='group flex items-start gap-8px py-8px border-b border-solid border-border-2 last:border-b-0 cursor-pointer hover:bg-fill-1 -mx-4px px-4px rd-6px transition-colors'
                  onClick={() => item.link && window.open(item.link, '_blank', 'noopener,noreferrer')}
                >
                  <span
                    className={`shrink-0 w-16px text-center text-13px font-800 leading-18px mt-1px ${
                      idx < 3 ? 'text-primary-6' : 'text-t-tertiary'
                    }`}
                  >
                    {idx + 1}
                  </span>
                  <div className='flex-1 min-w-0'>
                    <div
                      className={`text-12px font-500 leading-16px line-clamp-2 group-hover:text-primary-6 transition-colors ${
                        item.read ? 'text-t-secondary' : 'text-t-primary'
                      }`}
                      style={{ wordBreak: 'break-word' }}
                    >
                      {item.title}
                    </div>
                    <div className='flex items-center gap-4px mt-3px text-9px text-t-tertiary'>
                      <span className='font-600 uppercase tracking-wide text-t-secondary'>
                        {t(`news.category.${item.category}`)}
                      </span>
                      {/* Real trend strength: show how many distinct sources cover it. */}
                      {sourceCount >= 2 && (
                        <>
                          <span className='w-2px h-2px rd-full bg-fill-4 shrink-0' />
                          <span className='text-primary-6 font-600'>
                            {t('news.sourceCount', { count: sourceCount })}
                          </span>
                        </>
                      )}
                      {sourceCount < 2 && item.publishedAt != null && (
                        <>
                          <span className='w-2px h-2px rd-full bg-fill-4 shrink-0' />
                          <span>{dayjs(item.publishedAt).fromNow()}</span>
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default TrendingPanel;

/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GithubTrendingPanel — replaces the trending-news list in the right sidebar
 * when the active category is "technology". Shows the top trending GitHub
 * repositories (keyless GitHub Search API, fetched via the news bridge), with a
 * window selector (daily / weekly / monthly).
 *
 * Process boundary: Renderer. No Node.js APIs.
 */

import { Button, Radio, Spin, Typography } from '@arco-design/web-react';
import { Github, Star } from '@icon-park/react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { GithubRepo, GithubTrendingSince } from '@process/news/newsBridge';
import { newsClient } from '../newsBridgeClient';

const { Text } = Typography;

const WINDOWS: GithubTrendingSince[] = ['daily', 'weekly', 'monthly'];

/** Compact star count: 1234 → 1.2k. */
const formatStars = (n: number): string => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

const GithubTrendingPanel: React.FC = () => {
  const { t } = useTranslation();
  const [since, setSince] = useState<GithubTrendingSince>('weekly');
  const [repos, setRepos] = useState<GithubRepo[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');

  const load = useCallback(async (window: GithubTrendingSince) => {
    setStatus('loading');
    try {
      const result = await newsClient.githubTrending({ since: window, limit: 10 });
      if (result.ok) {
        setRepos(result.repos);
        setStatus('ready');
      } else {
        setStatus('error');
      }
    } catch {
      setStatus('error');
    }
  }, []);

  useEffect(() => {
    void load(since);
  }, [since, load]);

  return (
    <div className='flex flex-col'>
      <div className='flex items-center gap-8px mb-10px'>
        <Github theme='filled' size='15' className='text-t-primary' />
        <Text className='text-12px font-700 text-t-primary uppercase tracking-wider truncate'>
          {t('news.github.title')}
        </Text>
      </div>

      {/* Window selector */}
      <div className='mb-10px'>
        <Radio.Group type='button' size='mini' value={since} onChange={(val: GithubTrendingSince) => setSince(val)}>
          {WINDOWS.map((w) => (
            <Radio key={w} value={w}>
              {t(`news.github.since.${w}`)}
            </Radio>
          ))}
        </Radio.Group>
      </div>

      {status === 'loading' ? (
        <div className='flex items-center justify-center py-24px'>
          <Spin size={18} />
        </div>
      ) : status === 'error' ? (
        <div className='flex flex-col items-start gap-6px'>
          <Text className='text-12px text-t-tertiary'>{t('news.github.error')}</Text>
          <Button size='mini' type='text' onClick={() => void load(since)}>
            {t('news.retry')}
          </Button>
        </div>
      ) : repos.length === 0 ? (
        <Text className='text-12px text-t-tertiary'>{t('news.github.empty')}</Text>
      ) : (
        <div className='flex flex-col max-h-420px overflow-y-auto -mx-4px px-4px'>
          {repos.map((repo, idx) => (
            <div
              key={repo.id}
              className='group flex items-start gap-8px py-8px border-b border-solid border-border-2 last:border-b-0 cursor-pointer hover:bg-fill-1 -mx-4px px-4px rd-6px transition-colors'
              onClick={() => window.open(repo.url, '_blank', 'noopener,noreferrer')}
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
                  className='text-12px font-600 leading-16px line-clamp-1 text-t-primary group-hover:text-primary-6 transition-colors'
                  style={{ wordBreak: 'break-all' }}
                >
                  {repo.fullName}
                </div>
                {repo.description && (
                  <div
                    className='text-11px text-t-secondary leading-15px line-clamp-2 mt-2px'
                    style={{ wordBreak: 'break-word' }}
                  >
                    {repo.description}
                  </div>
                )}
                <div className='flex items-center gap-6px mt-3px text-9px text-t-tertiary'>
                  {repo.language && <span className='font-600 text-t-secondary'>{repo.language}</span>}
                  {repo.language && <span className='w-2px h-2px rd-full bg-fill-4 shrink-0' />}
                  <span className='flex items-center gap-2px'>
                    <Star theme='filled' size='9' className='text-warning-6' />
                    {formatStars(repo.stars)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default GithubTrendingPanel;

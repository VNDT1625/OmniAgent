/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import AionScrollArea from '@/renderer/components/base/AionScrollArea';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { Button, Empty, Input, Spin } from '@arco-design/web-react';
import { Refresh, Search } from '@icon-park/react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import FactCard from './components/FactCard';
import { useRealtimeKnowledge } from './useRealtimeKnowledge';

/**
 * Realtime Knowledge inspector — review the time-sensitive facts RTK has
 * captured (value, freshness, sources, validity window), search them
 * semantically, and force a refresh. Read/maintenance only; the agent populates
 * facts via the `rtk_*` MCP tools.
 *
 * Desktop-only: the RTK service is a Main-process singleton reached over the
 * native IPC bridge (mirrors how the Company / Resource pages are gated).
 */
const RealtimeKnowledgePage: React.FC = () => {
  const { t } = useTranslation();
  const isDesktop = isElectronDesktop();
  const { facts, status, reload, lookup, refresh, refreshing } = useRealtimeKnowledge();
  const [query, setQuery] = useState('');
  const [matchedIds, setMatchedIds] = useState<string[] | null>(null);
  const [searching, setSearching] = useState(false);

  const runSearch = async (value: string): Promise<void> => {
    const q = value.trim();
    if (q.length === 0) {
      setMatchedIds(null);
      return;
    }
    setSearching(true);
    const results = await lookup(q, 10);
    setSearching(false);
    setMatchedIds(results ? results.map((r) => r.fact.id) : []);
  };

  const visibleFacts = useMemo(() => {
    if (!matchedIds) return facts;
    const order = new Map(matchedIds.map((id, i) => [id, i] as const));
    return facts.filter((f) => order.has(f.id)).toSorted((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
  }, [facts, matchedIds]);

  if (!isDesktop) {
    return (
      <div className='flex flex-col items-center justify-center gap-12px py-56px text-center'>
        <p className='m-0 max-w-420px text-13px text-t-secondary'>{t('realtimeKnowledge.desktopOnly')}</p>
      </div>
    );
  }

  return (
    <div className='flex flex-col h-full min-h-0 gap-16px p-20px'>
      <header className='flex items-start justify-between gap-12px shrink-0'>
        <div className='flex flex-col gap-4px'>
          <h2 className='m-0 text-18px font-700 text-t-primary'>{t('realtimeKnowledge.title')}</h2>
          <p className='m-0 max-w-560px text-13px text-t-secondary leading-relaxed'>{t('realtimeKnowledge.subtitle')}</p>
        </div>
        <Button
          type='secondary'
          icon={<Refresh theme='outline' size='14' />}
          loading={status === 'loading'}
          onClick={() => void reload()}
        >
          {t('realtimeKnowledge.reload')}
        </Button>
      </header>

      <Input
        allowClear
        value={query}
        prefix={<Search theme='outline' size='15' />}
        placeholder={t('realtimeKnowledge.searchPlaceholder')}
        className='shrink-0'
        onChange={(value: string) => {
          setQuery(value);
          if (value.trim().length === 0) setMatchedIds(null);
        }}
        onPressEnter={() => void runSearch(query)}
      />

      <AionScrollArea className='flex-1 min-h-0'>
        {status === 'error' ? (
          <div className='flex flex-col items-center justify-center gap-12px py-48px text-center'>
            <p className='m-0 max-w-420px text-13px text-t-secondary'>{t('realtimeKnowledge.loadError')}</p>
            <Button type='secondary' icon={<Refresh theme='outline' size='14' />} onClick={() => void reload()}>
              {t('realtimeKnowledge.retry')}
            </Button>
          </div>
        ) : status === 'loading' || searching ? (
          <div className='flex items-center justify-center py-48px'>
            <Spin />
          </div>
        ) : visibleFacts.length === 0 ? (
          <Empty description={matchedIds ? t('realtimeKnowledge.noMatches') : t('realtimeKnowledge.empty')} />
        ) : (
          <div className='flex flex-col gap-12px'>
            {visibleFacts.map((fact) => (
              <FactCard key={fact.id} fact={fact} refreshing={refreshing === fact.topic} onRefresh={refresh} />
            ))}
          </div>
        )}
      </AionScrollArea>
    </div>
  );
};

export default RealtimeKnowledgePage;

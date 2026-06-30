/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Tag, Tooltip } from '@arco-design/web-react';
import { Refresh, LinkOne } from '@icon-park/react';
import type { KnowledgeFact } from '@process/knowledge/realtime/rtkTypes';
import FreshnessBadge from './FreshnessBadge';

/** Status tones for the small status tag (semantic tokens only). */
const STATUS_TONE: Record<string, string> = {
  active: 'text-success',
  needs_review: 'text-warning',
  superseded: 'text-t-tertiary',
  archived: 'text-t-tertiary',
};

/** Open an external URL via the platform shell (renderer-safe). */
const openUrl = (url: string): void => {
  void window.open(url, '_blank', 'noopener');
};

/** A single fact card: value, freshness, validity window, sources and refresh. */
const FactCard: React.FC<{
  fact: KnowledgeFact;
  refreshing: boolean;
  onRefresh: (topicOrId: string) => void;
}> = ({ fact, refreshing, onRefresh }) => {
  const { t, i18n } = useTranslation();
  const fmt = new Intl.DateTimeFormat(i18n.language, { dateStyle: 'medium' });
  const validAsOf = (() => {
    const ms = Date.parse(fact.validAsOf);
    return Number.isNaN(ms) ? fact.validAsOf : fmt.format(ms);
  })();

  return (
    <article className='flex flex-col gap-10px p-16px rd-12px bg-bg-2 b b-solid b-line-2'>
      <header className='flex items-start justify-between gap-12px'>
        <div className='flex flex-col gap-2px min-w-0'>
          <span className='text-14px font-600 text-t-primary truncate'>{fact.question}</span>
          <span className='text-12px text-t-tertiary font-mono truncate'>{fact.topic}</span>
        </div>
        <FreshnessBadge freshness={fact.freshness} />
      </header>

      <p className='m-0 text-15px text-t-primary leading-relaxed break-words'>{fact.value}</p>

      <div className='flex flex-wrap items-center gap-8px'>
        <Tag size='small' bordered>
          {t(`realtimeKnowledge.class.${fact.volatilityClass}`)}
        </Tag>
        <span className={`text-12px font-600 ${STATUS_TONE[fact.status] ?? 'text-t-tertiary'}`}>
          {t(`realtimeKnowledge.status.${fact.status}`)}
        </span>
        <span className='text-12px text-t-tertiary'>{t('realtimeKnowledge.card.validAsOf', { date: validAsOf })}</span>
        <span className='text-12px text-t-tertiary'>
          {t('realtimeKnowledge.card.confidence', { percent: Math.round(fact.confidence * 100) })}
        </span>
      </div>

      {fact.sources.length > 0 && (
        <div className='flex flex-col gap-4px'>
          <span className='text-12px text-t-tertiary'>{t('realtimeKnowledge.card.sources')}</span>
          <div className='flex flex-col items-start gap-2px'>
            {fact.sources.slice(0, 4).map((source) => (
              <Button
                key={source.url}
                type='text'
                size='mini'
                onClick={() => openUrl(source.url)}
                className='!px-0 !h-auto max-w-full'
                icon={<LinkOne theme='outline' size='12' />}
              >
                <span className='text-12px truncate'>{source.title ?? source.url}</span>
              </Button>
            ))}
          </div>
        </div>
      )}

      <footer className='flex items-center justify-end'>
        <Tooltip content={t('realtimeKnowledge.card.refreshHint')} position='top'>
          <Button
            size='small'
            type='secondary'
            loading={refreshing}
            icon={<Refresh theme='outline' size='13' />}
            onClick={() => onRefresh(fact.topic)}
          >
            {t('realtimeKnowledge.card.refresh')}
          </Button>
        </Tooltip>
      </footer>
    </article>
  );
};

export default FactCard;

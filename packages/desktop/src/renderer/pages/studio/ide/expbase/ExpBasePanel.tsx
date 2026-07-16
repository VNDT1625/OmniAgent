/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `ExpBasePanel` — the IDE "ExpBase" mode: a debugging-experience memory.
 *
 * Browse captured lessons (successful fixes, mistakes, failed attempts), search
 * by symptom, give feedback that tunes an entry's confidence, archive stale
 * entries, and watch retrieval quality via a metrics strip.
 *
 * Renderer-only. Arco + @icon-park/react + UnoCSS semantic tokens; all copy via
 * i18n. The aesthetic is a calm, editorial knowledge base: a kind-coloured left
 * accent rail per card, monospace for commands, generous breathing room.
 */

import { Button, Empty, Input, Message, Popconfirm, Progress, Spin, Tag, Tooltip } from '@arco-design/web-react';
import { Brain, CheckOne, Delete, Like, Refresh, Search, Lightning } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  experienceClient,
  type ExperienceEntry,
  type ExperienceMetrics,
  type ExperienceSuggestion,
} from './experienceClient';

type ExpBasePanelProps = { rootPath: string | null };

type KindKey = ExperienceEntry['kind'];

/** Token-based accent per experience kind (no hardcoded colours). */
const KIND_STYLE: Record<KindKey, { rail: string; tag: 'green' | 'orange' | 'red' | 'arcoblue'; labelKey: string }> = {
  successful_fix: { rail: 'bg-success', tag: 'green', labelKey: 'ide.expbase.kind.successful_fix' },
  failed_attempt: { rail: 'bg-warning', tag: 'orange', labelKey: 'ide.expbase.kind.failed_attempt' },
  agent_mistake: { rail: 'bg-danger', tag: 'red', labelKey: 'ide.expbase.kind.agent_mistake' },
  lesson: { rail: 'bg-primary', tag: 'arcoblue', labelKey: 'ide.expbase.kind.lesson' },
};

const ExpBasePanel: React.FC<ExpBasePanelProps> = ({ rootPath }) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [submittedQuery, setSubmittedQuery] = useState('');
  const [entries, setEntries] = useState<ExperienceEntry[]>([]);
  const [suggestions, setSuggestions] = useState<ExperienceSuggestion[]>([]);
  const [metrics, setMetrics] = useState<ExperienceMetrics | null>(null);
  const [loading, setLoading] = useState(false);

  const reload = useCallback(async () => {
    if (!rootPath) return;
    setLoading(true);
    try {
      const [listRes, metricsRes] = await Promise.all([
        experienceClient.list(rootPath),
        experienceClient.metrics(rootPath),
      ]);
      if (listRes.ok) setEntries(listRes.data);
      if (metricsRes.ok) setMetrics(metricsRes.data);
    } finally {
      setLoading(false);
    }
  }, [rootPath]);

  useEffect(() => {
    void reload();
    setSubmittedQuery('');
    setSuggestions([]);
    setQuery('');
  }, [reload]);

  const runSearch = async (value: string): Promise<void> => {
    const trimmed = value.trim();
    setSubmittedQuery(trimmed);
    if (!rootPath || trimmed.length === 0) {
      setSuggestions([]);
      return;
    }
    setLoading(true);
    try {
      const res = await experienceClient.search(rootPath, { symptom: trimmed }, 8);
      setSuggestions(res.ok ? res.data : []);
    } finally {
      setLoading(false);
    }
  };

  const onFeedback = async (entryId: string, helped: boolean): Promise<void> => {
    if (!rootPath) return;
    const res = await experienceClient.feedback(rootPath, entryId, helped);
    if (res.ok && res.data.updated) {
      Message.success(t('ide.expbase.feedbackSaved'));
      void reload();
    } else {
      Message.warning(t('ide.expbase.feedbackFailed'));
    }
  };

  const onForget = async (entryId: string): Promise<void> => {
    if (!rootPath) return;
    const res = await experienceClient.forget(rootPath, entryId);
    if (res.ok && res.data.archived) {
      Message.success(t('ide.expbase.archived'));
      if (submittedQuery) void runSearch(submittedQuery);
      void reload();
    }
  };

  const activeEntries = useMemo(() => entries.filter((entry) => entry.status === 'active'), [entries]);
  const showingSearch = submittedQuery.length > 0;

  if (!rootPath) {
    return (
      <div className='size-full flex-center bg-1'>
        <Empty description={t('ide.expbase.noFolder')} />
      </div>
    );
  }

  return (
    <div className='size-full flex flex-col min-h-0 bg-1'>
      {/* Header */}
      <header className='shrink-0 px-20px pt-18px pb-14px border-b border-b-1'>
        <div className='flex items-center gap-10px'>
          <span className='size-32px flex-center rd-10px bg-primary-light-1 text-primary'>
            <Brain theme='outline' size={19} />
          </span>
          <div className='flex flex-col'>
            <span className='text-15px font-600 text-t-primary tracking-tight'>{t('ide.expbase.title')}</span>
            <span className='text-12px text-t-tertiary'>{t('ide.expbase.subtitle')}</span>
          </div>
          <div className='flex-1' />
          <Tooltip content={t('ide.expbase.refresh')} position='br'>
            <Button
              type='text'
              size='small'
              icon={<Refresh theme='outline' size={15} />}
              loading={loading}
              onClick={() => void reload()}
            />
          </Tooltip>
        </div>

        <MetricsStrip metrics={metrics} />

        <Input.Search
          allowClear
          className='mt-12px'
          value={query}
          onChange={setQuery}
          onSearch={runSearch}
          onClear={() => void runSearch('')}
          placeholder={t('ide.expbase.searchPlaceholder')}
          prefix={<Search theme='outline' size={14} />}
        />
      </header>

      {/* Body */}
      <div className='flex-1 min-h-0 overflow-auto px-20px py-16px'>
        {loading && entries.length === 0 ? (
          <div className='h-200px flex-center'>
            <Spin />
          </div>
        ) : showingSearch ? (
          <SearchResults suggestions={suggestions} query={submittedQuery} onFeedback={onFeedback} onForget={onForget} />
        ) : (
          <EntryList entries={activeEntries} onForget={onForget} />
        )}
      </div>
    </div>
  );
};

/** Compact metrics chips: captured, hit rate, accepted. */
const MetricsStrip: React.FC<{ metrics: ExperienceMetrics | null }> = ({ metrics }) => {
  const { t } = useTranslation();
  if (!metrics) return null;
  const hit = metrics.retrievals > 0 ? Math.round((metrics.retrievalsWithHits / metrics.retrievals) * 100) : 0;
  const feedback = metrics.accepted + metrics.falseMatches;
  const accept = feedback > 0 ? Math.round((metrics.accepted / feedback) * 100) : 0;
  return (
    <div className='flex items-center gap-8px mt-12px flex-wrap'>
      <Chip
        icon={<Brain theme='outline' size={13} />}
        label={t('ide.expbase.metric.captured')}
        value={String(metrics.captures)}
      />
      <Chip icon={<Lightning theme='outline' size={13} />} label={t('ide.expbase.metric.hitRate')} value={`${hit}%`} />
      <Chip icon={<Like theme='outline' size={13} />} label={t('ide.expbase.metric.accepted')} value={`${accept}%`} />
    </div>
  );
};

const Chip: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({ icon, label, value }) => (
  <span className='inline-flex items-center gap-6px h-26px px-10px rd-full bg-fill-2 text-12px text-t-secondary'>
    <span className='text-t-tertiary'>{icon}</span>
    {label}
    <b className='text-t-primary font-600'>{value}</b>
  </span>
);

/** Kind badge tag. */
const KindBadge: React.FC<{ kind: KindKey }> = ({ kind }) => {
  const { t } = useTranslation();
  const style = KIND_STYLE[kind];
  return (
    <Tag color={style.tag} size='small' bordered>
      {t(style.labelKey)}
    </Tag>
  );
};

/** Search results: graph-enriched advisory suggestions. */
const SearchResults: React.FC<{
  suggestions: ExperienceSuggestion[];
  query: string;
  onFeedback: (id: string, helped: boolean) => void;
  onForget: (id: string) => void;
}> = ({ suggestions, query, onFeedback, onForget }) => {
  const { t } = useTranslation();
  if (suggestions.length === 0) {
    return <Empty description={t('ide.expbase.noResults', { query })} />;
  }
  return (
    <div className='flex flex-col gap-12px'>
      {suggestions.map((suggestion) => (
        <article
          key={suggestion.entryId}
          className={`relative rd-12px bg-2 border border-b-1 overflow-hidden transition-shadow hover:shadow-sm`}
        >
          <span className={`absolute left-0 top-0 bottom-0 w-3px ${KIND_STYLE[suggestion.kind].rail}`} />
          <div className='pl-16px pr-14px py-13px flex flex-col gap-8px'>
            <div className='flex items-start gap-8px'>
              <KindBadge kind={suggestion.kind} />
              <span className='text-13px font-600 text-t-primary leading-snug flex-1'>{suggestion.symptom}</span>
              <span className='shrink-0 text-11px text-t-tertiary tabular-nums'>
                {Math.round(suggestion.score * 100)}%
              </span>
            </div>
            <p className='m-0 text-13px text-t-secondary leading-relaxed'>{suggestion.lesson}</p>

            {suggestion.whyRelevant.length > 0 ? (
              <div className='flex flex-wrap gap-6px'>
                {suggestion.whyRelevant.map((why, index) => (
                  <span key={index} className='text-11px text-primary bg-primary-light-1 rd-full px-8px py-2px'>
                    {why}
                  </span>
                ))}
              </div>
            ) : null}

            {suggestion.caution.length > 0 ? (
              <ul className='m-0 pl-16px flex flex-col gap-2px'>
                {suggestion.caution.map((caution, index) => (
                  <li key={index} className='text-12px text-warning leading-relaxed'>
                    {caution}
                  </li>
                ))}
              </ul>
            ) : null}

            {suggestion.suggestedChecks.length > 0 ? (
              <div className='flex flex-col gap-3px mt-2px'>
                {suggestion.suggestedChecks.map((check, index) => (
                  <code key={index} className='text-11px text-t-secondary bg-fill-2 rd-6px px-8px py-3px font-mono'>
                    {check}
                  </code>
                ))}
              </div>
            ) : null}

            {suggestion.related && suggestion.related.length > 0 ? (
              <div className='mt-4px pt-8px border-t border-b-1 flex flex-col gap-4px'>
                <span className='text-11px text-t-tertiary uppercase tracking-wide'>{t('ide.expbase.related')}</span>
                {suggestion.related.map((rel) => (
                  <div key={rel.entryId} className='flex items-center gap-6px text-12px text-t-secondary'>
                    <Tag size='small' color={rel.relation === 'contradicts' ? 'red' : 'gray'} bordered>
                      {t(`ide.expbase.relation.${rel.relation}`)}
                    </Tag>
                    <span className='truncate'>{rel.lesson}</span>
                  </div>
                ))}
              </div>
            ) : null}

            <div className='flex items-center gap-6px mt-4px'>
              <Tooltip content={t('ide.expbase.helpful')}>
                <Button
                  size='mini'
                  type='text'
                  icon={<Like theme='outline' size={14} />}
                  onClick={() => onFeedback(suggestion.entryId, true)}
                >
                  {t('ide.expbase.helpful')}
                </Button>
              </Tooltip>
              <Tooltip content={t('ide.expbase.notHelpful')}>
                <Button
                  size='mini'
                  type='text'
                  className='!text-t-secondary'
                  icon={<Like theme='outline' size={14} className='rotate-180' />}
                  onClick={() => onFeedback(suggestion.entryId, false)}
                >
                  {t('ide.expbase.notHelpful')}
                </Button>
              </Tooltip>
              <div className='flex-1' />
              <Popconfirm title={t('ide.expbase.archiveConfirm')} onOk={() => onForget(suggestion.entryId)}>
                <Button size='mini' type='text' status='danger' icon={<Delete theme='outline' size={14} />} />
              </Popconfirm>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
};

/** Full list of active entries when no search is running. */
const EntryList: React.FC<{ entries: ExperienceEntry[]; onForget: (id: string) => void }> = ({ entries, onForget }) => {
  const { t } = useTranslation();
  if (entries.length === 0) {
    return (
      <Empty
        icon={<CheckOne theme='outline' size={28} className='text-t-tertiary' />}
        description={t('ide.expbase.empty')}
      />
    );
  }
  return (
    <div className='flex flex-col gap-10px'>
      {entries.map((entry) => (
        <article key={entry.id} className='relative rd-12px bg-2 border border-b-1 overflow-hidden'>
          <span className={`absolute left-0 top-0 bottom-0 w-3px ${KIND_STYLE[entry.kind].rail}`} />
          <div className='pl-16px pr-14px py-12px flex flex-col gap-6px'>
            <div className='flex items-start gap-8px'>
              <KindBadge kind={entry.kind} />
              <span className='text-13px font-600 text-t-primary leading-snug flex-1'>{entry.symptoms.summary}</span>
              <Popconfirm title={t('ide.expbase.archiveConfirm')} onOk={() => onForget(entry.id)}>
                <Button size='mini' type='text' status='danger' icon={<Delete theme='outline' size={13} />} />
              </Popconfirm>
            </div>
            {entry.lesson ? <p className='m-0 text-12px text-t-secondary leading-relaxed'>{entry.lesson}</p> : null}
            <div className='flex items-center gap-10px mt-2px'>
              {entry.context.frameworks.slice(0, 4).map((fw) => (
                <span key={fw} className='text-11px text-t-tertiary'>
                  #{fw}
                </span>
              ))}
              <div className='flex-1' />
              <span className='flex items-center gap-6px'>
                <span className='text-11px text-t-tertiary'>{t('ide.expbase.confidence')}</span>
                <Progress percent={Math.round(entry.confidence * 100)} width={70} size='small' showText={false} />
              </span>
            </div>
          </div>
        </article>
      ))}
    </div>
  );
};

export default ExpBasePanel;

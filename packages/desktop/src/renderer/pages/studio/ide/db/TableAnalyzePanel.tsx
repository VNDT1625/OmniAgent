/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `TableAnalyzePanel` — the data-analysis view for ONE table. Given a connection
 * id + table, it asks the Main process for a statistical {@link DbTableProfile}
 * (fill rate, cardinality, numeric spread, top values) and renders it as a set
 * of compact column cards so a developer can understand a table's contents at a
 * glance — the in-app answer to "what's actually in this table?".
 *
 * Visual language: each column is a card with a fill-rate meter (non-null %), a
 * cardinality read-out, numeric min/avg/max when applicable, and a tiny
 * top-values bar list for low-cardinality columns. Pure SVG/CSS bars built from
 * UnoCSS semantic tokens (no chart library, no hardcoded colours).
 *
 * Renderer-only; Arco + icon-park + UnoCSS tokens; all text via i18n.
 */

import { Button, Empty, Spin, Tag, Tooltip } from '@arco-design/web-react';
import { ChartHistogram, Key, Refresh } from '@icon-park/react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { dbClient, type DbColumnProfile, type DbTableProfile } from './dbClient';

/** Extract the error string from a failed result envelope (robust across TS narrowing). */
const resultError = (r: unknown): string =>
  typeof r === 'object' && r !== null && 'error' in r && typeof (r as { error?: unknown }).error === 'string'
    ? (r as { error: string }).error
    : 'Unknown error';

type TableAnalyzePanelProps = {
  connectionId: string;
  table: string;
  schema?: string;
  /** Whether the column is a primary key (from the schema tree), for the badge. */
  primaryKeys?: Set<string>;
};

/** Format a possibly-fractional number compactly (avoids long float tails). */
const fmtNum = (n: number | null | undefined): string => {
  if (n === null || n === undefined) return '—';
  if (!Number.isFinite(n)) return '—';
  if (Number.isInteger(n)) return n.toLocaleString();
  return n.toLocaleString(undefined, { maximumFractionDigits: 3 });
};

const TableAnalyzePanel: React.FC<TableAnalyzePanelProps> = ({ connectionId, table, schema, primaryKeys }) => {
  const { t } = useTranslation();
  const [profile, setProfile] = useState<DbTableProfile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(null);
    const res = await dbClient.profileTable(connectionId, table, schema);
    if (res.ok) {
      setProfile(res.data);
      setError(null);
    } else {
      setError(resultError(res));
      setProfile(null);
    }
    setLoading(false);
  }, [connectionId, table, schema]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !profile) {
    return (
      <div className='flex-1 min-h-0 flex-center gap-8px text-12px text-t-tertiary'>
        <Spin size={14} /> {t('ide.db.analyzing')}
      </div>
    );
  }

  if (error) {
    return (
      <div className='flex-1 min-h-0 flex-center flex-col gap-10px px-24px text-center'>
        <ChartHistogram theme='outline' size={24} className='text-danger' />
        <p className='m-0 max-w-440px text-12px text-danger font-mono leading-relaxed break-words'>{error}</p>
        <Button size='small' type='outline' icon={<Refresh theme='outline' size={13} />} onClick={() => void load()}>
          {t('ide.db.retry')}
        </Button>
      </div>
    );
  }

  if (!profile) {
    return (
      <div className='flex-1 min-h-0 flex-center'>
        <Empty description={<span className='text-12px text-t-tertiary'>{t('ide.db.analyzeEmpty')}</span>} />
      </div>
    );
  }

  return (
    <div className='flex-1 min-h-0 flex flex-col'>
      <div className='shrink-0 flex items-center gap-10px px-16px py-8px border-b border-b-1 bg-fill-1'>
        <ChartHistogram theme='outline' size={15} className='text-primary' />
        <span className='text-12px font-600 text-t-primary'>{profile.table}</span>
        <span className='text-11px text-t-tertiary'>{t('ide.db.profileRows', { n: profile.rowCount })}</span>
        {profile.sampled ? (
          <Tag size='small' color='orange' className='!text-9px'>
            {t('ide.db.sampled')}
          </Tag>
        ) : null}
        <Tooltip content={t('ide.db.refresh')}>
          <span
            className='ml-auto inline-flex cursor-pointer text-t-tertiary hover:text-primary'
            onClick={() => void load()}
          >
            <Refresh theme='outline' size={14} />
          </span>
        </Tooltip>
      </div>
      <div className='flex-1 min-h-0 overflow-auto p-12px'>
        <div className='grid gap-10px' style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))' }}>
          {profile.columns.map((col) => (
            <ColumnCard key={col.column} profile={col} isPk={primaryKeys?.has(col.column) ?? false} />
          ))}
        </div>
      </div>
    </div>
  );
};

/** One column's statistical card: fill meter + cardinality + numeric spread + top values. */
const ColumnCard: React.FC<{ profile: DbColumnProfile; isPk: boolean }> = ({ profile, isPk }) => {
  const { t } = useTranslation();
  const total = profile.total || 0;
  const nonNull = Math.max(0, total - profile.nulls);
  const fillPct = total > 0 ? Math.round((nonNull / total) * 100) : 0;
  const isNumeric = profile.min !== undefined || profile.max !== undefined || profile.avg !== undefined;
  const maxTop = profile.topValues.reduce((m, v) => Math.max(m, v.count), 0) || 1;

  return (
    <div className='flex flex-col gap-8px rd-10px border border-arco-2 bg-2 p-12px'>
      <div className='flex items-center gap-6px'>
        {isPk ? <Key theme='outline' size={12} className='shrink-0 text-primary' /> : null}
        <span className='flex-1 truncate text-12px font-600 text-t-primary'>{profile.column}</span>
        <span className='shrink-0 text-9px text-t-tertiary uppercase tracking-wide'>{profile.type}</span>
      </div>

      {/* Fill rate meter (non-null %). */}
      <div className='flex flex-col gap-3px'>
        <div className='flex items-center justify-between text-10px text-t-tertiary'>
          <span>{t('ide.db.fillRate')}</span>
          <span className='font-mono text-t-secondary'>{fillPct}%</span>
        </div>
        <div className='h-5px rd-full overflow-hidden bg-fill-2'>
          <div className='h-full rd-full bg-primary transition-all' style={{ width: `${fillPct}%`, opacity: 0.85 }} />
        </div>
        <div className='flex items-center justify-between text-9px text-t-tertiary'>
          <span>{t('ide.db.distinctCount', { n: profile.distinct })}</span>
          <span>{t('ide.db.nullCount', { n: profile.nulls })}</span>
        </div>
      </div>

      {/* Numeric spread (min / avg / max). */}
      {isNumeric ? (
        <div className='grid grid-cols-3 gap-4px text-center'>
          {(
            [
              ['min', profile.min],
              ['avg', profile.avg],
              ['max', profile.max],
            ] as const
          ).map(([key, value]) => (
            <div key={key} className='flex flex-col rd-6px bg-fill-1 py-4px'>
              <span className='text-8px text-t-tertiary uppercase tracking-wide'>{t(`ide.db.stat.${key}`)}</span>
              <span className='truncate font-mono text-10px text-t-secondary'>{fmtNum(value)}</span>
            </div>
          ))}
        </div>
      ) : null}

      {/* Top frequent values (low-cardinality columns). */}
      {profile.topValues.length > 0 ? (
        <div className='flex flex-col gap-3px pt-2px'>
          <span className='text-9px text-t-tertiary uppercase tracking-wide'>{t('ide.db.topValues')}</span>
          {profile.topValues.map((tv, i) => (
            <div key={i} className='flex items-center gap-5px'>
              <span
                className='w-90px shrink-0 truncate text-10px text-t-secondary'
                title={tv.value === null ? 'NULL' : String(tv.value)}
              >
                {tv.value === null ? <span className='italic text-t-tertiary'>NULL</span> : String(tv.value)}
              </span>
              <span className='relative h-9px flex-1 rd-full bg-fill-2 overflow-hidden'>
                <span
                  className='absolute inset-y-0 left-0 rd-full bg-primary'
                  style={{ width: `${Math.max(4, (tv.count / maxTop) * 100)}%`, opacity: 0.6 }}
                />
              </span>
              <span className='w-44px shrink-0 text-right font-mono text-9px text-t-tertiary'>
                {tv.count.toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
};

export default TableAnalyzePanel;

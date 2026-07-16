/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MarketView — the "Stocks" (chứng khoán) tab of the Realtime page.
 *
 * Shows a watchlist of indices + equities (Yahoo, with Stooq fallback) and
 * crypto (CoinGecko), grouped by kind, each with last price and colored daily
 * change %. The watchlist is **user-customizable**: add any Yahoo ticker
 * (`AAPL`, `^GSPC`, `BTC-USD`) or remove one; an empty custom list falls back to
 * the built-in default set. Polls the keyless market bridge every minute.
 *
 * Process boundary: Renderer. No Node.js APIs.
 */

import { Button, Empty, Input, Spin, Tooltip, Typography } from '@arco-design/web-react';
import { ChartLine, CloseSmall, Plus, Refresh } from '@icon-park/react';
import dayjs from 'dayjs';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { MarketKind, MarketQuote } from '@process/news/newsBridge';
import { newsClient } from '../newsBridgeClient';

const { Text } = Typography;

const POLL_MS = 60_000;
const GROUP_ORDER: MarketKind[] = ['index', 'stock', 'crypto'];

/** Built-in default watchlist (Yahoo symbols), used to seed a custom list. */
const DEFAULT_SYMBOLS = [
  '^GSPC',
  '^IXIC',
  '^DJI',
  'AAPL',
  'MSFT',
  'NVDA',
  'GOOGL',
  'AMZN',
  'TSLA',
  'BTC-USD',
  'ETH-USD',
  'SOL-USD',
];

const formatPrice = (price: number | null): string => {
  if (price == null) return '—';
  if (price >= 1000) return price.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (price >= 1) return price.toFixed(2);
  return price.toFixed(4);
};

const formatChange = (pct: number | null): string => {
  if (pct == null) return '—';
  return `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`;
};

const changeClass = (pct: number | null): string => {
  if (pct == null || pct === 0) return 'text-t-tertiary';
  return pct > 0 ? 'text-success-6' : 'text-danger-6';
};

const QuoteCard: React.FC<{ quote: MarketQuote; onRemove?: () => void; removeLabel: string }> = ({
  quote,
  onRemove,
  removeLabel,
}) => (
  <div className='group relative flex items-center justify-between gap-12px px-14px py-12px rd-10px border border-solid border-border-2 bg-bg-2 hover:border-primary-4 transition-colors'>
    <div className='min-w-0'>
      <div className='text-13px font-700 text-t-primary truncate'>{quote.symbol}</div>
      <div className='text-11px text-t-tertiary truncate'>{quote.name}</div>
    </div>
    <div className='text-right shrink-0'>
      <div className='text-14px font-600 text-t-primary tabular-nums'>{formatPrice(quote.price)}</div>
      <div className={`text-11px font-600 tabular-nums ${changeClass(quote.changePercent)}`}>
        {formatChange(quote.changePercent)}
      </div>
    </div>
    {onRemove && (
      <Tooltip content={removeLabel}>
        <Button
          type='text'
          size='mini'
          shape='circle'
          aria-label={removeLabel}
          className='!absolute !top-2px !right-2px opacity-0 group-hover:opacity-100 transition-opacity'
          icon={<CloseSmall theme='outline' size='14' className='text-t-tertiary' />}
          onClick={onRemove}
        />
      </Tooltip>
    )}
  </div>
);

type MarketViewProps = {
  /** User's custom Yahoo symbols; empty ⇒ built-in default watchlist. */
  customSymbols: string[];
  onUpdateSymbols: (symbols: string[]) => void;
};

const MarketView: React.FC<MarketViewProps> = ({ customSymbols, onUpdateSymbols }) => {
  const { t } = useTranslation();
  const [quotes, setQuotes] = useState<MarketQuote[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [draft, setDraft] = useState('');
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isCustom = customSymbols.length > 0;

  const load = useCallback(async (force = false) => {
    try {
      const result = await newsClient.marketQuotes({ force });
      if (result.ok) {
        setQuotes(result.quotes);
        setUpdatedAt(result.fetchedAt);
        setStatus('ready');
      } else {
        setStatus((prev) => (prev === 'ready' ? 'ready' : 'error'));
      }
    } catch {
      setStatus((prev) => (prev === 'ready' ? 'ready' : 'error'));
    }
  }, []);

  // Reload + reset poll whenever the watchlist changes (force to bypass cache).
  useEffect(() => {
    void load(true);
    timerRef.current = setInterval(() => void load(true), POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, [load, customSymbols]);

  const addSymbol = () => {
    const sym = draft.trim().toUpperCase();
    if (!sym) return;
    const current = isCustom ? customSymbols : DEFAULT_SYMBOLS;
    if (current.includes(sym)) {
      setDraft('');
      return;
    }
    onUpdateSymbols([...current, sym]);
    setDraft('');
  };

  const removeSymbol = (displaySym: string) => {
    // Map a displayed ticker back to its stored Yahoo symbol (crypto adds -USD).
    const base = isCustom ? customSymbols : DEFAULT_SYMBOLS;
    const next = base.filter((s) => s !== displaySym && s.replace(/-USD[TC]?$/i, '') !== displaySym);
    onUpdateSymbols(next);
  };

  const groups = GROUP_ORDER.map((kind) => ({ kind, items: quotes.filter((q) => q.kind === kind) })).filter(
    (g) => g.items.length > 0
  );

  return (
    <div className='h-full overflow-y-auto'>
      <div className='mx-auto w-full px-28px py-20px flex flex-col gap-20px' style={{ maxWidth: 920 }}>
        {/* Header */}
        <div className='flex items-center gap-10px'>
          <ChartLine theme='outline' size='18' className='text-primary-6' />
          <Text className='text-16px font-700 text-t-primary'>{t('news.market.title')}</Text>
          <span className='ml-auto flex items-center gap-8px'>
            {updatedAt != null && (
              <span className='text-11px text-t-tertiary'>
                {t('news.market.updated', { time: dayjs(updatedAt).format('HH:mm:ss') })}
              </span>
            )}
            <Button
              size='mini'
              type='text'
              aria-label={t('news.refresh')}
              icon={<Refresh theme='outline' size='13' />}
              onClick={() => void load(true)}
            />
          </span>
        </div>

        {/* Watchlist editor */}
        <div className='flex items-center gap-8px'>
          <Input
            size='small'
            allowClear
            value={draft}
            onChange={setDraft}
            onPressEnter={addSymbol}
            placeholder={t('news.market.addPlaceholder')}
            style={{ maxWidth: 220 }}
          />
          <Button size='small' type='primary' icon={<Plus theme='outline' size='13' />} onClick={addSymbol}>
            {t('news.market.add')}
          </Button>
          {isCustom && (
            <Button size='small' type='text' onClick={() => onUpdateSymbols([])}>
              {t('news.market.reset')}
            </Button>
          )}
        </div>

        {status === 'loading' ? (
          <div className='flex items-center justify-center py-48px'>
            <Spin size={24} />
          </div>
        ) : status === 'error' && quotes.length === 0 ? (
          <div className='flex flex-col items-center gap-12px py-12px'>
            <Empty description={t('news.market.error')} />
            <Button type='primary' size='small' onClick={() => void load(true)}>
              {t('news.retry')}
            </Button>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.kind} className='flex flex-col gap-10px'>
              <Text className='text-12px font-700 text-t-secondary uppercase tracking-wider'>
                {t(`news.market.group.${group.kind}`)}
              </Text>
              <div className='grid grid-cols-2 gap-12px'>
                {group.items.map((q) => (
                  <QuoteCard
                    key={`${q.kind}:${q.symbol}`}
                    quote={q}
                    removeLabel={t('news.market.remove')}
                    onRemove={() => removeSymbol(q.symbol)}
                  />
                ))}
              </div>
            </div>
          ))
        )}

        <Text className='text-10px text-t-tertiary leading-15px'>{t('news.market.symbolHint')}</Text>
      </div>
    </div>
  );
};

export default MarketView;

/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `ResultChart` — a dependency-free bar-chart visualization of a query result.
 * The user picks a label column and a numeric value column (Arco `Select`s);
 * the bars are rendered as plain SVG using UnoCSS semantic tokens (no chart
 * library, no hardcoded colours beyond the single data-viz accent token).
 *
 * Falls back to a hint when the result has no numeric column to plot. The label
 * column may be "row number" (index -1). Renderer-only.
 */

import { Empty, Select } from '@arco-design/web-react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { DbQueryResult } from './dbClient';
import { buildChartSpec, numericColumnIndices } from './dbChart';

type ResultChartProps = {
  result: DbQueryResult;
};

/** Chart geometry. */
const BAR_H = 22;
const BAR_GAP = 6;
const LABEL_W = 140;
const VALUE_W = 72;

const ResultChart: React.FC<ResultChartProps> = ({ result }) => {
  const { t } = useTranslation();
  const numeric = useMemo(() => numericColumnIndices(result), [result]);
  const [valueIndex, setValueIndex] = useState<number>(numeric[0] ?? -1);
  // Default the label to the first non-numeric column, else row number (-1).
  const defaultLabel = useMemo(() => {
    const numericSet = new Set(numeric);
    const firstText = result.columns.findIndex((_, i) => !numericSet.has(i));
    return firstText;
  }, [numeric, result.columns]);
  const [labelIndex, setLabelIndex] = useState<number>(defaultLabel);

  if (numeric.length === 0) {
    return (
      <div className='flex-1 min-h-0 flex-center'>
        <Empty description={<span className='text-12px text-t-tertiary'>{t('ide.db.chartNeedsNumeric')}</span>} />
      </div>
    );
  }

  const effectiveValue = numeric.includes(valueIndex) ? valueIndex : numeric[0];
  const spec = buildChartSpec(result, labelIndex, effectiveValue);
  const max = spec.values.reduce((m, v) => Math.max(m, Math.abs(v)), 0) || 1;
  const chartW = 520;
  const plotW = chartW - LABEL_W - VALUE_W;
  const height = spec.labels.length * (BAR_H + BAR_GAP) + BAR_GAP;

  return (
    <div className='flex-1 min-h-0 flex flex-col'>
      <div className='shrink-0 flex items-center gap-10px px-16px py-8px border-b border-b-1 bg-fill-1'>
        <span className='text-11px text-t-tertiary'>{t('ide.db.chartLabelColumn')}</span>
        <Select
          size='mini'
          value={labelIndex}
          onChange={setLabelIndex}
          style={{ width: 150 }}
          getPopupContainer={() => document.body}
        >
          <Select.Option value={-1}>{t('ide.db.chartRowNumber')}</Select.Option>
          {result.columns.map((name, i) => (
            <Select.Option key={i} value={i}>
              {name}
            </Select.Option>
          ))}
        </Select>
        <span className='text-11px text-t-tertiary'>{t('ide.db.chartValueColumn')}</span>
        <Select
          size='mini'
          value={effectiveValue}
          onChange={setValueIndex}
          style={{ width: 150 }}
          getPopupContainer={() => document.body}
        >
          {numeric.map((i) => (
            <Select.Option key={i} value={i}>
              {result.columns[i]}
            </Select.Option>
          ))}
        </Select>
      </div>
      <div className='flex-1 min-h-0 overflow-auto p-16px'>
        <svg width={chartW} height={height} role='img' aria-label={t('ide.db.chartAria')}>
          {spec.labels.map((label, i) => {
            const value = spec.values[i];
            const w = Math.max(1, (Math.abs(value) / max) * plotW);
            const y = BAR_GAP + i * (BAR_H + BAR_GAP);
            return (
              <g key={i}>
                <text
                  x={LABEL_W - 8}
                  y={y + BAR_H / 2}
                  textAnchor='end'
                  dominantBaseline='central'
                  fontSize={11}
                  fill='var(--color-text-2)'
                >
                  {label.length > 22 ? `${label.slice(0, 21)}…` : label}
                </text>
                <rect x={LABEL_W} y={y} width={w} height={BAR_H} rx={3} fill='var(--primary)' opacity={0.85} />
                <text
                  x={LABEL_W + w + 6}
                  y={y + BAR_H / 2}
                  dominantBaseline='central'
                  fontSize={10}
                  fill='var(--color-text-3)'
                >
                  {value}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
};

export default ResultChart;

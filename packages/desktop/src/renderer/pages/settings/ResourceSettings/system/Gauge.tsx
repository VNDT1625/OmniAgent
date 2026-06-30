/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { clampPercent, toneForPercent } from './formatters';

/** Tone → semantic text-color token (the arc uses `currentColor`). */
const TONE_COLOR: Record<'normal' | 'warning' | 'danger', string> = {
  normal: 'text-primary',
  warning: 'text-warning',
  danger: 'text-danger',
};

/**
 * A compact radial gauge (0–100%) rendered with SVG and semantic tokens.
 *
 * The arc colour follows the value tone (normal/warning/danger). Motion is a
 * single short stroke transition; users with `prefers-reduced-motion` get the
 * project-wide reduced-motion treatment from global CSS.
 */
const Gauge: React.FC<{ percent: number; label: string; caption?: string; size?: number }> = ({
  percent,
  label,
  caption,
  size = 104,
}) => {
  const value = clampPercent(percent);
  const stroke = 8;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - value / 100);
  const tone = toneForPercent(value);

  return (
    <div className='flex flex-col items-center gap-8px'>
      <div className='relative' style={{ width: size, height: size }}>
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={TONE_COLOR[tone]}>
          {/* Track */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill='none'
            stroke='currentColor'
            strokeWidth={stroke}
            className='text-fill-3 opacity-40'
          />
          {/* Value arc — rotated so it starts at the top. */}
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill='none'
            stroke='currentColor'
            strokeWidth={stroke}
            strokeLinecap='round'
            strokeDasharray={circumference}
            strokeDashoffset={offset}
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
            style={{ transition: 'stroke-dashoffset 400ms ease' }}
          />
        </svg>
        <div className='absolute inset-0 flex flex-col items-center justify-center'>
          <span className='text-22px font-700 text-t-primary leading-none tabular-nums'>{value}%</span>
        </div>
      </div>
      <div className='text-center'>
        <div className='text-13px font-600 text-t-primary'>{label}</div>
        {caption && <div className='text-11px text-t-tertiary mt-2px'>{caption}</div>}
      </div>
    </div>
  );
};

export default Gauge;

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { sparklinePoints } from './formatters';

/**
 * A tiny inline sparkline (SVG polyline) for a 0–100 series. Colour follows the
 * provided semantic text token via `currentColor`; the area under the line is a
 * faint fill of the same colour.
 */
const Sparkline: React.FC<{ values: number[]; width?: number; height?: number; colorClass?: string }> = ({
  values,
  width = 240,
  height = 44,
  colorClass = 'text-primary',
}) => {
  const line = sparklinePoints(values, width, height, 100);
  const area = values.length > 0 ? `0,${height} ${line} ${width},${height}` : '';

  return (
    <svg
      width='100%'
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio='none'
      className={colorClass}
    >
      {area && <polygon points={area} fill='currentColor' className='opacity-10' />}
      {line && (
        <polyline
          points={line}
          fill='none'
          stroke='currentColor'
          strokeWidth={2}
          strokeLinejoin='round'
          strokeLinecap='round'
        />
      )}
    </svg>
  );
};

export default Sparkline;

/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure formatting helpers for the System Insight UI. Kept dependency-free and
 * separate from React so they can be unit-tested directly.
 */

/** Format a memory amount in MB, promoting to GB above 1024 with one decimal. */
export const formatMemoryMB = (mb: number, mbUnit: string, gbUnit: string): string => {
  if (!Number.isFinite(mb) || mb <= 0) return `0 ${mbUnit}`;
  if (mb >= 1024) {
    const gb = Math.round((mb / 1024) * 10) / 10;
    return `${gb} ${gbUnit}`;
  }
  return `${Math.round(mb)} ${mbUnit}`;
};

/** Clamp a number into the 0–100 range and round it (for gauges/bars). */
export const clampPercent = (value: number): number => {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
};

/**
 * Format an uptime/duration in seconds as a compact `Xd Yh Zm` string using the
 * supplied unit suffixes. Drops leading zero units; always shows at least minutes.
 */
export const formatDuration = (totalSec: number, units: { day: string; hour: string; min: string }): string => {
  const sec = Math.max(0, Math.floor(totalSec));
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}${units.day}`);
  if (days > 0 || hours > 0) parts.push(`${hours}${units.hour}`);
  parts.push(`${minutes}${units.min}`);
  return parts.join(' ');
};

/** Pick a semantic tone token based on a 0–100 utilisation value. */
export const toneForPercent = (percent: number): 'normal' | 'warning' | 'danger' => {
  if (percent >= 90) return 'danger';
  if (percent >= 70) return 'warning';
  return 'normal';
};

/** Build an SVG polyline `points` string from a numeric series scaled to a box. */
export const sparklinePoints = (values: number[], width: number, height: number, max = 100): string => {
  if (values.length === 0) return '';
  if (values.length === 1) {
    const y = height - (clampPercent(values[0]) / max) * height;
    return `0,${y.toFixed(1)} ${width},${y.toFixed(1)}`;
  }
  const step = width / (values.length - 1);
  return values
    .map((value, index) => {
      const x = index * step;
      const y = height - (Math.min(max, Math.max(0, value)) / max) * height;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
};

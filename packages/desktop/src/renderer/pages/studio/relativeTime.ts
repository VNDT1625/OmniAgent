/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `relativeTime` — format an epoch-ms timestamp as a short, localized "time ago"
 * string using the platform `Intl.RelativeTimeFormat` (no extra dependency).
 */

const DIVISIONS: Array<{ amount: number; unit: Intl.RelativeTimeFormatUnit }> = [
  { amount: 60, unit: 'second' },
  { amount: 60, unit: 'minute' },
  { amount: 24, unit: 'hour' },
  { amount: 7, unit: 'day' },
  { amount: 4.34524, unit: 'week' },
  { amount: 12, unit: 'month' },
  { amount: Number.POSITIVE_INFINITY, unit: 'year' },
];

/**
 * Format `timestamp` relative to now (e.g. "2 days ago") in `locale`.
 *
 * @param timestamp - Epoch milliseconds.
 * @param locale - BCP-47 locale (defaults to the active i18n language at call site).
 */
export const formatRelativeTime = (timestamp: number, locale?: string): string => {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  let duration = (timestamp - Date.now()) / 1000;
  for (const division of DIVISIONS) {
    if (Math.abs(duration) < division.amount) {
      return rtf.format(Math.round(duration), division.unit);
    }
    duration /= division.amount;
  }
  return rtf.format(Math.round(duration), 'year');
};

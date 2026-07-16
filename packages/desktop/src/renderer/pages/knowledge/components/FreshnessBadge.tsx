/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import type { Freshness } from '@process/knowledge/realtime/rtkTypes';

/** Semantic-token colour per freshness state (no hardcoded hex). */
const TONE: Record<Freshness, { dot: string; text: string }> = {
  fresh: { dot: 'bg-success', text: 'text-success' },
  stale: { dot: 'bg-warning', text: 'text-warning' },
  expired: { dot: 'bg-danger', text: 'text-danger' },
  unknown: { dot: 'bg-fill-4', text: 'text-t-tertiary' },
};

/** A small pill showing a fact's freshness with a coloured dot + label. */
const FreshnessBadge: React.FC<{ freshness: Freshness }> = ({ freshness }) => {
  const { t } = useTranslation();
  const tone = TONE[freshness];
  return (
    <span className={`inline-flex items-center gap-6px text-12px font-600 ${tone.text}`} role='status'>
      <span className={`size-7px rd-full shrink-0 ${tone.dot}`} />
      {t(`realtimeKnowledge.freshness.${freshness}`)}
    </span>
  );
};

export default FreshnessBadge;

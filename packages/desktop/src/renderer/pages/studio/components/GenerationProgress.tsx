/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `GenerationProgress` — a shared progress indicator for AI "generate and wait"
 * flows in Studio (script/image generation, repo explain, workflow runs).
 *
 * Honesty about progress: a single provider call does not report real progress,
 * so this component shows what is actually knowable —
 *  - a **real elapsed timer** (counts up while active),
 *  - an **ETA learned from past runs** (an exponential moving average kept in
 *    `localStorage` per `opKey`), used both to show "~Xs left" and to drive an
 *    asymptotic bar that eases toward (but never reaches) 100% until the call
 *    actually finishes, and
 *  - **true determinate progress** when the caller passes `current`/`total`
 *    (multi-step jobs: render-all-scenes, workflow node runs).
 *
 * The caller times the operation and calls {@link recordGenDuration} on success
 * so the next run's estimate improves; it passes `estimateMs={getGenEstimate(...)}`.
 *
 * Renderer-only; Arco `Progress` + UnoCSS semantic tokens; text via i18n.
 */

import { Progress } from '@arco-design/web-react';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** localStorage key holding the per-operation EMA durations (ms). */
const DURATION_STORE_KEY = 'studio.genDurations';
/** Smoothing factor for the duration EMA (higher = adapts faster). */
const EMA_ALPHA = 0.3;

/** Read the stored EMA map (tolerant of corruption). */
const readDurations = (): Record<string, number> => {
  try {
    const raw = localStorage.getItem(DURATION_STORE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, number>) : {};
  } catch {
    return {};
  }
};

/**
 * Get the learned duration estimate (ms) for an operation, or `fallbackMs` when
 * nothing has been recorded yet.
 */
export const getGenEstimate = (opKey: string, fallbackMs: number): number => {
  const value = readDurations()[opKey];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallbackMs;
};

/** Fold a freshly observed duration into the stored EMA for an operation. */
export const recordGenDuration = (opKey: string, ms: number): void => {
  if (!Number.isFinite(ms) || ms <= 0) return;
  try {
    const all = readDurations();
    const prev = all[opKey];
    all[opKey] =
      typeof prev === 'number' && prev > 0 ? Math.round(prev * (1 - EMA_ALPHA) + ms * EMA_ALPHA) : Math.round(ms);
    localStorage.setItem(DURATION_STORE_KEY, JSON.stringify(all));
  } catch {
    /* storage unavailable — estimates are best-effort */
  }
};

/** Format a millisecond duration as `12s` or `1:05`. */
const formatDuration = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
};

type GenerationProgressProps = {
  /** Whether a generation is in flight (drives the timer + visibility). */
  active: boolean;
  /** Short label describing what is being generated (already translated). */
  label: string;
  /** Determinate mode: completed step count (paired with `total`). */
  current?: number;
  /** Determinate mode: total step count. When > 0, shows a true percentage. */
  total?: number;
  /** Indeterminate mode: learned duration estimate (ms) for the asymptotic bar + ETA. */
  estimateMs?: number;
  /** Extra classes for the wrapper. */
  className?: string;
};

const GenerationProgress: React.FC<GenerationProgressProps> = ({
  active,
  label,
  current,
  total,
  estimateMs,
  className,
}) => {
  const { t } = useTranslation();
  const [elapsed, setElapsed] = useState(0);
  const startRef = useRef(0);

  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    startRef.current = Date.now();
    setElapsed(0);
    const id = setInterval(() => setElapsed(Date.now() - startRef.current), 200);
    return () => clearInterval(id);
  }, [active]);

  if (!active) return null;

  const determinate = typeof total === 'number' && total > 0;
  let percent: number;
  if (determinate) {
    percent = Math.min(100, Math.round(((current ?? 0) / (total as number)) * 100));
  } else if (estimateMs && estimateMs > 0) {
    // Ease toward ~92% along the learned estimate; the real completion snaps to 100.
    percent = Math.min(92, Math.round((1 - Math.exp(-elapsed / estimateMs)) * 100));
  } else {
    percent = Math.min(90, Math.round((elapsed / 30000) * 90));
  }

  const elapsedText = formatDuration(elapsed);
  const etaText =
    !determinate && estimateMs && estimateMs > 0 ? formatDuration(Math.max(0, estimateMs - elapsed)) : null;

  return (
    <div className={`flex flex-col gap-4px ${className ?? ''}`}>
      <div className='flex items-center justify-between gap-8px text-12px'>
        <span className='text-t-secondary truncate'>{label}</span>
        <span className='shrink-0 font-mono text-t-tertiary'>
          {determinate ? `${current ?? 0}/${total} · ` : ''}
          {t('studio.progress.elapsed', { time: elapsedText })}
          {etaText ? ` · ${t('studio.progress.eta', { time: etaText })}` : ''}
        </span>
      </div>
      <Progress percent={percent} showText={false} animation strokeWidth={6} />
    </div>
  );
};

export default GenerationProgress;

/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Generation progress indicator for the "design a company from a description"
 * step. Designing a company is a SINGLE model call that does not stream tokens,
 * so a token-accurate percentage is impossible. Instead this shows an honest,
 * reassuring progress experience:
 *
 * - a staged status line (analysing → designing roles → assigning → finalising)
 *   that advances on a timer, paired with an elapsed-seconds counter, and
 * - a smooth bar that eases toward ~92% while waiting and snaps to 100% the
 *   moment the call resolves (driven by the `done` prop).
 *
 * The bar is deliberately labelled as an estimate (the caption says "đang chờ
 * mô hình…") so it never claims false precision.
 *
 * Renderer-only. Arco + UnoCSS semantic tokens; all copy via i18n.
 */

import { Progress } from '@arco-design/web-react';
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

/** Props for {@link GenerationProgress}. */
export type GenerationProgressProps = {
  /** Whether the generation is currently running. */
  active: boolean;
  /** Set true the instant the call resolves so the bar snaps to 100%. */
  done?: boolean;
  /**
   * Unix ms when the generation started (from the background store). When
   * provided, the elapsed timer is accurate even after a tab switch/remount.
   * Falls back to `Date.now()` on first render when absent.
   */
  startedAt?: number;
};

/** i18n keys for the rotating stage labels (advance roughly every few seconds). */
const STAGE_KEYS = [
  'company.describe.progress.analyzing',
  'company.describe.progress.designing',
  'company.describe.progress.assigning',
  'company.describe.progress.finalizing',
] as const;

/** How long (ms) to dwell on each stage before moving to the next. */
const STAGE_DWELL_MS = 4000;
/** Ceiling the bar eases toward while still waiting (never reaches 100 on its own). */
const WAIT_CEILING = 92;

/**
 * Respect reduced-motion: when the user prefers reduced motion, the bar jumps in
 * coarse steps instead of animating smoothly.
 */
const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * A staged, time-based progress indicator for a non-streaming generation call.
 */
const GenerationProgress: React.FC<GenerationProgressProps> = ({ active, done, startedAt }) => {
  const { t } = useTranslation();
  const [percent, setPercent] = useState(0);
  const [stage, setStage] = useState(0);
  const [seconds, setSeconds] = useState(0);
  const startRef = useRef<number>(0);

  useEffect(() => {
    if (!active) {
      setPercent(0);
      setStage(0);
      setSeconds(0);
      return;
    }

    // Use the store's startedAt when available so the elapsed timer is correct
    // even after a tab switch (the component remounts but the task kept running).
    startRef.current = startedAt ?? Date.now();
    const initialElapsed = Date.now() - startRef.current;
    // BUG FIX: when the user switches away and back, the component remounts and
    // `percent` returns to its initial value. If we always reset to 6 the bar
    // visibly snaps back to the start even though the work has been running for
    // a minute. Instead, derive the resumed percent from how long the run has
    // been going so the bar appears at roughly where it should be — same easing
    // as the wait loop, but applied as a single catch-up step.
    const seedPercent = (elapsedMs: number): number => {
      if (done) return 100;
      // Approximate the wait-loop ceiling: faster early, asymptotic to WAIT_CEILING.
      // 1 - exp(-elapsed/15s) gives 0.49 at 10s, 0.86 at 30s, 0.96 at 45s.
      const fraction = 1 - Math.exp(-elapsedMs / 15000);
      return Math.max(6, Math.min(WAIT_CEILING, Math.round(fraction * WAIT_CEILING)));
    };
    setPercent(seedPercent(initialElapsed));
    setStage(Math.min(STAGE_KEYS.length - 1, Math.floor(initialElapsed / STAGE_DWELL_MS)));
    setSeconds(Math.floor(initialElapsed / 1000));

    const reduced = prefersReducedMotion();
    const tickMs = reduced ? 1000 : 200;

    const timer = setInterval(() => {
      const elapsed = Date.now() - startRef.current;
      setSeconds(Math.floor(elapsed / 1000));
      setStage(Math.min(STAGE_KEYS.length - 1, Math.floor(elapsed / STAGE_DWELL_MS)));
      // Ease toward the ceiling: fast at first, slowing as it approaches.
      setPercent((prev) => {
        if (prev >= WAIT_CEILING) return WAIT_CEILING;
        const step = reduced ? 8 : Math.max(0.4, (WAIT_CEILING - prev) * 0.04);
        return Math.min(WAIT_CEILING, prev + step);
      });
    }, tickMs);

    return () => clearInterval(timer);
  }, [active, done, startedAt]);

  // Snap to 100% as soon as the call resolves.
  useEffect(() => {
    if (done) setPercent(100);
  }, [done]);

  if (!active) return null;

  return (
    <div className='flex flex-col gap-6px rd-10px border border-solid border-b-1 bg-1 px-12px py-10px'>
      <div className='flex items-center justify-between'>
        <span className='text-12px font-500 text-t-primary'>{t(STAGE_KEYS[stage])}</span>
        <span className='text-11px tabular-nums text-t-tertiary'>
          {t('company.describe.progress.elapsed', { seconds })}
        </span>
      </div>
      <Progress percent={Math.round(percent)} showText={false} animation status={done ? 'success' : 'normal'} />
      <span className='text-11px text-t-tertiary'>{t('company.describe.progress.waiting')}</span>
    </div>
  );
};

export default GenerationProgress;

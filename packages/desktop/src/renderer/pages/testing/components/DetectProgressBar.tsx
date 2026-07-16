/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `DetectProgressBar` — a live status strip for AI app-detection (Yêu cầu 2b —
 * UX). While the detector reads a project and asks the model how to run it, the
 * Main process streams {@link DetectProgress} updates; this surfaces them so the
 * user sees what the AI is reading/doing ("reading package.json", "asking the
 * model…") instead of an opaque spinner.
 *
 * Renderer-only, Arco + @icon-park/react + UnoCSS semantic tokens — no raw
 * interactive HTML, no hardcoded colors. Respects prefers-reduced-motion via the
 * Arco Progress component (no custom keyframes added here).
 */

import { Progress } from '@arco-design/web-react';
import { CheckOne, CloseOne, Components, FileSearchOne, Loading } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { DetectPhase, DetectProgress } from '../testingBridgeClient';

/** Props for {@link DetectProgressBar}. */
export type DetectProgressBarProps = {
  /** The latest detection progress, or undefined when idle (renders nothing). */
  progress?: DetectProgress;
};

/** Per-phase icon. Spinner for active phases, status marks for terminal ones. */
const phaseIcon = (phase: DetectPhase): React.ReactNode => {
  if (phase === 'done' || phase === 'cache') return <CheckOne theme='filled' size='14' className='text-success' />;
  if (phase === 'error') return <CloseOne theme='filled' size='14' className='text-danger' />;
  if (phase === 'reading' || phase === 'scanning')
    return <FileSearchOne theme='outline' size='14' className='text-primary' />;
  if (phase === 'analyzing') return <Components theme='outline' size='14' className='text-primary' />;
  return <Loading theme='outline' size='14' className='text-primary animate-spin' />;
};

/** Coarse percent fallback per phase when the backend omits an explicit value. */
const PHASE_PERCENT: Record<DetectPhase, number> = {
  scanning: 15,
  reading: 35,
  analyzing: 60,
  parsing: 90,
  cache: 100,
  done: 100,
  error: 100,
};

/** Progress bar colour: green on done/cache, red on error, primary otherwise. */
const statusColor = (phase: DetectPhase): string | undefined => {
  if (phase === 'done' || phase === 'cache') return 'rgb(var(--success-6))';
  if (phase === 'error') return 'rgb(var(--danger-6))';
  return undefined;
};

/**
 * Render a one-line AI-detection status strip with a phase label, the file the
 * AI is currently reading (when any), and a thin progress bar.
 */
const DetectProgressBar: React.FC<DetectProgressBarProps> = ({ progress }) => {
  const { t } = useTranslation();
  if (!progress) return null;

  const { phase, message } = progress;
  const percent = progress.percent ?? PHASE_PERCENT[phase];
  const isError = phase === 'error';
  // For "reading", message holds the file path — show it after the phase label.
  const detail = phase === 'reading' && message ? message : isError ? message : '';

  return (
    <div
      className='flex flex-col gap-4px rd-6px border border-border-base bg-fill-1 p-8px'
      role='status'
      aria-live='polite'
      data-testid='detect-progress'
    >
      <div className='flex items-center gap-6px'>
        <span className='flex-center shrink-0'>{phaseIcon(phase)}</span>
        <span className={`text-12px font-600 ${isError ? 'text-danger' : 'text-t-primary'}`}>
          {t(`testing.detect.phase_${phase}`)}
        </span>
        {detail ? <span className='text-11px text-t-tertiary font-mono truncate'>{detail}</span> : null}
      </div>
      <Progress
        percent={Math.max(0, Math.min(100, percent))}
        showText={false}
        size='small'
        status={isError ? 'error' : phase === 'done' || phase === 'cache' ? 'success' : 'normal'}
        color={statusColor(phase)}
      />
    </div>
  );
};

export default DetectProgressBar;

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `GenerateProgressBar` — a live status strip for AI scenario generation (Yêu
 * cầu 2b — UX). While the model turns a plain-language description into concrete
 * steps, the Main process streams {@link GenerateProgress} updates; this surfaces
 * them ("asking the model…", "building steps…") so the user sees what the AI is
 * doing instead of a bare button spinner.
 *
 * Mirrors {@link DetectProgressBar}. Renderer-only, Arco + @icon-park/react +
 * UnoCSS semantic tokens — no raw interactive HTML, no hardcoded colors. Respects
 * prefers-reduced-motion via the Arco Progress component (no custom keyframes).
 */

import { Progress } from '@arco-design/web-react';
import { Brain, CheckOne, CloseOne, Components, Loading } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { GeneratePhase, GenerateProgress } from '../testingBridgeClient';

/** Props for {@link GenerateProgressBar}. */
export type GenerateProgressBarProps = {
  /** The latest generation progress, or undefined when idle (renders nothing). */
  progress?: GenerateProgress;
};

/** Per-phase icon. Spinner for active phases, status marks for terminal ones. */
const phaseIcon = (phase: GeneratePhase): React.ReactNode => {
  if (phase === 'done') return <CheckOne theme='filled' size='14' className='text-success' />;
  if (phase === 'error') return <CloseOne theme='filled' size='14' className='text-danger' />;
  if (phase === 'thinking') return <Brain theme='outline' size='14' className='text-primary' />;
  if (phase === 'parsing') return <Components theme='outline' size='14' className='text-primary' />;
  return <Loading theme='outline' size='14' className='text-primary animate-spin' />;
};

/** Coarse percent fallback per phase when the backend omits an explicit value. */
const PHASE_PERCENT: Record<GeneratePhase, number> = {
  preparing: 10,
  thinking: 45,
  parsing: 85,
  done: 100,
  error: 100,
};

/** Progress bar colour: green on done, red on error, primary otherwise. */
const statusColor = (phase: GeneratePhase): string | undefined => {
  if (phase === 'done') return 'rgb(var(--success-6))';
  if (phase === 'error') return 'rgb(var(--danger-6))';
  return undefined;
};

/**
 * Render a one-line AI-generation status strip with a phase label, an optional
 * detail (the model id while thinking, the step count while done, or the error
 * message), and a thin progress bar.
 */
const GenerateProgressBar: React.FC<GenerateProgressBarProps> = ({ progress }) => {
  const { t } = useTranslation();
  if (!progress) return null;

  const { phase, message } = progress;
  const percent = progress.percent ?? PHASE_PERCENT[phase];
  const isError = phase === 'error';
  // `thinking` → message holds the model id; `done` → the step count; `error` →
  // the failure message. Other phases have no useful inline detail.
  const detail =
    phase === 'thinking' && message
      ? message
      : phase === 'done' && message
        ? t('testing.generate.stepsCount', { count: Number(message) || 0 })
        : isError
          ? message
          : '';

  return (
    <div
      className='flex flex-col gap-4px rd-6px border border-border-base bg-fill-1 p-8px'
      role='status'
      aria-live='polite'
      data-testid='generate-progress'
    >
      <div className='flex items-center gap-6px'>
        <span className='flex-center shrink-0'>{phaseIcon(phase)}</span>
        <span className={`text-12px font-600 ${isError ? 'text-danger' : 'text-t-primary'}`}>
          {t(`testing.generate.phase_${phase}`)}
        </span>
        {detail ? <span className='text-11px text-t-tertiary font-mono truncate'>{detail}</span> : null}
      </div>
      <Progress
        percent={Math.max(0, Math.min(100, percent))}
        showText={false}
        size='small'
        status={isError ? 'error' : phase === 'done' ? 'success' : 'normal'}
        color={statusColor(phase)}
      />
    </div>
  );
};

export default GenerateProgressBar;

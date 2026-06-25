/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `RunLogPanel` — the bottom dock showing a workflow run's live event log. Each
 * line is colour-coded by outcome (step ok / step failed / run done / run
 * failed). Some lines carry an i18n key (`run.start` / `run.done` / `run.failed`)
 * which is translated here; node lines carry already-formatted text.
 *
 * Presentational; all fixed text via i18n; UnoCSS semantic tokens only.
 */

import { Button } from '@arco-design/web-react';
import { DeleteFour } from '@icon-park/react';
import React, { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import GenerationProgress from '../../components/GenerationProgress';
import type { RunLogLine } from '../useAutomation';

type RunLogPanelProps = {
  lines: RunLogLine[];
  running: boolean;
  onClear: () => void;
  /** Total step count of the running workflow (for determinate progress). */
  totalSteps?: number;
};

/** Translate the few keyed lines; pass node lines through verbatim. */
const renderText = (line: RunLogLine, t: (k: string) => string): string => {
  if (line.text === 'run.start') return t('automation.log.runStart');
  if (line.text === 'run.done') return t('automation.log.runDone');
  if (line.text === 'run.failed') return t('automation.log.runFailed');
  return line.text;
};

/** Colour token for a log line kind. */
const colorClass = (kind: RunLogLine['kind']): string => {
  switch (kind) {
    case 'node-ok':
    case 'done':
      return 'text-success';
    case 'node-fail':
    case 'failed':
      return 'text-danger';
    default:
      return 'text-t-secondary';
  }
};

const RunLogPanel: React.FC<RunLogPanelProps> = ({ lines, running, onClear, totalSteps }) => {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines]);

  // Determinate progress: count finished steps (ok or fail) from the log.
  const completedSteps = lines.filter((l) => l.kind === 'node-ok' || l.kind === 'node-fail').length;

  return (
    <section className='shrink-0 h-180px flex flex-col border-t border-b-1 bg-2'>
      <header className='shrink-0 flex items-center gap-8px px-14px py-8px border-b border-b-1'>
        {running ? <span className='size-7px rd-full bg-primary animate-pulse' /> : null}
        <span className='text-12px font-[500] text-t-secondary'>{t('automation.log.title')}</span>
        <div className='flex-1' />
        <Button type='text' size='mini' icon={<DeleteFour theme='outline' size={13} />} onClick={onClear}>
          {t('automation.log.clear')}
        </Button>
      </header>
      {running && totalSteps && totalSteps > 0 ? (
        <div className='shrink-0 px-14px pt-8px'>
          <GenerationProgress active label={t('automation.log.title')} current={completedSteps} total={totalSteps} />
        </div>
      ) : null}
      <div
        ref={scrollRef}
        className='flex-1 min-h-0 overflow-y-auto px-14px py-8px font-mono text-12px leading-relaxed flex flex-col gap-2px'
      >
        {lines.map((line) => (
          <span key={line.id} className={colorClass(line.kind)}>
            {renderText(line, t)}
          </span>
        ))}
      </div>
    </section>
  );
};

export default RunLogPanel;

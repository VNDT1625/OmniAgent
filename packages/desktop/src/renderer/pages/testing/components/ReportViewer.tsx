/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `ReportViewer` — IDE-style presentation of a test report (Yêu cầu 2b,
 * criterion 2.5): a pass/fail summary, a per-step table (with screenshots), and
 * the recorded video. Presentational only; data comes from the testing client.
 */

import { Image, Tag, Typography } from '@arco-design/web-react';
import { CheckOne, CloseOne, VideoTwo } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import ReportScreenshot from './ReportScreenshot';
import type { TestingReport } from '../testingBridgeClient';

/** Props for {@link ReportViewer}. */
export type ReportViewerProps = {
  /** The structured report to render, or `undefined` when none is selected. */
  report?: TestingReport;
};

/**
 * Render a single test report: summary header, step rows + screenshots, video.
 */
const ReportViewer: React.FC<ReportViewerProps> = ({ report }) => {
  const { t } = useTranslation();

  if (!report) {
    return <div className='flex-center h-full text-13px text-t-tertiary'>{t('testing.report.empty')}</div>;
  }

  return (
    <div className='flex flex-col h-full gap-12px'>
      <header className='flex items-center gap-12px'>
        <Typography.Title heading={6} className='m-0'>
          {report.scenarioName}
        </Typography.Title>
        <Tag color={report.platform === 'web' ? 'arcoblue' : report.platform === 'android' ? 'green' : 'purple'}>
          {report.platform}
        </Tag>
        <Tag
          color={report.passed ? 'green' : 'red'}
          icon={report.passed ? <CheckOne theme='outline' size='12' /> : <CloseOne theme='outline' size='12' />}
        >
          {report.passed ? t('testing.report.passed') : t('testing.report.failed')}
        </Tag>
        <span className='text-12px text-t-tertiary'>
          {t('testing.report.stepsSummary', { passed: report.passedCount, total: report.total })}
        </span>
      </header>

      {report.error ? (
        <div className='rd-6px border border-danger/40 bg-danger/10 p-10px'>
          <div className='text-12px font-600 text-danger mb-4px'>{t('testing.report.setupError')}</div>
          <pre className='m-0 whitespace-pre-wrap break-words font-mono text-11px text-t-secondary'>{report.error}</pre>
        </div>
      ) : null}

      <div className='flex-1 min-h-0 overflow-auto flex flex-col gap-8px'>
        {report.steps.map((step) => (
          <div
            key={step.index}
            className='border border-border-base rd-6px p-10px flex flex-col gap-6px'
            data-testid='report-step'
          >
            <div className='flex items-center gap-8px'>
              {step.passed ? (
                <CheckOne theme='outline' size='14' className='text-success' />
              ) : (
                <CloseOne theme='outline' size='14' className='text-danger' />
              )}
              <span className='text-13px text-t-primary'>
                {step.index}. {step.description}
              </span>
            </div>
            {step.detail ? <p className='m-0 pl-22px text-12px text-t-secondary'>{step.detail}</p> : null}
            {step.screenshots.length > 0 ? (
              <div className='pl-22px flex flex-wrap items-center gap-6px'>
                <Image.PreviewGroup infinite>
                  {step.screenshots.map((shot) => (
                    <ReportScreenshot key={shot} path={shot} />
                  ))}
                </Image.PreviewGroup>
              </div>
            ) : null}
          </div>
        ))}
      </div>

      {report.videoPath ? (
        <footer className='flex items-center gap-6px text-12px text-t-secondary'>
          <VideoTwo theme='outline' size='14' />
          <span className='font-mono truncate'>{report.videoPath}</span>
        </footer>
      ) : null}
    </div>
  );
};

export default ReportViewer;

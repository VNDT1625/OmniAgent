/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Bug Monitor page (Yêu cầu 6) — surfaces the full monitor loop in two sections:
 *
 * 1. **Proposed fixes** — auto-generated patch proposals with their root cause,
 *    risk, gate status, and the approval gate actions (approve & apply / reject /
 *    roll back). This is the human-in-the-loop control point (criteria 6.5–6.7).
 * 2. **Reports** — the auto-collected + user-filed bug reports with occurrence
 *    counts and known-fix markers (criteria 6.1 / 6.2 / 6.9).
 *
 * Desktop-only (the monitor is a Main-process service), degrading to a notice in
 * WebUI mode — mirrors the other OmniAgent pages.
 */

import { isElectronDesktop } from '@/renderer/utils/platform';
import AionScrollArea from '@/renderer/components/base/AionScrollArea';
import { useSettingsViewMode } from '@/renderer/components/settings/SettingsModal/settingsViewContext';
import { Button, Empty, Tag } from '@arco-design/web-react';
import { Bug, CheckOne, Refresh, Tool } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import ProposalCard from './components/ProposalCard';
import { useMonitorState } from './useMonitorState';

/** Proposals that are no longer actionable + uninteresting are hidden from the top section. */
const isLiveProposal = (status: string): boolean => status !== 'rejected' && status !== 'rolled-back';

/** The Bug Monitor page. */
const MonitorPage: React.FC = () => {
  const { t } = useTranslation();
  const viewMode = useSettingsViewMode();
  const isPageMode = viewMode === 'page';
  const isDesktop = isElectronDesktop();
  const { reports, proposals, status, busyId, refresh, fix, approve, reject, rollback, publish } =
    useMonitorState(isDesktop);

  if (!isDesktop) {
    return (
      <div className='flex flex-col items-center gap-12px py-56px text-center'>
        <span className='size-48px flex-center rd-full bg-fill-2 text-t-tertiary'>
          <Bug theme='outline' size='24' />
        </span>
        <p className='m-0 max-w-420px text-13px text-t-secondary'>{t('monitor.desktopOnly')}</p>
      </div>
    );
  }

  const liveProposals = proposals.filter((p) => isLiveProposal(p.status));

  return (
    <div className='flex flex-col h-full w-full'>
      <header className='mb-16px flex items-center justify-between'>
        <div>
          <h2 className='m-0 text-20px font-700 text-t-primary'>{t('monitor.title')}</h2>
          <p className='m-0 mt-4px text-13px text-t-secondary'>{t('monitor.subtitle')}</p>
        </div>
        <Button size='small' icon={<Refresh theme='outline' size='14' />} onClick={refresh}>
          {t('monitor.refresh')}
        </Button>
      </header>

      <AionScrollArea className='flex-1 min-h-0 pb-16px' disableOverflow={isPageMode}>
        {status === 'unavailable' ? (
          <div className='p-12px text-12px text-t-tertiary'>{t('monitor.unavailable')}</div>
        ) : (
          <div className='flex flex-col gap-20px'>
            <section className='flex flex-col gap-8px'>
              <h3 className='m-0 text-14px font-600 text-t-primary'>{t('monitor.section.proposals')}</h3>
              {liveProposals.length === 0 ? (
                <Empty description={t('monitor.noProposals')} />
              ) : (
                liveProposals.map((p) => (
                  <ProposalCard
                    key={p.proposalId}
                    proposal={p}
                    busy={busyId === p.proposalId}
                    onApprove={approve}
                    onReject={reject}
                    onRollback={rollback}
                    onPublish={publish}
                  />
                ))
              )}
            </section>

            <section className='flex flex-col gap-8px'>
              <h3 className='m-0 text-14px font-600 text-t-primary'>{t('monitor.section.reports')}</h3>
              {reports.length === 0 ? (
                <Empty description={t('monitor.noReports')} />
              ) : (
                reports.map((r) => (
                  <div
                    key={r.id}
                    className='border border-border-base rd-6px p-12px flex flex-col gap-6px'
                    data-testid='report-item'
                  >
                    <div className='flex items-center justify-between gap-8px'>
                      <span className='text-13px font-500 text-t-primary truncate'>{r.title}</span>
                      <div className='flex items-center gap-6px shrink-0'>
                        {r.knownFixId ? (
                          <Tag color='green' size='small' icon={<CheckOne theme='outline' size='12' />}>
                            {t('monitor.report.knownFix')}
                          </Tag>
                        ) : null}
                        <Tag size='small'>{t('monitor.report.occurrences', { count: r.occurrences })}</Tag>
                      </div>
                    </div>
                    <p className='m-0 text-12px text-t-secondary line-clamp-2'>{r.message}</p>
                    <div className='flex items-center justify-between gap-8px'>
                      <span className='text-11px text-t-tertiary'>
                        {t('monitor.report.source')}: {r.source}
                      </span>
                      <Button
                        type='primary'
                        size='mini'
                        loading={busyId === r.id}
                        icon={<Tool theme='outline' size='13' />}
                        onClick={() => fix(r.id)}
                      >
                        {t('monitor.report.fix')}
                      </Button>
                    </div>
                  </div>
                ))
              )}
            </section>
          </div>
        )}
      </AionScrollArea>
    </div>
  );
};

export default MonitorPage;

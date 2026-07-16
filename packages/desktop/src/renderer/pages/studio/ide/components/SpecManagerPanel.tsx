/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `SpecManagerPanel` — the spec-driven workflow command center for the IDE.
 *
 * Reads the active `.aionui/specs/<slug>/` directory and renders a Kiro-grade
 * health view across three dimensions:
 *  1. EARS requirements validation (how normative + well-shaped each criterion is),
 *  2. Req↔Task↔Test traceability (which requirements a task covers / verifies),
 *  3. Phase gates + Definition of Done (which phase is active, what blocks it).
 *
 * A single readiness score (0..100) summarizes spec discipline. All analysis is
 * pure (`@/common/spec`) and runs in the Main process via `ideClient.specAnalyze`;
 * this panel only renders the result. Renderer-only: no Node APIs.
 */

import { Button, Empty, Progress, Spin, Tag, Tooltip } from '@arco-design/web-react';
import { CheckOne, CloseOne, Info, Refresh, RightOne, Search } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SpecAnalysis, SpecDiagnostic, SpecSeverity } from '@/common/spec';
import { ideClient, type SpecApprovalGate, type SpecLifecyclePhase, type SpecLifecycleStatus } from '../ideClient';

type SpecManagerPanelProps = {
  rootPath: string | null;
};

/** Ordered lifecycle phases for the gated timeline. */
const PHASE_ORDER: readonly SpecLifecyclePhase[] = ['requirements', 'design', 'tasks', 'execution', 'complete'];

/** The approval gate that leaves a given phase (null for execution/complete). */
const gateForPhase = (phase: SpecLifecyclePhase): SpecApprovalGate | null =>
  phase === 'requirements' || phase === 'design' || phase === 'tasks' ? phase : null;

/** Map a 0..100 score to a semantic status color used by the gauge + label. */
const scoreStatus = (score: number): 'success' | 'warning' | 'error' => {
  if (score >= 80) return 'success';
  if (score >= 50) return 'warning';
  return 'error';
};

/** Icon + token color per diagnostic severity. */
const SeverityIcon: React.FC<{ severity: SpecSeverity }> = ({ severity }) => {
  if (severity === 'error') return <CloseOne theme='filled' size={14} className='text-danger-6 shrink-0' />;
  if (severity === 'warning') return <Info theme='filled' size={14} className='text-warning-6 shrink-0' />;
  return <Info theme='outline' size={14} className='text-t-tertiary shrink-0' />;
};

/** One labelled metric chip in the summary strip. */
const Metric: React.FC<{ label: string; value: string; tone?: 'default' | 'good' | 'bad' }> = ({
  label,
  value,
  tone = 'default',
}) => {
  const valueClass = tone === 'good' ? 'text-success-6' : tone === 'bad' ? 'text-danger-6' : 'text-t-primary';
  return (
    <div className='flex flex-col gap-2px px-12px py-8px rounded-8px bg-fill-1 border border-border-1 min-w-92px'>
      <span className='text-11px text-t-tertiary leading-none'>{label}</span>
      <span className={`text-18px font-700 leading-tight ${valueClass}`}>{value}</span>
    </div>
  );
};

/** A titled section card. */
const SectionCard: React.FC<{ title: string; extra?: React.ReactNode; children: React.ReactNode }> = ({
  title,
  extra,
  children,
}) => (
  <section className='rounded-12px border border-border-2 bg-bg-2 overflow-hidden'>
    <header className='flex items-center justify-between px-14px py-10px border-b border-b-border-1 bg-fill-1'>
      <h3 className='text-13px font-600 text-t-primary m-0'>{title}</h3>
      {extra}
    </header>
    <div className='p-14px flex flex-col gap-10px'>{children}</div>
  </section>
);

/**
 * `PhaseTimeline` — the Kiro-style gated lifecycle stepper. Renders the five
 * phases (requirements → design → tasks → execution → complete), marks done /
 * active / upcoming, and surfaces the single "Approve & continue" action for
 * the current gate so progress is deliberate and observable.
 */
const PhaseTimeline: React.FC<{
  t: (key: string, opts?: Record<string, unknown>) => string;
  phase: SpecLifecyclePhase;
  approvals: SpecLifecycleStatus['approvals'];
  advancing: boolean;
  onApprove: (gate: SpecApprovalGate) => void;
}> = ({ t, phase, approvals, advancing, onApprove }) => {
  const currentIndex = PHASE_ORDER.indexOf(phase);
  const activeGate = gateForPhase(phase);
  return (
    <section className='rounded-12px border border-border-2 bg-bg-2 overflow-hidden'>
      <header className='flex items-center justify-between px-14px py-10px border-b border-b-border-1 bg-fill-1'>
        <h3 className='text-13px font-600 text-t-primary m-0'>{t('ide.spec.lifecycle.title')}</h3>
        {activeGate ? (
          <Button
            type='primary'
            size='small'
            loading={advancing}
            icon={<CheckOne theme='outline' size={14} />}
            onClick={() => onApprove(activeGate)}
          >
            {t(`ide.spec.lifecycle.approve.${activeGate}`)}
          </Button>
        ) : (
          <Tag color={phase === 'complete' ? 'green' : 'arcoblue'} size='small'>
            {t(`ide.spec.lifecycle.phase.${phase}`)}
          </Tag>
        )}
      </header>
      <div className='p-14px flex items-stretch gap-4px'>
        {PHASE_ORDER.map((p, index) => {
          const done = index < currentIndex;
          const active = index === currentIndex;
          const tone = done
            ? 'text-success-6 bg-success-light-1 border-success-3'
            : active
              ? 'text-primary bg-primary-light-1 border-primary-6'
              : 'text-t-tertiary bg-fill-1 border-border-1';
          return (
            <React.Fragment key={p}>
              <div className={`flex-1 flex flex-col items-center gap-4px px-6px py-8px rounded-8px border ${tone}`}>
                {done ? (
                  <CheckOne theme='filled' size={16} />
                ) : active ? (
                  <RightOne theme='filled' size={16} />
                ) : (
                  <Info theme='outline' size={16} />
                )}
                <span className='text-11px font-600 text-center leading-tight'>
                  {t(`ide.spec.lifecycle.phase.${p}`)}
                </span>
                {approvals && (p === 'requirements' || p === 'design' || p === 'tasks') && approvals[p] ? (
                  <span className='text-9px text-success-6 font-600 uppercase'>{t('ide.spec.lifecycle.approved')}</span>
                ) : null}
              </div>
              {index < PHASE_ORDER.length - 1 ? (
                <div className='flex items-center'>
                  <RightOne theme='outline' size={12} className='text-t-tertiary' />
                </div>
              ) : null}
            </React.Fragment>
          );
        })}
      </div>
    </section>
  );
};

const SpecManagerPanel: React.FC<SpecManagerPanelProps> = ({ rootPath }) => {
  const { t } = useTranslation();
  const [analysis, setAnalysis] = useState<SpecAnalysis | null>(null);
  const [lifecycle, setLifecycle] = useState<SpecLifecycleStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [advancing, setAdvancing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<void> => {
    if (!rootPath) return;
    setLoading(true);
    setError(null);
    try {
      const statusResult = await ideClient.specStatus(rootPath).catch((): null => null);
      setLifecycle(statusResult?.ok ? statusResult.data : null);
      const result = await ideClient.specAnalyze(rootPath);
      if (result.ok) {
        setAnalysis(result.data);
      } else {
        setAnalysis(null);
        setError((result as { error?: string }).error ?? 'Unknown error');
      }
    } catch (err: unknown) {
      setAnalysis(null);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [rootPath]);

  const approveGate = useCallback(
    async (gate: SpecApprovalGate): Promise<void> => {
      if (!rootPath || advancing) return;
      setAdvancing(true);
      try {
        const result = await ideClient.specAdvancePhase(rootPath, gate, lifecycle?.slug ?? undefined);
        if (result.ok) setLifecycle(result.data);
        await refresh();
      } finally {
        setAdvancing(false);
      }
    },
    [rootPath, advancing, lifecycle?.slug, refresh]
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const grouped = useMemo(() => {
    const errors: SpecDiagnostic[] = [];
    const warnings: SpecDiagnostic[] = [];
    const infos: SpecDiagnostic[] = [];
    for (const d of analysis?.diagnostics ?? []) {
      if (d.severity === 'error') errors.push(d);
      else if (d.severity === 'warning') warnings.push(d);
      else infos.push(d);
    }
    return { errors, warnings, infos };
  }, [analysis]);

  if (!rootPath) {
    return (
      <div className='size-full flex items-center justify-center'>
        <Empty description={t('ide.spec.noFolder')} />
      </div>
    );
  }

  if (loading && !analysis) {
    return (
      <div className='size-full flex items-center justify-center'>
        <Spin tip={t('ide.spec.analyzing')} />
      </div>
    );
  }

  if (error || !analysis) {
    return (
      <div className='size-full flex flex-col items-center justify-center gap-12px'>
        <Empty description={error ? t('ide.spec.error', { error }) : t('ide.spec.noSpec')} />
        <Button type='primary' size='small' icon={<Refresh theme='outline' size={14} />} onClick={() => void refresh()}>
          {t('ide.spec.refresh')}
        </Button>
      </div>
    );
  }

  const status = scoreStatus(analysis.score);
  const req = analysis.requirements;
  const trace = analysis.traceability;
  const gates = analysis.phaseGates;

  return (
    <div className='size-full overflow-auto'>
      <div className='max-w-960px mx-auto p-20px flex flex-col gap-16px'>
        {/* Header: title + readiness gauge + refresh. */}
        <header className='flex items-center gap-20px'>
          <div className='shrink-0'>
            <Progress
              type='circle'
              percent={analysis.score}
              status={status}
              size='large'
              formatText={(p) => <span className='text-22px font-700'>{p}</span>}
            />
          </div>
          <div className='flex-1 min-w-0 flex flex-col gap-4px'>
            <div className='flex items-center gap-8px'>
              <h2 className='text-18px font-700 text-t-primary m-0 truncate'>{t('ide.spec.title')}</h2>
              <Tag color={status === 'success' ? 'green' : status === 'warning' ? 'orange' : 'red'} size='small'>
                {t(`ide.spec.health.${status}`)}
              </Tag>
            </div>
            <span className='text-12px text-t-secondary truncate'>{`.omni/specs/${analysis.slug}/`}</span>
            <p className='text-12px text-t-tertiary m-0 mt-2px leading-snug'>{t('ide.spec.scoreHint')}</p>
          </div>
          <Button
            type='secondary'
            size='small'
            loading={loading}
            icon={<Refresh theme='outline' size={14} />}
            onClick={() => void refresh()}
          >
            {t('ide.spec.refresh')}
          </Button>
        </header>

        {/* Lifecycle phase timeline with approval gates (Kiro spec-driven). */}
        {lifecycle?.exists && lifecycle.phase ? (
          <PhaseTimeline
            t={t}
            phase={lifecycle.phase}
            approvals={lifecycle.approvals}
            advancing={advancing}
            onApprove={approveGate}
          />
        ) : null}

        {/* Summary metrics. */}
        <div className='flex flex-wrap gap-10px'>
          <Metric label={t('ide.spec.metric.requirements')} value={String(req.counts.total)} />
          <Metric
            label={t('ide.spec.metric.earsCompliant')}
            value={`${req.counts.earsCompliant}/${req.counts.total}`}
            tone={req.counts.total > 0 && req.counts.earsCompliant === req.counts.total ? 'good' : 'default'}
          />
          <Metric
            label={t('ide.spec.metric.covered')}
            value={`${trace.counts.coveredRequirements}/${trace.counts.requirements}`}
            tone={trace.uncoveredReqIds.length > 0 ? 'bad' : 'good'}
          />
          <Metric
            label={t('ide.spec.metric.verified')}
            value={`${trace.counts.verifiedRequirements}/${trace.counts.requirements}`}
          />
          <Metric
            label={t('ide.spec.metric.activePhase')}
            value={gates.activePhaseIndex ? `#${gates.activePhaseIndex}` : t('ide.spec.metric.allDone')}
          />
        </div>

        {/* EARS requirements. */}
        <SectionCard title={t('ide.spec.section.requirements')}>
          {req.requirements.length === 0 ? (
            <span className='text-12px text-t-tertiary'>{t('ide.spec.emptyRequirements')}</span>
          ) : (
            req.requirements.map((r) => (
              <div key={r.id} className='flex flex-col gap-4px py-6px border-b border-b-border-1 last:border-b-0'>
                <div className='flex items-center gap-8px'>
                  <Tag size='small' color='arcoblue'>
                    {r.id}
                  </Tag>
                  <span className='text-13px font-600 text-t-primary truncate'>{r.title}</span>
                  <span className='text-11px text-t-tertiary ml-auto shrink-0'>
                    {t('ide.spec.criteriaCount', { count: r.criteria.length })}
                  </span>
                </div>
                {r.criteria.map((c) => (
                  <div key={c.line} className='flex items-start gap-6px pl-6px'>
                    {c.hasShall && c.pattern !== 'unknown' ? (
                      <CheckOne theme='filled' size={13} className='text-success-6 shrink-0 mt-2px' />
                    ) : (
                      <Info theme='outline' size={13} className='text-warning-6 shrink-0 mt-2px' />
                    )}
                    <span className='text-12px text-t-secondary leading-snug flex-1 min-w-0'>{c.text}</span>
                    <Tooltip content={t(`ide.spec.ears.${c.pattern}`)}>
                      <Tag size='small' bordered className='shrink-0'>
                        {t(`ide.spec.ears.${c.pattern}`)}
                      </Tag>
                    </Tooltip>
                  </div>
                ))}
              </div>
            ))
          )}
        </SectionCard>

        {/* Traceability matrix. */}
        <SectionCard title={t('ide.spec.section.traceability')}>
          {trace.rows.length === 0 ? (
            <span className='text-12px text-t-tertiary'>{t('ide.spec.emptyRequirements')}</span>
          ) : (
            <div className='flex flex-col gap-2px'>
              {trace.rows.map((row) => (
                <div
                  key={row.reqId}
                  className='flex items-center gap-8px py-6px border-b border-b-border-1 last:border-b-0'
                >
                  <Tag size='small' color={row.taskIds.length > 0 ? 'arcoblue' : 'gray'}>
                    {row.reqId}
                  </Tag>
                  <span className='text-12px text-t-secondary truncate flex-1 min-w-0'>{row.reqTitle}</span>
                  <Tooltip content={t('ide.spec.trace.tasks', { count: row.taskIds.length })}>
                    <span className='inline-flex items-center gap-3px text-11px text-t-tertiary shrink-0'>
                      <Search theme='outline' size={12} />
                      {row.taskIds.length}
                    </span>
                  </Tooltip>
                  {row.hasDoneTask ? (
                    <Tag size='small' color='green'>
                      {t('ide.spec.trace.done')}
                    </Tag>
                  ) : (
                    <Tag size='small' color='gray'>
                      {t('ide.spec.trace.todo')}
                    </Tag>
                  )}
                  {row.verified ? (
                    <Tooltip content={t('ide.spec.trace.verified')}>
                      <CheckOne theme='filled' size={14} className='text-success-6 shrink-0' />
                    </Tooltip>
                  ) : (
                    <Tooltip content={t('ide.spec.trace.unverified')}>
                      <CloseOne theme='outline' size={14} className='text-t-tertiary shrink-0' />
                    </Tooltip>
                  )}
                </div>
              ))}
            </div>
          )}
        </SectionCard>

        {/* Phase gates. */}
        <SectionCard
          title={t('ide.spec.section.phases')}
          extra={
            gates.hasDefinitionOfDone ? (
              <Tag size='small' color='green'>
                {t('ide.spec.dodPresent')}
              </Tag>
            ) : (
              <Tag size='small' color='orange'>
                {t('ide.spec.dodMissing')}
              </Tag>
            )
          }
        >
          {gates.phases.length === 0 ? (
            <span className='text-12px text-t-tertiary'>{t('ide.spec.emptyPhases')}</span>
          ) : (
            gates.phases.map((phase) => {
              const active = phase.index === gates.activePhaseIndex;
              return (
                <div
                  key={phase.index}
                  className={`flex items-center gap-8px py-7px px-10px rounded-8px ${active ? 'bg-primary-light-1 border border-primary-6' : 'bg-fill-1 border border-border-1'}`}
                >
                  {phase.gateOpen ? (
                    <CheckOne theme='filled' size={15} className='text-success-6 shrink-0' />
                  ) : (
                    <RightOne theme='filled' size={15} className='text-primary-6 shrink-0' />
                  )}
                  <span className='text-12px font-600 text-t-primary truncate flex-1 min-w-0'>{phase.title}</span>
                  {phase.hasCheckpoint ? (
                    <Tag size='small' color='purple'>
                      {t('ide.spec.checkpoint')}
                    </Tag>
                  ) : null}
                  <span className='text-11px text-t-tertiary shrink-0'>
                    {t('ide.spec.tasksDone', { done: phase.counts.done, total: phase.counts.total })}
                  </span>
                </div>
              );
            })
          )}
        </SectionCard>

        {/* Diagnostics. */}
        {analysis.diagnostics.length > 0 ? (
          <SectionCard
            title={t('ide.spec.section.diagnostics')}
            extra={
              <span className='text-11px text-t-tertiary'>
                {t('ide.spec.diagCount', {
                  errors: grouped.errors.length,
                  warnings: grouped.warnings.length,
                })}
              </span>
            }
          >
            {analysis.diagnostics.map((d, i) => (
              <div key={`${d.code}-${i}`} className='flex items-start gap-7px'>
                <SeverityIcon severity={d.severity} />
                <div className='flex flex-col min-w-0'>
                  <span className='text-12px text-t-secondary leading-snug'>{d.message}</span>
                  <span className='text-10px text-t-tertiary font-mono'>
                    {d.code}
                    {d.refId ? ` · ${d.refId}` : ''}
                    {d.line ? ` · L${d.line}` : ''}
                  </span>
                </div>
              </div>
            ))}
          </SectionCard>
        ) : (
          <div className='flex items-center gap-8px px-14px py-12px rounded-12px bg-success-light-1 border border-success-3'>
            <CheckOne theme='filled' size={16} className='text-success-6' />
            <span className='text-13px text-success-6 font-600'>{t('ide.spec.allClear')}</span>
          </div>
        )}
      </div>
    </div>
  );
};

export default React.memo(SpecManagerPanel);

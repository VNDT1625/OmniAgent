import { Button, Message, Modal, Tabs, Tag } from '@arco-design/web-react';
import { Delete, Down, Export, Flask, NetworkTree, Refresh, Up } from '@icon-park/react';
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

import { ideClient } from '../../ideClient';
import type {
  ApiMockRule,
  EnvironmentSnapshot,
  MockRuleState,
  ObservabilityResult,
  QuickTestAssetState,
  ReliabilityResult,
  RepeatReplayResult,
  RetentionCleanupPlan,
} from '../../ideClient';

type Props = {
  visible: boolean;
  rootPath: string | null;
  tabId: string | null;
  assets: QuickTestAssetState | null;
  onClose: () => void;
  onAssetsChange: (assets: QuickTestAssetState) => void;
};

const POLICY = {
  categories: {
    run: { maxAgeMs: 2_592_000_000, maxCount: 50, maxBytes: 67_108_864 },
    baseline: { maxAgeMs: 7_776_000_000, maxCount: 30, maxBytes: 268_435_456 },
    media: { maxAgeMs: 604_800_000, maxCount: 50, maxBytes: 536_870_912 },
    report: { maxAgeMs: 2_592_000_000, maxCount: 50, maxBytes: 67_108_864 },
  },
  totalMaxBytes: 805_306_368,
} as const;

const showError = (result: { ok: boolean; error?: string } | null): void => {
  if (result && !result.ok) Message.error(result.error ?? '');
};
const Metric: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className='rd-8px bg-fill-2 p-10px'>
    <div className='text-10px text-t-tertiary'>{label}</div>
    <div className='mt-2px text-15px font-600 text-t-primary'>{value}</div>
  </div>
);
const ratingColor = (rating: string): 'green' | 'orange' | 'red' | 'gray' =>
  rating === 'good' ? 'green' : rating === 'needs-improvement' ? 'orange' : rating === 'poor' ? 'red' : 'gray';

const QuickTestInsightsModal: React.FC<Props> = ({ visible, rootPath, tabId, assets, onClose, onAssetsChange }) => {
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [observability, setObservability] = useState<ObservabilityResult | null>(null);
  const [reliability, setReliability] = useState<ReliabilityResult | null>(null);
  const [environment, setEnvironment] = useState<EnvironmentSnapshot | null>(null);
  const [mocks, setMocks] = useState<MockRuleState>({ version: 1, rules: [] });
  const [repeatResult, setRepeatResult] = useState<RepeatReplayResult | null>(null);
  const [cleanup, setCleanup] = useState<RetentionCleanupPlan | null>(null);

  const reload = useCallback(async (): Promise<void> => {
    if (!rootPath) return;
    setBusy('refresh');
    const results = await Promise.all([
      ideClient.qtInsightsObservability({ rootPath, source: tabId ? 'tab' : 'latest-run', tabId: tabId ?? undefined }),
      ideClient.qtInsightsReliability({ rootPath }),
      ideClient.qtInsightsEnvironment({ rootPath }),
      ideClient.qtInsightsListMocks({ rootPath }),
    ]).catch((): null => null);
    setBusy(null);
    if (!results) return;
    const [observed, reliable, snapshot, mockState] = results;
    if (observed.ok) setObservability(observed.data);
    else showError(observed);
    if (reliable.ok) setReliability(reliable.data);
    else showError(reliable);
    if (snapshot.ok) setEnvironment(snapshot.data);
    else showError(snapshot);
    if (mockState.ok) setMocks(mockState.data);
    else showError(mockState);
  }, [rootPath, tabId]);

  useEffect(() => {
    if (visible) void reload();
  }, [visible, reload]);

  const repeat = async (scenarioId: string): Promise<void> => {
    if (!rootPath) return;
    setBusy('repeat:' + scenarioId);
    const result = await ideClient
      .qtInsightsRepeatReplay({ rootPath, scenarioId, tabId: tabId ?? undefined, repetitions: 3, useMocks: true })
      .catch((): null => null);
    setBusy(null);
    if (result?.ok) setRepeatResult(result.data);
    else showError(result && !result.ok ? result : null);
  };

  const addMock = async (): Promise<void> => {
    const request = observability?.network.requests[0];
    if (!rootPath || !request) return;
    const rule: ApiMockRule = {
      id: 'mock-' + Date.now(),
      enabled: true,
      match: { method: request.method, url: { kind: 'exact', value: request.url } },
      response: { status: 200, headers: { 'content-type': 'application/json' }, body: '{}' },
    };
    setBusy('mock');
    const result = await ideClient.qtInsightsSaveMock({ rootPath, rule }).catch((): null => null);
    setBusy(null);
    if (result?.ok) setMocks((current) => ({ version: 1, rules: [result.data, ...current.rules] }));
    else showError(result && !result.ok ? result : null);
  };

  const removeMock = async (ruleId: string): Promise<void> => {
    if (!rootPath) return;
    const result = await ideClient.qtInsightsRemoveMock({ rootPath, ruleId }).catch((): null => null);
    if (result?.ok) setMocks((current) => ({ ...current, rules: current.rules.filter((rule) => rule.id !== ruleId) }));
    else showError(result && !result.ok ? result : null);
  };

  const exportReport = async (): Promise<void> => {
    const run = assets?.runs[0];
    if (!rootPath || !run) return;
    setBusy('export');
    const result = await ideClient.qtInsightsExportReport({ rootPath, runId: run.id }).catch((): null => null);
    setBusy(null);
    if (result?.ok) Message.success(t('ide.quicktest.reportExported') + ': ' + result.data.markdownPath);
    else showError(result && !result.ok ? result : null);
  };

  const cleanupData = async (apply: boolean): Promise<void> => {
    if (!rootPath) return;
    setBusy(apply ? 'cleanup-apply' : 'cleanup-preview');
    const result = apply
      ? await ideClient.qtInsightsApplyCleanup({ rootPath, policy: POLICY }).catch((): null => null)
      : await ideClient.qtInsightsPreviewCleanup({ rootPath, policy: POLICY }).catch((): null => null);
    setBusy(null);
    if (result?.ok) {
      setCleanup(result.data);
      if (apply) {
        const refreshed = await ideClient.qtAssetsList(rootPath);
        if (refreshed.ok) onAssetsChange(refreshed.data);
      }
    } else showError(result && !result.ok ? result : null);
  };

  const editStep = async (scenarioId: string, stepId: string, action: 'up' | 'down' | 'delete'): Promise<void> => {
    if (!rootPath || !assets) return;
    const scenario = assets.scenarios.find((item) => item.id === scenarioId);
    const index = scenario?.steps.findIndex((step) => step.id === stepId) ?? -1;
    if (!scenario || index < 0) return;
    const operations =
      action === 'delete'
        ? [{ type: 'delete' as const, stepId }]
        : [{ type: 'reorder' as const, stepId, toIndex: action === 'up' ? index - 1 : index + 1 }];
    setBusy('edit:' + stepId);
    const result = await ideClient.qtInsightsEditScenario({ rootPath, scenarioId, operations }).catch((): null => null);
    setBusy(null);
    if (result?.ok) {
      onAssetsChange({
        ...assets,
        scenarios: assets.scenarios.map((item) => (item.id === scenarioId ? result.data.replayScenario : item)),
      });
      Message.success(t('ide.quicktest.scenarioUpdated'));
    } else showError(result && !result.ok ? result : null);
  };

  const summary = repeatResult?.summary ?? reliability?.summary;
  const clusters = repeatResult?.clusters ?? reliability?.clusters ?? [];
  const metrics = observability?.performance.metrics;
  return (
    <Modal
      visible={visible}
      title={t('ide.quicktest.insightsTitle')}
      onCancel={onClose}
      autoFocus={false}
      focusLock
      style={{ width: 940 }}
      footer={
        <div className='flex justify-end gap-8px'>
          <Button icon={<Refresh theme='outline' />} loading={busy === 'refresh'} onClick={() => void reload()}>
            {t('ide.quicktest.refreshInsights')}
          </Button>
          <Button type='primary' onClick={onClose}>
            {t('common.close')}
          </Button>
        </div>
      }
    >
      <Tabs defaultActiveTab='observability'>
        <Tabs.TabPane key='observability' title={t('ide.quicktest.observability')}>
          <div className='max-h-480px overflow-y-auto flex flex-col gap-12px'>
            <div className='grid grid-cols-4 gap-8px'>
              <Metric
                label={t('ide.quicktest.networkRequests')}
                value={observability?.network.summary.keptCount ?? 0}
              />
              <Metric
                label={t('ide.quicktest.failedRequests')}
                value={observability?.network.summary.failedCount ?? 0}
              />
              <Metric
                label={t('ide.quicktest.transferredBytes')}
                value={observability?.network.summary.transferredBytes ?? 0}
              />
              <Metric
                label={t('ide.quicktest.slowestRequest')}
                value={observability?.network.summary.slowestRequestId ?? '?'}
              />
            </div>
            <div className='grid grid-cols-5 gap-8px'>
              {metrics
                ? [
                    [t('ide.quicktest.metricFcp'), metrics.fcpMs],
                    [t('ide.quicktest.metricLcp'), metrics.lcpMs],
                    [t('ide.quicktest.metricCls'), metrics.cls],
                    [t('ide.quicktest.metricInp'), metrics.inpMs],
                    [t('ide.quicktest.metricTbt'), metrics.totalBlockingTimeMs],
                  ].map(([label, item]) => {
                    const metric = item as typeof metrics.fcpMs;
                    return (
                      <div key={String(label)} className='rd-8px bg-fill-2 p-10px'>
                        <div className='text-10px text-t-tertiary'>{String(label)}</div>
                        <Tag color={ratingColor(metric.rating)}>{metric.value ?? '?'}</Tag>
                      </div>
                    );
                  })
                : null}
            </div>
            {(observability?.network.requests ?? []).slice(0, 30).map((request) => (
              <div key={request.id} className='flex items-center gap-8px rd-8px border border-arco-2 p-10px'>
                <Tag color={(request.status ?? 0) >= 400 ? 'red' : 'blue'}>{request.method}</Tag>
                <code className='min-w-0 flex-1 truncate text-11px text-t-primary'>{request.url}</code>
                <span className='text-11px text-t-secondary'>
                  {request.status ?? '?'} ? {request.timing.durationMs ?? 0}ms
                </span>
              </div>
            ))}
          </div>
        </Tabs.TabPane>
        <Tabs.TabPane key='reliability' title={t('ide.quicktest.reliability')}>
          <div className='max-h-480px overflow-y-auto flex flex-col gap-12px'>
            <div className='grid grid-cols-3 gap-8px'>
              <Metric label={t('ide.quicktest.classification')} value={summary?.classification ?? '?'} />
              <Metric label={t('ide.quicktest.passRate')} value={Math.round(100 * (summary?.passRate ?? 0)) + '%'} />
              <Metric label={t('ide.quicktest.transitions')} value={summary?.transitionCount ?? 0} />
            </div>
            {(assets?.scenarios ?? []).map((scenario) => (
              <div key={scenario.id} className='flex items-center gap-8px rd-8px border border-arco-2 p-10px'>
                <Flask theme='outline' className='text-primary' />
                <span className='min-w-0 flex-1 truncate text-12px font-600'>{scenario.name}</span>
                <Button
                  size='small'
                  loading={busy === 'repeat:' + scenario.id}
                  onClick={() => void repeat(scenario.id)}
                >
                  {t('ide.quicktest.repeatThreeTimes')}
                </Button>
              </div>
            ))}
            <div className='text-12px font-600 text-t-primary'>{t('ide.quicktest.errorClusters')}</div>
            {clusters.map((cluster) => (
              <div key={cluster.fingerprint} className='rd-8px bg-fill-2 p-10px'>
                <div className='text-12px text-t-primary'>{cluster.normalizedMessage}</div>
                <div className='text-10px text-t-tertiary'>
                  {cluster.affectedRunCount} / {cluster.occurrenceCount}
                </div>
              </div>
            ))}
          </div>
        </Tabs.TabPane>
        <Tabs.TabPane key='workflow' title={t('ide.quicktest.workflowTools')}>
          <div className='max-h-480px overflow-y-auto flex flex-col gap-12px'>
            <div className='grid grid-cols-4 gap-8px'>
              <Metric label={t('ide.quicktest.gitState')} value={environment?.git?.branch ?? '?'} />
              <Metric label={t('ide.quicktest.dependencies')} value={environment?.dependencies.length ?? 0} />
              <Metric label={t('ide.quicktest.services')} value={environment?.services.length ?? 0} />
              <Metric label={t('ide.quicktest.ports')} value={environment?.ports.length ?? 0} />
            </div>
            <div className='flex flex-wrap items-center gap-8px'>
              <Button
                icon={<NetworkTree theme='outline' />}
                loading={busy === 'mock'}
                disabled={!observability?.network.requests.length}
                onClick={() => void addMock()}
              >
                {t('ide.quicktest.addMockFromRequest')}
              </Button>
              <Button
                icon={<Export theme='outline' />}
                loading={busy === 'export'}
                disabled={!assets?.runs.length}
                onClick={() => void exportReport()}
              >
                {t('ide.quicktest.exportReport')}
              </Button>
              <Button loading={busy === 'cleanup-preview'} onClick={() => void cleanupData(false)}>
                {t('ide.quicktest.previewCleanup')}
              </Button>
              <Button
                status='danger'
                loading={busy === 'cleanup-apply'}
                disabled={!cleanup?.delete.length}
                onClick={() => void cleanupData(true)}
              >
                {t('ide.quicktest.applyCleanup')}
              </Button>
            </div>
            {cleanup ? (
              <div className='rd-8px bg-fill-2 p-10px text-12px'>
                {t('ide.quicktest.cleanupPreview')}: {cleanup.delete.length} ? {t('ide.quicktest.reclaimedBytes')}:{' '}
                {cleanup.reclaimedBytes}
              </div>
            ) : null}
            <div className='text-12px font-600 text-t-primary'>{t('ide.quicktest.apiMocks')}</div>
            {mocks.rules.map((rule) => (
              <div key={rule.id} className='flex items-center gap-8px rd-8px border border-arco-2 p-10px'>
                <code className='min-w-0 flex-1 truncate text-11px'>
                  {rule.match.method ?? '*'} {rule.match.url.value}
                </code>
                <Button
                  size='mini'
                  status='danger'
                  icon={<Delete theme='outline' />}
                  onClick={() => void removeMock(rule.id)}
                >
                  {t('ide.quicktest.removeMock')}
                </Button>
              </div>
            ))}
          </div>
        </Tabs.TabPane>
        <Tabs.TabPane key='editor' title={t('ide.quicktest.editScenario')}>
          <div className='max-h-480px overflow-y-auto flex flex-col gap-12px'>
            {(assets?.scenarios ?? []).map((scenario) => (
              <div key={scenario.id} className='rd-8px border border-arco-2 p-10px flex flex-col gap-6px'>
                <div className='text-12px font-600 text-t-primary'>{scenario.name}</div>
                {scenario.steps.map((step, index) => (
                  <div key={step.id} className='flex items-center gap-6px rd-6px bg-fill-2 px-8px py-6px'>
                    <span className='w-22px text-10px text-t-tertiary'>{index + 1}</span>
                    <code className='min-w-0 flex-1 truncate text-11px'>
                      {step.kind === 'navigate' ? step.url : step.selector}
                    </code>
                    <Button
                      size='mini'
                      icon={<Up theme='outline' />}
                      disabled={index === 0}
                      loading={busy === 'edit:' + step.id}
                      onClick={() => void editStep(scenario.id, step.id, 'up')}
                    />
                    <Button
                      size='mini'
                      icon={<Down theme='outline' />}
                      disabled={index === scenario.steps.length - 1}
                      onClick={() => void editStep(scenario.id, step.id, 'down')}
                    />
                    <Button
                      size='mini'
                      status='danger'
                      icon={<Delete theme='outline' />}
                      onClick={() => void editStep(scenario.id, step.id, 'delete')}
                    />
                  </div>
                ))}
              </div>
            ))}
          </div>
        </Tabs.TabPane>
      </Tabs>
    </Modal>
  );
};

export default QuickTestInsightsModal;

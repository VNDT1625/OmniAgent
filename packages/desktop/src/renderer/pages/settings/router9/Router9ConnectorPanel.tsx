/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * "Distribute via 9Router" panel for Settings › Model.
 *
 * Lets the user point an external CLI / IDE tool (Kiro, Antigravity, Claude
 * Code, Codex, Cursor, Cline, OpenClaw...) at their local 9Router endpoint and
 * shows the exact configuration that tool needs — env vars, config-file
 * content, or copy-paste fields ("auto convert to the format the app needs").
 *
 * Renderer-only and side-effect-free: it computes plans with the pure
 * `common/router9` engine and copies to the clipboard. Writing config files on
 * disk is intentionally deferred to a Main-process applier (a higher-risk step).
 */

import { Button, Collapse, Input, Message, Tag, Tooltip } from '@arco-design/web-react';
import { Copy, LinkCloud, Components, CheckOne } from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import AionSelect from '@/renderer/components/base/AionSelect';
import { buildConnectorPlan, CONNECTOR_TARGETS, type ConnectorPlan } from '@/common/router9';
import { router9Client, type ApplyResult } from './router9BridgeClient';

const DEFAULT_BASE_URL = 'http://127.0.0.1:20128/v1';

/** Color a target's mechanism badge so the user can tell apply-modes apart. */
const mechanismColor = (mechanism: string): string => {
  switch (mechanism) {
    case 'env':
      return 'arcoblue';
    case 'configFile':
      return 'orange';
    case 'manual':
    default:
      return 'gray';
  }
};

const Router9ConnectorPanel: React.FC = () => {
  const { t } = useTranslation();
  const [targetId, setTargetId] = useState<string>(CONNECTOR_TARGETS[0]?.id ?? 'kiro');
  const [baseUrl, setBaseUrl] = useState<string>(DEFAULT_BASE_URL);
  const [apiKey, setApiKey] = useState<string>('');
  const [model, setModel] = useState<string>('');

  const target = useMemo(() => CONNECTOR_TARGETS.find((tg) => tg.id === targetId), [targetId]);

  // Compute the plan only when we have usable credentials; the engine throws
  // otherwise, so guard before calling it.
  const plan = useMemo<ConnectorPlan | null>(() => {
    if (!baseUrl.trim() || !apiKey.trim()) return null;
    try {
      return buildConnectorPlan(targetId, { baseUrl, apiKey, model: model.trim() || undefined });
    } catch {
      return null;
    }
  }, [targetId, baseUrl, apiKey, model]);

  const copy = (text: string) => {
    navigator.clipboard
      .writeText(text)
      .then(() => Message.success(t('settings.router9.copied')))
      .catch(() => Message.error(t('common.failed')));
  };

  // Apply state: only meaningful for non-manual targets (env / configFile).
  const [applying, setApplying] = useState(false);
  const [applied, setApplied] = useState<ApplyResult | null>(null);
  const canApply = !!plan && !!target && target.mechanism !== 'manual';

  // Clear a stale apply result whenever the target or credentials change.
  useEffect(() => {
    setApplied(null);
  }, [targetId, baseUrl, apiKey, model]);

  const apply = () => {
    if (!plan || !canApply) return;
    setApplying(true);
    setApplied(null);
    router9Client
      .applyPlan(targetId, { baseUrl, apiKey, model: model.trim() || undefined })
      .then((res) => {
        if (res.ok) {
          setApplied(res.data);
          Message.success(t('settings.router9.applied'));
          return;
        }
        // `'error' in res` narrows reliably where the discriminant alone does not.
        const errMsg = 'error' in res ? res.error : 'unknown';
        Message.error(t('settings.router9.applyFailed', { error: errMsg }));
      })
      .catch((error: unknown) => {
        Message.error(
          t('settings.router9.applyFailed', { error: error instanceof Error ? error.message : String(error) })
        );
      })
      .finally(() => setApplying(false));
  };

  const envBlock = useMemo(() => {
    if (!plan || plan.env.length === 0) return '';
    return plan.env.map((e) => `export ${e.key}="${e.value}"`).join('\n');
  }, [plan]);

  return (
    <Collapse bordered={false} className='mt-16px [&_.arco-collapse-item-content-box]:!px-0'>
      <Collapse.Item
        name='router9'
        header={
          <div className='flex items-center gap-8px'>
            <Components theme='outline' size='18' className='text-[rgb(var(--primary-6))]' />
            <span className='text-14px font-600 text-t-primary'>{t('settings.router9.title')}</span>
          </div>
        }
      >
        <div className='flex flex-col gap-14px'>
          <p className='text-12px leading-5 text-t-secondary m-0'>{t('settings.router9.subtitle')}</p>

          {/* Endpoint + target inputs */}
          <div className='grid grid-cols-1 md:grid-cols-2 gap-12px'>
            <label className='flex flex-col gap-4px'>
              <span className='text-12px text-t-secondary'>{t('settings.router9.targetLabel')}</span>
              <AionSelect value={targetId} onChange={setTargetId}>
                {CONNECTOR_TARGETS.map((tg) => (
                  <AionSelect.Option key={tg.id} value={tg.id}>
                    {tg.label}
                  </AionSelect.Option>
                ))}
              </AionSelect>
            </label>
            <label className='flex flex-col gap-4px'>
              <span className='text-12px text-t-secondary'>{t('settings.router9.endpointLabel')}</span>
              <Input value={baseUrl} onChange={setBaseUrl} prefix={<LinkCloud theme='outline' size='14' />} />
            </label>
            <label className='flex flex-col gap-4px'>
              <span className='text-12px text-t-secondary'>{t('settings.router9.apiKeyLabel')}</span>
              <Input.Password value={apiKey} onChange={setApiKey} placeholder='sk_...' />
            </label>
            <label className='flex flex-col gap-4px'>
              <span className='text-12px text-t-secondary'>{t('settings.router9.modelLabel')}</span>
              <Input value={model} onChange={setModel} placeholder={t('settings.router9.modelPlaceholder')} />
            </label>
          </div>

          {/* Target description + mechanism badge */}
          {target && (
            <div className='flex items-start gap-8px'>
              <Tag size='small' color={mechanismColor(target.mechanism)} className='shrink-0'>
                {t(`settings.router9.mechanism.${target.mechanism}`)}
              </Tag>
              <span className='text-12px leading-5 text-t-secondary'>{t(target.descriptionKey)}</span>
            </div>
          )}

          {!plan ? (
            <div
              className='rd-8px px-12px py-8px text-12px leading-5 border border-solid'
              style={{
                borderColor: 'rgba(var(--primary-6),0.32)',
                backgroundColor: 'rgba(var(--primary-6),0.08)',
                color: 'rgb(var(--primary-6))',
              }}
            >
              {t('settings.router9.needCreds')}
            </div>
          ) : (
            <div className='flex flex-col gap-12px'>
              {/* Copy-paste connection fields (always present) */}
              <Section title={t('settings.router9.fieldsTitle')}>
                <div className='flex flex-col gap-6px'>
                  {plan.fields.map((f) => (
                    <div key={f.key} className='flex items-center gap-8px'>
                      <span className='text-12px text-t-secondary w-72px shrink-0'>{f.key}</span>
                      <code className='flex-1 min-w-0 truncate text-12px text-t-primary bg-[var(--fill-1)] rd-6px px-8px py-4px'>
                        {f.value}
                      </code>
                      <CopyButton label={t('settings.router9.copy')} onClick={() => copy(f.value)} />
                    </div>
                  ))}
                </div>
              </Section>

              {/* Environment variables (env-mechanism targets) */}
              {envBlock && (
                <Section
                  title={t('settings.router9.envTitle')}
                  onCopy={() => copy(envBlock)}
                  copyLabel={t('settings.router9.copy')}
                >
                  <pre className='m-0 text-12px text-t-primary bg-[var(--fill-1)] rd-6px px-10px py-8px overflow-x-auto whitespace-pre'>
                    {envBlock}
                  </pre>
                </Section>
              )}

              {/* Config files (configFile-mechanism targets) */}
              {plan.files.map((file) => (
                <Section
                  key={file.path}
                  title={`${t('settings.router9.fileTitle')} · ${file.path}`}
                  onCopy={() => copy(file.content)}
                  copyLabel={t('settings.router9.copy')}
                >
                  <pre className='m-0 text-12px text-t-primary bg-[var(--fill-1)] rd-6px px-10px py-8px overflow-x-auto whitespace-pre'>
                    {file.content}
                  </pre>
                </Section>
              ))}

              {/* One-click apply — writes config files to disk (with backup).
                  Manual targets have no auto-apply, so the button is hidden. */}
              {canApply && (
                <div className='flex flex-col gap-8px'>
                  <div className='flex items-center gap-10px'>
                    <Button
                      type='primary'
                      loading={applying}
                      icon={<CheckOne theme='outline' size='14' />}
                      onClick={apply}
                    >
                      {t('settings.router9.apply')}
                    </Button>
                    <span className='text-12px text-t-secondary'>{t('settings.router9.applyHint')}</span>
                  </div>

                  {applied && (
                    <div
                      className='rd-8px px-12px py-8px text-12px leading-5 border border-solid flex flex-col gap-4px'
                      style={{
                        borderColor: 'rgba(var(--success-6),0.32)',
                        backgroundColor: 'rgba(var(--success-6),0.08)',
                      }}
                    >
                      {applied.files.map((f) => (
                        <div key={f.path} className='text-t-primary'>
                          <span className='text-[rgb(var(--success-6))]'>
                            {f.status === 'written'
                              ? t('settings.router9.fileWritten')
                              : t('settings.router9.fileSkipped')}
                          </span>
                          {' · '}
                          <code className='text-t-secondary'>{f.path}</code>
                          {f.backupPath && (
                            <span className='text-t-tertiary'> ({t('settings.router9.backupSaved')})</span>
                          )}
                        </div>
                      ))}
                      {applied.notes.length > 0 && (
                        <div className='text-t-secondary'>
                          {t('settings.router9.envNote')}
                          <pre className='m-0 mt-4px text-12px text-t-primary bg-[var(--fill-1)] rd-6px px-8px py-6px overflow-x-auto whitespace-pre'>
                            {applied.notes.join('\n')}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </Collapse.Item>
    </Collapse>
  );
};

/** A titled block with an optional inline copy action in its header. */
const Section: React.FC<{
  title: string;
  copyLabel?: string;
  onCopy?: () => void;
  children: React.ReactNode;
}> = ({ title, copyLabel, onCopy, children }) => (
  <div className='flex flex-col gap-6px'>
    <div className='flex items-center justify-between'>
      <span className='text-12px font-500 text-t-secondary'>{title}</span>
      {onCopy && copyLabel && <CopyButton label={copyLabel} onClick={onCopy} />}
    </div>
    {children}
  </div>
);

const CopyButton: React.FC<{ label: string; onClick: () => void }> = ({ label, onClick }) => (
  <Tooltip content={label}>
    <Button
      size='mini'
      className='!w-26px !h-26px !min-w-26px text-t-secondary hover:text-t-primary'
      icon={<Copy theme='outline' size='14' />}
      onClick={onClick}
    />
  </Tooltip>
);

export default Router9ConnectorPanel;

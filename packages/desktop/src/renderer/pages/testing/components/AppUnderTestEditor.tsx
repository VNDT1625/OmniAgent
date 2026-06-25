/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `AppUnderTestEditor` — declares how to start the web app under test, including
 * any prerequisite services (Yêu cầu 2b — UX). Answers two user needs:
 *
 *  1. "Just point it at my source and let it figure out how to run it" — the
 *     "Detect from source" button picks a folder and asks the model to propose
 *     the whole setup (services + app command + url), filling this form.
 *  2. "Real tests need a backend, sometimes several services" — a dynamic list
 *     of extra commands (backend, db, workers) each with a readiness check, run
 *     in order before the app and torn down after.
 *
 * Controlled component: the parent owns the {@link AppUnderTest} value. Arco +
 * @icon-park/react + UnoCSS tokens only.
 */

import { ipcBridge } from '@/common';
import { Button, Input, InputNumber, Message, Select } from '@arco-design/web-react';
import { Delete, FolderOpen, MagicWand, Plus } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AppUnderTest, DetectAppRequest, ServiceReadiness, ServiceSpec } from '../testingBridgeClient';

/** Props for {@link AppUnderTestEditor}. */
export type AppUnderTestEditorProps = {
  /** The current app-under-test value (undefined = not declared). */
  value: AppUnderTest | undefined;
  /** Replace the value. */
  onChange: (next: AppUnderTest) => void;
  /** Ask the model to read a project folder and propose the setup. */
  onDetect: (request: DetectAppRequest) => Promise<AppUnderTest>;
  /** Preferred model id for detection (empty/undefined = backend auto-pick). */
  model?: string;
  /** Disable the whole editor (during a run/generation). */
  disabled?: boolean;
};

/** Readiness kinds offered in the per-service selector. */
const READY_TYPES: ServiceReadiness['type'][] = ['url', 'port', 'log', 'delay'];

/** Build a readiness object of the given kind with sensible empty defaults. */
const emptyReady = (type: ServiceReadiness['type']): ServiceReadiness => {
  if (type === 'url') return { type: 'url', url: '' };
  if (type === 'port') return { type: 'port', port: 0 };
  if (type === 'log') return { type: 'log', match: '' };
  return { type: 'delay', ms: 1000 };
};

/**
 * The app-under-test form: a detect-from-source action, the main app fields, and
 * an editable list of prerequisite services.
 */
const AppUnderTestEditor: React.FC<AppUnderTestEditorProps> = ({ value, onChange, onDetect, model, disabled }) => {
  const { t } = useTranslation();
  const [detecting, setDetecting] = useState(false);

  const app: AppUnderTest = value ?? { url: '', command: '', cwd: '', services: [] };
  const services = app.services ?? [];

  const patch = (next: Partial<AppUnderTest>): void => onChange({ ...app, ...next });
  const patchServices = (next: ServiceSpec[]): void => patch({ services: next });

  const pickFolder = async (): Promise<string | undefined> => {
    const dirs = await ipcBridge.dialog.showOpen
      .invoke({ properties: ['openDirectory'] })
      .catch((): undefined => undefined);
    return dirs && dirs[0] ? dirs[0] : undefined;
  };

  const detect = (): void => {
    if (detecting || disabled) return;
    void pickFolder().then((dir) => {
      if (!dir) return;
      setDetecting(true);
      onDetect({ projectDir: dir, model })
        .then((proposed) => {
          onChange(proposed);
          Message.success(t('testing.form.detected'));
        })
        .catch((error: unknown) =>
          Message.error(error instanceof Error ? error.message : t('testing.form.detectFailed'))
        )
        .finally(() => setDetecting(false));
    });
  };

  const pickServiceCwd = (index: number): void => {
    void pickFolder().then((dir) => {
      if (!dir) return;
      patchServices(services.map((s, i) => (i === index ? { ...s, cwd: dir } : s)));
    });
  };

  const addService = (): void => patchServices([...services, { command: '', ready: { type: 'port', port: 0 } }]);
  const removeService = (index: number): void => patchServices(services.filter((_, i) => i !== index));
  const updateService = (index: number, next: Partial<ServiceSpec>): void =>
    patchServices(services.map((s, i) => (i === index ? { ...s, ...next } : s)));

  return (
    <div className='flex flex-col gap-6px rd-6px bg-fill-1 p-8px'>
      <div className='flex items-center justify-between'>
        <span className='text-12px font-500 text-t-secondary'>{t('testing.form.appSection')}</span>
        <Button
          size='mini'
          type='text'
          loading={detecting}
          disabled={disabled}
          icon={<MagicWand theme='outline' size='13' />}
          onClick={detect}
        >
          {t('testing.form.detect')}
        </Button>
      </div>

      <Input
        value={app.url}
        onChange={(v) => patch({ url: v })}
        placeholder={t('testing.form.appUrlPlaceholder')}
        disabled={disabled}
      />
      <Input
        value={app.command ?? ''}
        onChange={(v) => patch({ command: v })}
        placeholder={t('testing.form.appCommandPlaceholder')}
        disabled={disabled}
      />
      <div className='flex items-center gap-6px'>
        <Input
          value={app.cwd ?? ''}
          onChange={(v) => patch({ cwd: v })}
          placeholder={t('testing.form.appCwdPlaceholder')}
          disabled={disabled}
          className='flex-1'
        />
        <Button
          size='small'
          icon={<FolderOpen theme='outline' size='14' />}
          onClick={() => void pickFolder().then((d) => d && patch({ cwd: d }))}
          disabled={disabled}
        >
          {t('testing.form.appBrowse')}
        </Button>
      </div>

      {/* Prerequisite services (backend, db, workers), started in order first. */}
      <div className='flex items-center justify-between mt-2px'>
        <span className='text-12px font-500 text-t-secondary'>{t('testing.form.servicesSection')}</span>
        <Button
          size='mini'
          type='text'
          icon={<Plus theme='outline' size='13' />}
          onClick={addService}
          disabled={disabled}
        >
          {t('testing.form.addService')}
        </Button>
      </div>

      {services.length === 0 ? (
        <span className='text-11px text-t-tertiary'>{t('testing.form.servicesHint')}</span>
      ) : (
        services.map((service, index) => (
          <div key={index} className='flex flex-col gap-4px rd-4px border border-border-base p-6px'>
            <div className='flex items-center gap-6px'>
              <Input
                value={service.name ?? ''}
                onChange={(v) => updateService(index, { name: v })}
                placeholder={t('testing.form.serviceName')}
                disabled={disabled}
                className='w-110px'
              />
              <Input
                value={service.command}
                onChange={(v) => updateService(index, { command: v })}
                placeholder={t('testing.form.serviceCommand')}
                disabled={disabled}
                className='flex-1'
              />
              <Button
                size='small'
                status='danger'
                type='text'
                icon={<Delete theme='outline' size='14' />}
                onClick={() => removeService(index)}
                disabled={disabled}
              />
            </div>
            <div className='flex items-center gap-6px'>
              <Select
                value={service.ready?.type ?? 'port'}
                onChange={(v) => updateService(index, { ready: emptyReady(v as ServiceReadiness['type']) })}
                disabled={disabled}
                className='w-100px'
              >
                {READY_TYPES.map((type) => (
                  <Select.Option key={type} value={type}>
                    {t(`testing.form.ready_${type}`)}
                  </Select.Option>
                ))}
              </Select>
              {service.ready?.type === 'url' ? (
                <Input
                  value={service.ready.url}
                  onChange={(v) => updateService(index, { ready: { type: 'url', url: v } })}
                  placeholder='http://localhost:3000/health'
                  disabled={disabled}
                  className='flex-1'
                />
              ) : null}
              {service.ready?.type === 'port' ? (
                <InputNumber
                  value={service.ready.port}
                  onChange={(v) => updateService(index, { ready: { type: 'port', port: Number(v) || 0 } })}
                  placeholder='3000'
                  min={0}
                  disabled={disabled}
                  className='w-120px'
                />
              ) : null}
              {service.ready?.type === 'log' ? (
                <Input
                  value={service.ready.match}
                  onChange={(v) => updateService(index, { ready: { type: 'log', match: v } })}
                  placeholder={t('testing.form.serviceLogMatch')}
                  disabled={disabled}
                  className='flex-1'
                />
              ) : null}
              {service.ready?.type === 'delay' ? (
                <InputNumber
                  value={service.ready.ms}
                  onChange={(v) => updateService(index, { ready: { type: 'delay', ms: Number(v) || 0 } })}
                  placeholder='1000'
                  min={0}
                  step={500}
                  suffix='ms'
                  disabled={disabled}
                  className='w-120px'
                />
              ) : null}
            </div>
          </div>
        ))
      )}
    </div>
  );
};

export default AppUnderTestEditor;

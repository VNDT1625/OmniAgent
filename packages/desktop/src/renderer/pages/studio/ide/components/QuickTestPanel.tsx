/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `QuickTestPanel` — the IDE "Quick Test" mode UI.
 *
 * Lets the user test their app in the embedded browser while Omni silently
 * records the runtime trace (CDP: clicks, network, console, exceptions). When
 * the user stops, the panel shows:
 *   - A live event stream while recording (badge + scrolling log).
 *   - A trace summary after stopping: the error, the interaction path, and the
 *     suspected files (mapped from the trace to the code graph).
 *   - A "Fix with Agent" button that injects the trace context pack into a new
 *     IDE Chat tab so the agent knows exactly what broke and where.
 *
 * Platform note: CDP is only available for the web target (embedded browser).
 * For native targets (android/windows) the panel shows a hint to use the
 * Testing mode instead.
 *
 * Renderer-only; Arco + icon-park + UnoCSS tokens; all text via i18n.
 */

import { Button, Input, Select, Tag, Tooltip } from '@arco-design/web-react';
import { Bug, Caution, CheckOne, Close, Code, FileCode, Lightning, Pause, Play, Robot } from '@icon-park/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ideClient } from '../ideClient';
import type { ContextPack, QtStopResponse, RuntimeTrace, TraceEvent, TracePlatform } from '../ideClient';

type QuickTestPanelProps = {
  rootPath: string | null;
  /** Called when user clicks "Fix with Agent" — opens a new IDE Chat tab with the trace context. */
  onFixWithAgent: (contextPack: ContextPack, errorSummary: string) => void;
};

type QTStatus = 'idle' | 'recording' | 'done' | 'error';

const QuickTestPanel: React.FC<QuickTestPanelProps> = ({ rootPath, onFixWithAgent }) => {
  const { t } = useTranslation();
  const [status, setStatus] = useState<QTStatus>('idle');
  const [platform, setPlatform] = useState<TracePlatform>('web');
  const [target, setTarget] = useState('');
  const [expectedText, setExpectedText] = useState('');
  const [liveEvents, setLiveEvents] = useState<TraceEvent[]>([]);
  const [trace, setTrace] = useState<RuntimeTrace | null>(null);
  const [verification, setVerification] = useState<QtStopResponse['verification']>(null);
  const [contextPack, setContextPack] = useState<ContextPack | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Subscribe to live trace events while recording.
  useEffect(() => {
    if (status !== 'recording') return undefined;
    const unsub = ideClient.onQtEvent((event) => {
      if (!mountedRef.current) return;
      setLiveEvents((prev) => [...prev.slice(-49), event]);
    });
    return () => unsub();
  }, [status]);

  // Auto-scroll the live log.
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [liveEvents]);

  const handleStart = useCallback(async (): Promise<void> => {
    if (!rootPath) return;
    setLiveEvents([]);
    setTrace(null);
    setVerification(null);
    setContextPack(null);
    setErrorMsg(null);
    const result = await ideClient
      .qtStart(rootPath, platform, target.trim() || undefined, expectedText.trim() || undefined)
      .catch((): null => null);
    if (!mountedRef.current) return;
    if (!result?.ok) {
      setErrorMsg(!result ? t('ide.quicktest.startFailed') : (result as { ok: false; error: string }).error);
      setStatus('error');
      return;
    }
    if (!result.data) {
      // No observable target available (no browser tab / no device / no exe).
      setErrorMsg(
        platform === 'web'
          ? t('ide.quicktest.noBrowser')
          : platform === 'android'
            ? t('ide.quicktest.noDevice')
            : t('ide.quicktest.noApp')
      );
      setStatus('error');
      return;
    }
    setStatus('recording');
  }, [rootPath, platform, target, expectedText, t]);

  const handleStop = useCallback(async (): Promise<void> => {
    const result = await ideClient.qtStop().catch((): null => null);
    if (!mountedRef.current) return;
    if (!result?.ok) {
      setErrorMsg(!result ? t('ide.quicktest.stopFailed') : (result as { ok: false; error: string }).error);
      setStatus('error');
      return;
    }
    setTrace(result.data.trace);
    setVerification(result.data.verification);
    setContextPack(result.data.contextPack);
    setStatus('done');
  }, [t]);

  const handleFixWithAgent = useCallback((): void => {
    if (!contextPack) return;
    const errorSummary = trace?.firstError
      ? trace.firstError.kind === 'exception'
        ? trace.firstError.message.split('\n')[0]
        : trace.firstError.kind === 'network'
          ? `${trace.firstError.method} ${trace.firstError.url} → ${trace.firstError.status}`
          : trace.firstError.kind === 'console'
            ? trace.firstError.message.split('\n')[0]
            : t('ide.quicktest.noError')
      : t('ide.quicktest.noError');
    onFixWithAgent(contextPack, errorSummary);
  }, [contextPack, trace, onFixWithAgent, t]);

  return (
    <div className='size-full flex flex-col min-h-0 bg-1'>
      <QuickTestHeader
        status={status}
        platform={platform}
        target={target}
        onPlatformChange={setPlatform}
        onTargetChange={setTarget}
        onStart={handleStart}
        onStop={handleStop}
        canStart={Boolean(rootPath)}
      />
      <div className='flex-1 min-h-0 overflow-y-auto'>
        {status === 'idle' && (
          <IdleBody platform={platform} expectedText={expectedText} onExpectedTextChange={setExpectedText} />
        )}
        {status === 'recording' && <RecordingBody events={liveEvents} logRef={logRef} />}
        {status === 'done' && trace && (
          <DoneBody
            trace={trace}
            verification={verification}
            contextPack={contextPack}
            onFixWithAgent={handleFixWithAgent}
            onRestart={() => setStatus('idle')}
          />
        )}
        {status === 'error' && <ErrorBody message={errorMsg} onRetry={() => setStatus('idle')} />}
      </div>
    </div>
  );
};

/** Header bar: title + status badge + platform/target selectors + start/stop button. */
const QuickTestHeader: React.FC<{
  status: QTStatus;
  platform: TracePlatform;
  target: string;
  canStart: boolean;
  onPlatformChange: (p: TracePlatform) => void;
  onTargetChange: (v: string) => void;
  onStart: () => void;
  onStop: () => void;
}> = ({ status, platform, target, canStart, onPlatformChange, onTargetChange, onStart, onStop }) => {
  const { t } = useTranslation();
  const recording = status === 'recording';
  const editable = status === 'idle' || status === 'error';
  return (
    <div className='shrink-0 flex items-center gap-10px px-16px h-48px border-b border-b-1'>
      <span className='flex items-center gap-8px text-t-primary'>
        <Bug theme='outline' size={16} className='text-primary' />
        <span className='text-13px font-600'>{t('ide.quicktest.title')}</span>
      </span>
      {editable ? (
        <>
          <Select
            size='small'
            value={platform}
            onChange={(v) => onPlatformChange(v as TracePlatform)}
            className='w-110px'
            aria-label={t('ide.quicktest.platform')}
          >
            <Select.Option value='web'>{t('ide.quicktest.platformWeb')}</Select.Option>
            <Select.Option value='android'>{t('ide.quicktest.platformAndroid')}</Select.Option>
            <Select.Option value='windows'>{t('ide.quicktest.platformWindows')}</Select.Option>
          </Select>
          {platform !== 'web' ? (
            <Input
              size='small'
              value={target}
              onChange={onTargetChange}
              allowClear
              className='w-220px'
              placeholder={
                platform === 'android' ? t('ide.quicktest.targetAndroidHint') : t('ide.quicktest.targetWindowsHint')
              }
            />
          ) : null}
        </>
      ) : null}
      {recording ? (
        <span className='flex items-center gap-5px text-11px text-danger'>
          <span className='size-7px rd-full bg-danger animate-pulse' aria-hidden />
          {t('ide.quicktest.recording')}
        </span>
      ) : null}
      <div className='flex-1' />
      {recording ? (
        <Button type='outline' size='small' status='danger' icon={<Pause theme='outline' size={14} />} onClick={onStop}>
          {t('ide.quicktest.stop')}
        </Button>
      ) : (
        <Button
          type='primary'
          size='small'
          disabled={!canStart}
          icon={<Play theme='outline' size={14} />}
          onClick={onStart}
        >
          {t('ide.quicktest.start')}
        </Button>
      )}
    </div>
  );
};

/** Idle state: instructions + an explicit web assertion. */
const IdleBody: React.FC<{
  platform: TracePlatform;
  expectedText: string;
  onExpectedTextChange: (value: string) => void;
}> = ({ platform, expectedText, onExpectedTextChange }) => {
  const { t } = useTranslation();
  const steps =
    platform === 'web'
      ? (['step1', 'step2', 'step3'] as const)
      : platform === 'android'
        ? (['androidStep1', 'androidStep2', 'androidStep3'] as const)
        : (['windowsStep1', 'windowsStep2', 'windowsStep3'] as const);
  return (
    <div className='flex-center flex-col gap-16px px-28px py-32px text-center'>
      <span className='size-56px flex-center rd-16px bg-primary-light-1 text-primary'>
        <Bug theme='outline' size={28} />
      </span>
      <div className='flex flex-col gap-6px max-w-420px'>
        <span className='text-16px font-600 text-t-primary'>{t('ide.quicktest.idleTitle')}</span>
        <span className='text-13px text-t-secondary leading-relaxed'>{t('ide.quicktest.idleHint')}</span>
      </div>
      {platform === 'web' ? (
        <div className='w-full max-w-420px text-left px-14px py-12px rd-12px bg-fill-1 border border-arco-2'>
          <span className='block text-12px font-600 text-t-primary mb-6px'>{t('ide.quicktest.expectedTextLabel')}</span>
          <Input
            value={expectedText}
            onChange={onExpectedTextChange}
            allowClear
            placeholder={t('ide.quicktest.expectedTextPlaceholder')}
          />
          <span className='block text-11px text-t-tertiary mt-6px leading-relaxed'>
            {t('ide.quicktest.expectedTextHint')}
          </span>
        </div>
      ) : null}
      <div className='flex flex-col gap-8px max-w-380px text-left'>
        {steps.map((step, i) => (
          <div key={step} className='flex items-start gap-10px px-12px py-9px rd-10px bg-fill-1 border border-arco-2'>
            <span className='shrink-0 flex-center size-20px rd-full bg-primary-light-1 text-primary text-11px font-600'>
              {i + 1}
            </span>
            <span className='text-12px text-t-secondary leading-snug'>{t(`ide.quicktest.${step}`)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

/** Recording state: live event stream. */
const RecordingBody: React.FC<{ events: TraceEvent[]; logRef: React.RefObject<HTMLDivElement> }> = ({
  events,
  logRef,
}) => {
  const { t } = useTranslation();
  return (
    <div className='flex flex-col gap-0 h-full'>
      <div className='shrink-0 px-16px py-8px border-b border-b-1 bg-fill-1'>
        <span className='text-12px text-t-secondary'>{t('ide.quicktest.liveHint')}</span>
      </div>
      <div ref={logRef} className='flex-1 overflow-y-auto px-12px py-8px flex flex-col gap-3px font-mono text-11px'>
        {events.length === 0 ? (
          <span className='text-t-tertiary italic'>{t('ide.quicktest.waitingEvents')}</span>
        ) : (
          events.map((ev, i) => <EventRow key={i} event={ev} />)
        )}
      </div>
    </div>
  );
};

/** One event row in the live log. */
const EventRow: React.FC<{ event: TraceEvent }> = ({ event }) => {
  const color =
    event.kind === 'exception'
      ? 'text-danger'
      : event.kind === 'console' && event.level === 'error'
        ? 'text-danger'
        : event.kind === 'network' && event.status >= 400
          ? 'text-warning'
          : 'text-t-secondary';
  const label =
    event.kind === 'click'
      ? `CLICK  ${event.selector} "${event.text}"`
      : event.kind === 'input'
        ? `INPUT  ${event.selector}`
        : event.kind === 'navigate'
          ? `NAV    ${event.url}`
          : event.kind === 'network'
            ? `NET    ${event.method} ${event.url} → ${event.status}`
            : event.kind === 'console'
              ? `LOG    [${event.level}] ${event.message.slice(0, 120)}`
              : `ERR    ${event.message.split('\n')[0].slice(0, 120)}`;
  return <span className={`truncate leading-relaxed ${color}`}>{label}</span>;
};

/** Done state: trace summary + Fix with Agent. */
const DoneBody: React.FC<{
  trace: RuntimeTrace;
  verification: QtStopResponse['verification'];
  contextPack: ContextPack | null;
  onFixWithAgent: () => void;
  onRestart: () => void;
}> = ({ trace, verification, contextPack, onFixWithAgent, onRestart }) => {
  const { t } = useTranslation();
  const hasError = Boolean(trace.firstError);
  const failed = hasError || verification?.passed === false;
  const passed = !hasError && verification?.passed === true;
  const resultLabel = hasError
    ? t('ide.quicktest.errorDetected')
    : verification?.passed === false
      ? t('ide.quicktest.assertionFailed')
      : verification?.passed === true
        ? t('ide.quicktest.assertionPassed')
        : t('ide.quicktest.observationOnly');
  const interactions = trace.events.filter((e) => e.kind === 'click' || e.kind === 'input' || e.kind === 'navigate');
  const duration = ((trace.stoppedAt - trace.startedAt) / 1000).toFixed(1);

  return (
    <div className='px-16px py-16px flex flex-col gap-16px'>
      {/* Status banner */}
      <div
        className={`flex items-center gap-10px px-14px py-10px rd-10px border ${failed ? 'bg-danger-light-1 border-danger-light-3' : passed ? 'bg-success-light-1 border-success-light-3' : 'bg-fill-1 border-arco-2'}`}
      >
        {failed ? (
          <Caution theme='filled' size={18} className='shrink-0 text-danger' />
        ) : passed ? (
          <CheckOne theme='filled' size={18} className='shrink-0 text-success' />
        ) : (
          <Caution theme='outline' size={18} className='shrink-0 text-warning' />
        )}
        <div className='flex flex-col gap-1px min-w-0'>
          <span className={`text-13px font-600 ${failed ? 'text-danger' : passed ? 'text-success' : 'text-t-primary'}`}>
            {resultLabel}
          </span>
          <span className='text-11px text-t-tertiary'>
            {t('ide.quicktest.duration', { s: duration })} · {trace.events.length} {t('ide.quicktest.events')}
          </span>
        </div>
      </div>

      {/* Error detail */}
      {trace.firstError ? (
        <Section icon={<Caution theme='outline' size={13} />} title={t('ide.quicktest.errorDetail')} danger>
          <p className='m-0 font-mono text-12px text-danger leading-relaxed break-words'>
            {trace.firstError.kind === 'exception'
              ? trace.firstError.message.split('\n')[0]
              : trace.firstError.kind === 'network'
                ? `${trace.firstError.method} ${trace.firstError.url} → ${trace.firstError.status}`
                : trace.firstError.kind === 'console'
                  ? trace.firstError.message.split('\n')[0]
                  : ''}
          </p>
        </Section>
      ) : null}

      {verification ? (
        <Section
          icon={verification.passed ? <CheckOne theme='outline' size={13} /> : <Caution theme='outline' size={13} />}
          title={t('ide.quicktest.assertionTitle')}
          danger={!verification.passed}
        >
          <p className={`m-0 font-mono text-12px ${verification.passed ? 'text-success' : 'text-danger'}`}>
            {t(verification.passed ? 'ide.quicktest.expectedTextFound' : 'ide.quicktest.expectedTextMissing', {
              text: verification.expected,
            })}
          </p>
        </Section>
      ) : null}

      {/* Interaction path */}
      {interactions.length > 0 ? (
        <Section icon={<Play theme='outline' size={13} />} title={t('ide.quicktest.interactionPath')}>
          <div className='flex flex-col gap-3px'>
            {interactions.slice(-8).map((ev, i) => (
              <span key={i} className='font-mono text-11px text-t-secondary truncate'>
                {ev.kind === 'click'
                  ? `→ Click "${ev.text || ev.selector}"`
                  : ev.kind === 'input'
                    ? `→ Input ${ev.selector}`
                    : `→ Navigate ${ev.url}`}
              </span>
            ))}
          </div>
        </Section>
      ) : null}

      {/* Suspected files */}
      {contextPack && contextPack.slices.length > 0 ? (
        <Section icon={<FileCode theme='outline' size={13} />} title={t('ide.quicktest.suspectedFiles')}>
          <div className='flex flex-col gap-4px'>
            {contextPack.slices.slice(0, 6).map((slice) => (
              <div
                key={slice.path}
                className='flex items-center gap-8px px-10px py-6px rd-8px bg-fill-1 border border-arco-2'
              >
                <Code theme='outline' size={13} className='shrink-0 text-t-tertiary' />
                <span className='flex-1 truncate font-mono text-11px text-t-primary' title={slice.path}>
                  {slice.path}
                </span>
                <Tag size='small' className='shrink-0 !text-9px !px-5px !py-1px'>
                  {slice.layer}
                </Tag>
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {/* Actions */}
      <div className='flex items-center gap-10px pt-4px'>
        {contextPack ? (
          <Button type='primary' icon={<Robot theme='outline' size={15} />} onClick={onFixWithAgent} className='flex-1'>
            {t('ide.quicktest.fixWithAgent')}
          </Button>
        ) : null}
        <Tooltip content={t('ide.quicktest.restartHint')}>
          <Button type='outline' icon={<Close theme='outline' size={14} />} onClick={onRestart}>
            {t('ide.quicktest.restart')}
          </Button>
        </Tooltip>
      </div>
    </div>
  );
};

/** Error state. */
const ErrorBody: React.FC<{ message: string | null; onRetry: () => void }> = ({ message, onRetry }) => {
  const { t } = useTranslation();
  return (
    <div className='flex-center flex-col gap-12px px-24px py-32px text-center'>
      <span className='size-48px flex-center rd-14px bg-danger-light-1 text-danger'>
        <Caution theme='outline' size={24} />
      </span>
      <p className='m-0 text-14px font-600 text-t-primary'>{t('ide.quicktest.errorTitle')}</p>
      <p className='m-0 max-w-380px text-12px text-t-secondary leading-relaxed'>
        {message ?? t('ide.quicktest.errorHint')}
      </p>
      <Button type='outline' icon={<Lightning theme='outline' size={14} />} onClick={onRetry}>
        {t('ide.quicktest.retry')}
      </Button>
    </div>
  );
};

/** Titled section block. */
const Section: React.FC<{ icon: React.ReactNode; title: string; danger?: boolean; children: React.ReactNode }> = ({
  icon,
  title,
  danger,
  children,
}) => (
  <div className='flex flex-col gap-8px'>
    <span
      className={`flex items-center gap-6px text-11px font-600 uppercase tracking-wide ${danger ? 'text-danger' : 'text-t-tertiary'}`}
    >
      {icon}
      {title}
    </span>
    {children}
  </div>
);

export default QuickTestPanel;

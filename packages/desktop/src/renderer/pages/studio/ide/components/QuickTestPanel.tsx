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

import { ipcBridge } from '@/common';
import { Button, Input, Message, Tag, Tooltip } from '@arco-design/web-react';
import {
  Bug,
  Caution,
  CheckOne,
  Click,
  Close,
  Code,
  FileCode,
  FolderOpen,
  Left,
  Lightning,
  Play,
  Right,
  Robot,
} from '@icon-park/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ideClient } from '../ideClient';
import type { ContextPack, QtStopResponse, RuntimeTrace, TraceEvent, TracePlatform } from '../ideClient';
import type { LocatedElement } from '@process/ide/elementInspectorLocator';
import { renderMultiElementBrief } from '@process/ide/elementInspectorLocator';
import QuickTestBrowser from './QuickTestBrowser';
import { useQuickRun, type PlatformOption, type QuickRunState } from './useQuickRun';
import type { RunPlatform } from '../ideClient';

type QuickTestPanelProps = {
  rootPath: string | null;
  /** Compact mode hides the IDE activity rail together with the Quick Test right rail. */
  onCompactChange?: (compact: boolean) => void;
  /** Called when user clicks "Fix with Agent" — opens a new IDE Chat tab with the trace context. */
  onFixWithAgent: (contextPack: ContextPack, errorSummary: string, hasError: boolean) => void;
  /**
   * Called when the user picks an element via Inspect and submits a design/change
   * request — sends the ready-to-use element brief (component + file:line + box +
   * styles + the request) to a new IDE Chat tab. Additive to the trace flow.
   */
  onAskAboutElement: (prompt: string) => void;
};

type QTStatus = 'idle' | 'recording' | 'done' | 'error';

const QuickTestPanel: React.FC<QuickTestPanelProps> = ({
  rootPath,
  onCompactChange,
  onFixWithAgent,
  onAskAboutElement,
}) => {
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
  // The embedded browser tab id the user is testing against (web only). CDP
  // attaches to THIS tab, so the trace reflects exactly what the user drives.
  const [webTabId, setWebTabId] = useState<string | null>(null);
  // Quick-Run controller: mechanically (no AI) reads the wiki run data, runs the
  // dev command in the IDE terminal, and resolves the dev URL to navigate to.
  const quickRun = useQuickRun(rootPath);
  const logRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  // Right sidebar (inspect + trace log) visibility + width.
  // User can hide it for "full browser" UX testing mode, drag to resize,
  // and the browser area becomes almost identical to a normal browser tab.
  const [railVisible, setRailVisible] = useState(true);
  const [railWidth, setRailWidth] = useState(360);
  const railDragRef = useRef<{ startX: number; startW: number } | null>(null);

  useEffect(() => {
    onCompactChange?.(!railVisible);
    return () => onCompactChange?.(false);
  }, [railVisible, onCompactChange]);

  // Keep the tracer platform in sync with the Quick-Run platform the user picks
  // (web → tracer 'web', desktop → 'windows', android → 'android'), so pressing
  // Run and then Start observe the same target.
  useEffect(() => {
    setPlatform(quickRun.selected === 'web' ? 'web' : quickRun.selected === 'android' ? 'android' : 'windows');
  }, [quickRun.selected]);

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
      .qtStart(
        rootPath,
        platform,
        target.trim() || undefined,
        expectedText.trim() || undefined,
        platform === 'web' ? (webTabId ?? undefined) : undefined
      )
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
  }, [rootPath, platform, target, expectedText, webTabId, t]);

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
    const hasError = Boolean(trace?.firstError);
    const errorSummary = trace?.firstError
      ? trace.firstError.kind === 'exception'
        ? trace.firstError.message.split('\n')[0]
        : trace.firstError.kind === 'network'
          ? `${trace.firstError.method} ${trace.firstError.url} → ${trace.firstError.status}`
          : trace.firstError.kind === 'console'
            ? trace.firstError.message.split('\n')[0]
            : t('ide.quicktest.noError')
      : t('ide.quicktest.noError');
    onFixWithAgent(contextPack, errorSummary, hasError);
  }, [contextPack, trace, onFixWithAgent, t]);

  // ── Visual element picker (Inspect) — additive, independent of the trace ──
  // Toggling Inspect drives a CDP-free page picker: the user clicks an element
  // in the live app, the Main process maps it to its component + file:line, and
  // the panel shows that anchor + a box to type a design/change request that is
  // sent to the agent. `inspecting` guards the in-flight pick (one at a time).
  // `picks` accumulates every element the user picks (multi-select), so a
  // request can span several elements (e.g. "make these three symmetric"). Each
  // Inspect press appends one pick; the agent gets all of them at once.
  const [inspecting, setInspecting] = useState(false);
  const [picks, setPicks] = useState<LocatedElement[]>([]);
  const [designRequest, setDesignRequest] = useState('');
  // A captured screenshot of the current page (path the agent can open + a data
  // URL for the inline preview), so a vision-capable agent SEES the layout.
  const [shot, setShot] = useState<{ filePath: string; dataUrl: string } | null>(null);
  const [capturing, setCapturing] = useState(false);

  const handleInspect = useCallback(async (): Promise<void> => {
    if (!rootPath || inspecting) return;
    setInspecting(true);
    const result = await ideClient.inspectPick(rootPath, webTabId ?? undefined).catch((): null => null);
    if (!mountedRef.current) return;
    setInspecting(false);
    if (result?.ok && result.data) {
      // Append (multi-select); skip an exact duplicate of the last pick.
      setPicks((prev) => [...prev, result.data as LocatedElement]);
    } else if (result && !result.ok) {
      Message.error((result as { ok: false; error: string }).error);
    }
  }, [rootPath, inspecting, webTabId]);

  const handleCancelInspect = useCallback((): void => {
    if (rootPath) void ideClient.inspectCancel(rootPath, webTabId ?? undefined).catch(() => {});
    setInspecting(false);
  }, [rootPath, webTabId]);

  const _handleRemovePick = useCallback((index: number): void => {
    setPicks((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleClearPicks = useCallback((): void => {
    setPicks([]);
    setShot(null);
    setDesignRequest('');
  }, []);

  const _handleScreenshot = useCallback(async (): Promise<void> => {
    if (!rootPath || capturing) return;
    setCapturing(true);
    const result = await ideClient.inspectScreenshot(rootPath, webTabId ?? undefined).catch((): null => null);
    if (!mountedRef.current) return;
    setCapturing(false);
    if (result?.ok && result.data) {
      setShot(result.data);
    } else if (result && !result.ok) {
      Message.error((result as { ok: false; error: string }).error);
    }
  }, [rootPath, capturing, webTabId]);

  const handleAskAboutElement = useCallback((): void => {
    if (picks.length === 0 && !shot) return;
    const prompt = renderMultiElementBrief(picks, designRequest, shot?.filePath);
    onAskAboutElement(prompt);
    setPicks([]);
    setShot(null);
    setDesignRequest('');
  }, [picks, designRequest, shot, onAskAboutElement]);

  // ── One button drives BOTH run + record ──────────────────────────────────
  // The Quick-Run bar's Run/Stop is the single control. Pressing Run launches
  // the app (no AI); the moment it is up (`running`), recording auto-starts.
  // Pressing Stop tears the run down and that auto-stops + captures the trace.
  // This removes the old redundant second button (the header Start/Stop).
  const phaseRef = useRef(quickRun.phase);
  useEffect(() => {
    const prev = phaseRef.current;
    phaseRef.current = quickRun.phase;
    // A fresh launch began → reset the trace rail to a clean slate.
    if (quickRun.phase === 'launching' && prev !== 'launching') {
      setStatus('idle');
      setTrace(null);
      setVerification(null);
      setContextPack(null);
      setErrorMsg(null);
      setLiveEvents([]);
    }
    // The app came up → begin recording (web needs the embedded tab ready).
    if (quickRun.phase === 'running' && prev !== 'running' && (platform !== 'web' || webTabId)) {
      void handleStart();
    }
  }, [quickRun.phase, platform, webTabId, handleStart]);

  // The run stopped (Stop pressed, or it errored) while we were recording →
  // capture + stop the trace so the single Stop tears down everything.
  useEffect(() => {
    if (!quickRun.active && status === 'recording') void handleStop();
  }, [quickRun.active, status, handleStop]);

  // Drag-to-resize right rail (sidebar with inspect + activity trace).
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const drag = railDragRef.current;
      if (!drag) return;
      const delta = e.clientX - drag.startX;
      const next = Math.max(220, Math.min(520, drag.startW + delta));
      setRailWidth(next);
    };
    const onUp = (): void => {
      railDragRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const startRailResize = useCallback(
    (e: React.MouseEvent): void => {
      railDragRef.current = { startX: e.clientX, startW: railWidth };
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'col-resize';
    },
    [railWidth]
  );

  // The status rail content (instructions / live log / trace summary / error).
  // For web it sits beside the embedded browser; for native it fills the panel.
  const railBody = (
    <>
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
    </>
  );

  return (
    <div className='size-full flex flex-col min-h-0 bg-1'>
      {platform === 'web' ? null : (
        <QuickTestHeader status={status} platform={platform} target={target} onTargetChange={setTarget} />
      )}
      {platform === 'web' ? null : (
        /* Quick-Run bar: pick a platform (only supported ones), press Run, and the
            app boots mechanically (terminal + wiki run data) — no AI. */
        <QuickRunBar
          run={quickRun}
          disabled={status === 'recording'}
          railVisible={railVisible}
          onToggleRail={() => setRailVisible((v) => !v)}
        />
      )}
      {platform === 'web' ? (
        // Web: the live app under test sits beside the trace rail. The browser
        // is a native WebContentsView, so DOM z-index cannot draw the rail above
        // it; visible rails must occupy real layout space to avoid being covered.
        // The browser stays mounted across status changes so the user keeps
        // their session (and CDP target) while recording and after stopping.
        <div className='flex-1 min-h-0 flex'>
          <div className='flex-1 min-w-0 min-h-0 border-r border-r-1'>
            <QuickTestBrowser
              onTabReady={setWebTabId}
              navigateUrl={quickRun.readyUrl}
              toolbarLeading={<QuickRunInlineStart run={quickRun} />}
              toolbarTrailing={
                <QuickRunInlineEnd
                  run={quickRun}
                  disabled={status === 'recording'}
                  railVisible={railVisible}
                  onToggleRail={() => setRailVisible((v) => !v)}
                />
              }
            />
          </div>

          {railVisible ? (
            <div className='shrink-0 flex min-h-0 bg-1 border-l border-l-1' style={{ width: railWidth }}>
              {/* Resize handle for the right activity/inspect sidebar */}
              <div
                role='separator'
                aria-orientation='vertical'
                aria-label={t('ide.quicktest.resizeSidebar')}
                onMouseDown={startRailResize}
                className='w-4px shrink-0 cursor-col-resize bg-transparent hover:bg-primary-light-2 active:bg-primary transition-colors'
              />
              <div className='flex-1 min-w-0 min-h-0 overflow-y-auto flex flex-col'>
                {/* Visual element picker — additive to the trace flow above. */}
                <InspectBar
                  inspecting={inspecting}
                  picked={picks[0] ?? null}
                  designRequest={designRequest}
                  disabled={!webTabId}
                  onInspect={() => void handleInspect()}
                  onCancel={handleCancelInspect}
                  onDesignRequestChange={setDesignRequest}
                  onAsk={handleAskAboutElement}
                  onClearPick={handleClearPicks}
                />
                {railBody}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className='flex-1 min-h-0 overflow-y-auto'>{railBody}</div>
      )}
    </div>
  );
};

/**
 * Header bar: title + recording badge, plus the native target input. The
 * Run↔Stop control + platform picker now live in {@link QuickRunBar}: one button
 * launches the app AND starts recording, and stopping it tears down + captures
 * the trace — so there is no separate Start/Stop button here anymore.
 */
const QuickTestHeader: React.FC<{
  status: QTStatus;
  platform: TracePlatform;
  target: string;
  onTargetChange: (v: string) => void;
}> = ({ status, platform, target, onTargetChange }) => {
  const { t } = useTranslation();
  const editable = status === 'idle' || status === 'error';
  return (
    <div className='shrink-0 flex items-center gap-10px px-16px h-32px border-b border-b-1'>
      {/* Native targets still take a manual device/exe hint; web needs none. */}
      {editable && platform !== 'web' ? (
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
      <div className='flex-1' />
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

      {/* Code that actually ran (V8 coverage) — the user's own functions that
          executed during the test, hottest first. The "which code was called"
          answer, including bugs that throw nothing. */}
      {trace.coverage && trace.coverage.length > 0 ? (
        <Section icon={<Code theme='outline' size={13} />} title={t('ide.quicktest.executedCode')}>
          <div className='flex flex-col gap-3px'>
            {trace.coverage.slice(0, 10).map((fn, i) => (
              <div key={i} className='flex items-center gap-8px font-mono text-11px'>
                <span
                  className='flex-1 truncate text-t-secondary'
                  title={`${fn.file}${fn.line > 0 ? `:${fn.line}` : ''}`}
                >
                  {fn.functionName}()
                  <span className='text-t-tertiary'>
                    {' '}
                    {fn.file.split('/').pop()}
                    {fn.line > 0 ? `:${fn.line}` : ''}
                  </span>
                </span>
                <span className='shrink-0 text-t-tertiary'>×{fn.callCount}</span>
              </div>
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

/** Human label + icon for a run platform. */
const PLATFORM_META: Record<RunPlatform, { labelKey: string }> = {
  web: { labelKey: 'ide.quicktest.platformWeb' },
  desktop: { labelKey: 'ide.quickrun.platformDesktop' },
  android: { labelKey: 'ide.quicktest.platformAndroid' },
};

/** Small status label for where Quick Test got its run setup from. */
const setupBadge = (source: QuickRunState['setupSource']): { key: string; color: string } => {
  if (source === 'wiki') return { key: 'ide.quickrun.setupWikiDone', color: 'green' };
  if (source === 'saved') return { key: 'ide.quickrun.setupSaved', color: 'arcoblue' };
  if (source === 'package') return { key: 'ide.quickrun.setupPackage', color: 'orange' };
  if (source === 'loading') return { key: 'ide.quickrun.setupLoading', color: 'gray' };
  return { key: 'ide.quickrun.setupMissing', color: 'red' };
};

const quickRunStatusText = (run: QuickRunState, t: ReturnType<typeof useTranslation>['t']): string | null => {
  if (run.phase === 'launching') return t('ide.quickrun.launching');
  if (run.phase === 'waiting') return t('ide.quickrun.waiting', { url: run.recipe?.url ?? '' });
  if (run.phase !== 'running') return null;
  return run.fromSaved ? t('ide.quickrun.runningSaved') : t('ide.quickrun.running');
};

const QuickRunInlineStart: React.FC<{ run: QuickRunState }> = ({ run }) => {
  const { t } = useTranslation();
  const setup = setupBadge(run.setupSource);
  const supported = run.options.filter((o) => o.supported);

  const onPick = useCallback(
    (option: PlatformOption): void => {
      if (!option.supported) {
        const fallback = supported[0];
        if (fallback) {
          Message.warning(
            t('ide.quickrun.unsupportedWarn', {
              picked: t(PLATFORM_META[option.platform].labelKey),
              fallback: t(PLATFORM_META[fallback.platform].labelKey),
            })
          );
          run.select(fallback.platform);
        }
        return;
      }
      run.select(option.platform);
    },
    [run, supported, t]
  );

  return (
    <div className='shrink-0 flex items-center gap-6px min-w-0'>
      <span className='flex items-center gap-4px text-11px font-600 uppercase tracking-wide text-t-tertiary'>
        <Lightning theme='outline' size={13} className='text-primary' />
        {t('ide.quickrun.title')}
      </span>
      <Tooltip content={t('ide.quickrun.setupTooltip')}>
        <Tag size='small' color={setup.color} className='!m-0 !h-20px !leading-20px'>
          {t(setup.key)}
        </Tag>
      </Tooltip>
      <div className='flex items-center gap-3px'>
        {run.options.map((option) => {
          const active = option.platform === run.selected;
          return (
            <Tooltip
              key={option.platform}
              content={option.supported ? undefined : t('ide.quickrun.unsupportedHint')}
              disabled={option.supported}
            >
              <Button
                size='mini'
                type={active ? 'primary' : 'text'}
                disabled={!option.supported}
                onClick={() => onPick(option)}
                className={active ? '' : '!text-t-secondary'}
              >
                <span className='flex items-center gap-3px'>
                  {t(PLATFORM_META[option.platform].labelKey)}
                  {option.saved ? <CheckOne theme='filled' size={10} className='text-success' /> : null}
                </span>
              </Button>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
};

const QuickRunInlineEnd: React.FC<{
  run: QuickRunState;
  disabled: boolean;
  railVisible: boolean;
  onToggleRail: () => void;
}> = ({ run, disabled, railVisible, onToggleRail }) => {
  const { t } = useTranslation();
  const busy = run.phase === 'launching' || run.phase === 'waiting';
  const selectedOption = run.options.find((o) => o.platform === run.selected);
  const statusText = quickRunStatusText(run, t);

  return (
    <div className='shrink-0 flex items-center gap-6px min-w-0'>
      {statusText ? (
        <span className='max-w-360px flex items-center gap-5px text-11px text-t-secondary min-w-0'>
          {busy ? <span className='size-7px rd-full bg-primary animate-pulse shrink-0' aria-hidden /> : null}
          <span className='truncate'>{statusText}</span>
        </span>
      ) : null}
      <Tooltip content={t(railVisible ? 'ide.quicktest.hideIdeSidebars' : 'ide.quicktest.showIdeSidebars')}>
        <Button
          size='mini'
          type='text'
          icon={railVisible ? <Right theme='outline' size={14} /> : <Left theme='outline' size={14} />}
          onClick={onToggleRail}
          className='!text-t-secondary'
        />
      </Tooltip>
      {run.active ? (
        <Button
          size='mini'
          status='danger'
          type='primary'
          icon={<Close theme='outline' size={11} />}
          loading={busy}
          onClick={() => run.stop()}
        >
          {t('ide.quickrun.stop')}
        </Button>
      ) : (
        <Button
          size='mini'
          type='primary'
          icon={<Play theme='outline' size={11} />}
          disabled={disabled || run.phase === 'loading'}
          onClick={() => void run.run()}
        >
          {selectedOption?.saved ? t('ide.quickrun.runSaved') : t('ide.quickrun.run')}
        </Button>
      )}
    </div>
  );
};

/**
 * `QuickRunBar` — the mechanical (no-AI) Run control. Shows a platform chip per
 * supported target (web/desktop/android — independent), warns + redirects when
 * the user picks an unsupported one, and runs the wiki-derived (or saved, or
 * hand-typed) recipe in the IDE terminal on press.
 */
const QuickRunBar: React.FC<{
  run: QuickRunState;
  disabled: boolean;
  railVisible: boolean;
  onToggleRail: () => void;
}> = ({ run, disabled, railVisible, onToggleRail }) => {
  const { t } = useTranslation();
  const [warned, setWarned] = useState<RunPlatform | null>(null);
  const [manualOpen, setManualOpen] = useState(false);
  const [manualCommand, setManualCommand] = useState('');
  const [manualUrl, setManualUrl] = useState('');
  const [manualCwd, setManualCwd] = useState('');

  // When the wiki has no run data, surface the manual form by default.
  useEffect(() => {
    if (run.phase === 'needs-input') setManualOpen(true);
  }, [run.phase]);

  const selectedOption = run.options.find((o) => o.platform === run.selected);
  const supported = run.options.filter((o) => o.supported);

  const onPick = useCallback(
    (option: PlatformOption): void => {
      run.select(option.platform);
      if (!option.supported) {
        // User picked a target the project does not support → warn, then steer
        // them to a supported one (the "chọn web nhưng là app" guard).
        setWarned(option.platform);
        const fallback = supported[0];
        if (fallback) {
          Message.warning(
            t('ide.quickrun.unsupportedWarn', {
              picked: t(PLATFORM_META[option.platform].labelKey),
              fallback: t(PLATFORM_META[fallback.platform].labelKey),
            })
          );
          run.select(fallback.platform);
        }
      } else {
        setWarned(null);
      }
    },
    [run, supported, t]
  );

  const busy = run.phase === 'launching' || run.phase === 'waiting';
  const setup = setupBadge(run.setupSource);

  const statusText = quickRunStatusText(run, t);

  return (
    <div className='shrink-0 flex flex-col gap-2px px-10px py-2px border-b border-b-1 bg-fill-1'>
      <div className='flex items-center gap-6px flex-wrap min-w-0'>
        <span className='flex items-center gap-6px text-11px font-600 uppercase tracking-wide text-t-tertiary'>
          <Lightning theme='outline' size={13} className='text-primary' />
          {t('ide.quickrun.title')}
        </span>
        <Tooltip content={t('ide.quickrun.setupTooltip')}>
          <Tag size='small' color={setup.color} className='!m-0'>
            {t(setup.key)}
          </Tag>
        </Tooltip>
        {/* Platform chips: one per platform, dimmed when unsupported. */}
        <div className='flex items-center gap-4px'>
          {run.options.map((option) => {
            const active = option.platform === run.selected;
            return (
              <Tooltip
                key={option.platform}
                content={option.supported ? undefined : t('ide.quickrun.unsupportedHint')}
                disabled={option.supported}
              >
                <button
                  type='button'
                  onClick={() => onPick(option)}
                  aria-pressed={active}
                  className={`flex items-center gap-3px h-22px px-8px rd-5px border b-solid text-11px font-[500] transition-colors cursor-pointer ${
                    active
                      ? 'bg-primary-light-1 border-primary-light-3 text-primary'
                      : option.supported
                        ? 'bg-1 border-arco-2 text-t-secondary hover:bg-fill-2'
                        : 'bg-transparent border-transparent text-t-tertiary opacity-60'
                  }`}
                >
                  {t(PLATFORM_META[option.platform].labelKey)}
                  {option.saved ? <CheckOne theme='filled' size={10} className='text-success' /> : null}
                </button>
              </Tooltip>
            );
          })}
        </div>
        <div className='flex-1' />
        {statusText ? (
          <span className='flex items-center gap-5px text-11px text-t-secondary min-w-0'>
            {busy ? <span className='size-7px rd-full bg-primary animate-pulse shrink-0' aria-hidden /> : null}
            <span className='truncate'>{statusText}</span>
          </span>
        ) : null}
        <Tooltip content={t('ide.quickrun.manualToggle')}>
          <Button
            size='small'
            type='text'
            icon={<Code theme='outline' size={14} />}
            onClick={() => setManualOpen((v) => !v)}
            className={manualOpen ? '!text-primary' : '!text-t-secondary'}
          />
        </Tooltip>
        <Tooltip content={t(railVisible ? 'ide.quicktest.hideIdeSidebars' : 'ide.quicktest.showIdeSidebars')}>
          <Button
            size='small'
            type='text'
            icon={railVisible ? <Right theme='outline' size={14} /> : <Left theme='outline' size={14} />}
            onClick={onToggleRail}
            className='!text-t-secondary'
          />
        </Tooltip>
        {run.active ? (
          // Run↔Stop toggle: while launching/waiting/running, the button STOPS
          // the run — killing the spawned dev server + clearing the embedded
          // browser — so one button starts and tears down everything.
          <Button
            size='mini'
            status='danger'
            type='primary'
            icon={<Close theme='outline' size={11} />}
            loading={busy}
            onClick={() => run.stop()}
          >
            {t('ide.quickrun.stop')}
          </Button>
        ) : (
          <Button
            size='mini'
            type='primary'
            icon={<Play theme='outline' size={11} />}
            disabled={disabled || run.phase === 'loading'}
            onClick={() => void run.run()}
          >
            {selectedOption?.saved ? t('ide.quickrun.runSaved') : t('ide.quickrun.run')}
          </Button>
        )}
      </div>

      {/* Resolved recipe / error / manual editor. */}
      {run.phase === 'error' ? (
        <div className='flex items-center gap-8px px-10px py-7px rd-8px bg-danger-light-1 border border-danger-light-3'>
          <Caution theme='outline' size={14} className='shrink-0 text-danger' />
          <span className='flex-1 text-11px text-danger leading-relaxed'>
            {t('ide.quickrun.failed', { detail: run.error ?? '' })}
          </span>
          <Button size='mini' type='outline' onClick={() => setManualOpen(true)}>
            {t('ide.quickrun.editCommand')}
          </Button>
        </div>
      ) : null}

      {warned && !manualOpen ? (
        <span className='text-11px text-warning'>{t('ide.quickrun.unsupportedHint')}</span>
      ) : null}

      {manualOpen ? (
        <ManualRunForm
          command={manualCommand}
          url={manualUrl}
          cwd={manualCwd}
          platform={run.selected}
          onCommand={setManualCommand}
          onUrl={setManualUrl}
          onCwd={setManualCwd}
          onRun={() => {
            void run.runManual({ command: manualCommand, url: manualUrl, cwd: manualCwd });
          }}
        />
      ) : null}
    </div>
  );
};

/** Hand-typed run recipe (used when the wiki has no run data, or to override). */
const ManualRunForm: React.FC<{
  command: string;
  url: string;
  cwd: string;
  platform: RunPlatform;
  onCommand: (v: string) => void;
  onUrl: (v: string) => void;
  onCwd: (v: string) => void;
  onRun: () => void;
}> = ({ command, url, cwd, platform, onCommand, onUrl, onCwd, onRun }) => {
  const { t } = useTranslation();

  const pickCwd = useCallback((): void => {
    void ipcBridge.dialog.showOpen
      .invoke({ properties: ['openDirectory'] })
      .then((dirs) => {
        if (dirs?.[0]) onCwd(dirs[0]);
      })
      .catch((): undefined => undefined);
  }, [onCwd]);

  return (
    <div className='flex flex-col gap-8px px-10px py-9px rd-8px bg-1 border border-arco-2'>
      <span className='text-11px text-t-tertiary leading-relaxed'>{t('ide.quickrun.manualHint')}</span>
      <div className='grid grid-cols-1 gap-6px md:grid-cols-[minmax(220px,1.4fr)_minmax(180px,1fr)_auto]'>
        <Input
          size='small'
          value={command}
          onChange={onCommand}
          allowClear
          placeholder={t('ide.quickrun.commandPlaceholder')}
        />
        <div className='flex items-center gap-6px'>
          <Input
            size='small'
            value={cwd}
            onChange={onCwd}
            allowClear
            placeholder={t('ide.quickrun.cwdPlaceholder')}
            className='flex-1'
          />
          <Tooltip content={t('ide.quickrun.pickCwd')}>
            <Button size='small' icon={<FolderOpen theme='outline' size={13} />} onClick={pickCwd} />
          </Tooltip>
        </div>
        <Button
          size='small'
          type='primary'
          icon={<Play theme='outline' size={13} />}
          disabled={!command.trim() && !url.trim()}
          onClick={onRun}
        >
          {t('ide.quickrun.run')}
        </Button>
      </div>
      {platform === 'web' ? (
        <Input size='small' value={url} onChange={onUrl} allowClear placeholder={t('ide.quickrun.urlPlaceholder')} />
      ) : null}
    </div>
  );
};

/**
 * `InspectBar` — the visual element picker control + result card. Toggling
 * Inspect lets the user click an element in the live app; the card then shows
 * the resolved component + `file:line` + box + key styles, with a box to type a
 * design/change request that is sent to the agent. Additive to the trace flow;
 * web only (it drives the embedded tab via the CDP-free page picker).
 */
const InspectBar: React.FC<{
  inspecting: boolean;
  picked: LocatedElement | null;
  designRequest: string;
  disabled: boolean;
  onInspect: () => void;
  onCancel: () => void;
  onDesignRequestChange: (v: string) => void;
  onAsk: () => void;
  onClearPick: () => void;
}> = ({
  inspecting,
  picked,
  designRequest,
  disabled,
  onInspect,
  onCancel,
  onDesignRequestChange,
  onAsk,
  onClearPick,
}) => {
  const { t } = useTranslation();
  return (
    <div className='shrink-0 flex flex-col gap-8px px-16px py-10px border-b border-b-1 bg-fill-1'>
      <div className='flex items-center gap-10px'>
        <span className='flex items-center gap-6px text-11px font-600 uppercase tracking-wide text-t-tertiary'>
          <Click theme='outline' size={13} className='text-primary' />
          {t('ide.quicktest.inspectTitle')}
        </span>
        <div className='flex-1' />
        {inspecting ? (
          <Button
            size='small'
            status='danger'
            type='primary'
            icon={<Close theme='outline' size={13} />}
            onClick={onCancel}
          >
            {t('ide.quicktest.inspectCancel')}
          </Button>
        ) : (
          <Tooltip content={disabled ? t('ide.quicktest.inspectNoTab') : t('ide.quicktest.inspectHint')}>
            <Button
              size='small'
              type='primary'
              icon={<Click theme='outline' size={13} />}
              disabled={disabled}
              onClick={onInspect}
            >
              {t('ide.quicktest.inspect')}
            </Button>
          </Tooltip>
        )}
      </div>

      {inspecting ? (
        <span className='flex items-center gap-5px text-11px text-primary'>
          <span className='size-7px rd-full bg-primary animate-pulse' aria-hidden />
          {t('ide.quicktest.inspectActive')}
        </span>
      ) : null}

      {picked ? (
        <div className='flex flex-col gap-8px px-10px py-9px rd-8px bg-1 border border-arco-2'>
          <div className='flex items-center gap-8px'>
            <FileCode theme='outline' size={13} className='shrink-0 text-t-tertiary' />
            <span className='flex-1 truncate font-mono text-11px text-t-primary' title={picked.file ?? undefined}>
              {picked.file
                ? `${picked.file}${picked.line ? `:${picked.line}` : ''}`
                : t('ide.quicktest.inspectUnresolved')}
            </span>
            <Tag size='small' className='shrink-0 !text-9px !px-5px !py-1px'>
              {picked.resolvedBy === 'fiber-source'
                ? t('ide.quicktest.inspectExact')
                : picked.resolvedBy === 'token-match'
                  ? t('ide.quicktest.inspectHeuristic')
                  : t('ide.quicktest.inspectNone')}
            </Tag>
            <Button
              size='mini'
              type='text'
              icon={<Close theme='outline' size={12} />}
              onClick={onClearPick}
              aria-label={t('ide.quicktest.inspectClear')}
            />
          </div>
          <div className='flex flex-col gap-2px font-mono text-10px text-t-tertiary'>
            <span className='truncate'>
              {`<${picked.element.tagName}>`}
              {picked.symbol ? ` · ${picked.symbol}` : ''}
              {picked.element.text ? ` · "${picked.element.text.slice(0, 40)}"` : ''}
            </span>
            <span className='truncate'>
              {`${Math.round(picked.element.rect.width)}×${Math.round(picked.element.rect.height)}`}
              {picked.element.styles.color ? ` · ${picked.element.styles.color}` : ''}
              {picked.element.styles.fontSize ? ` · ${picked.element.styles.fontSize}` : ''}
            </span>
          </div>
          <Input.TextArea
            value={designRequest}
            onChange={onDesignRequestChange}
            autoSize={{ minRows: 2, maxRows: 4 }}
            placeholder={t('ide.quicktest.inspectRequestPlaceholder')}
          />
          <Button
            type='primary'
            size='small'
            icon={<Robot theme='outline' size={14} />}
            onClick={onAsk}
            className='self-end'
          >
            {t('ide.quicktest.inspectAsk')}
          </Button>
        </div>
      ) : null}
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

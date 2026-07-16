/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
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
import {
  Button,
  Checkbox,
  Collapse,
  Dropdown,
  Image,
  Input,
  Menu,
  Message,
  Modal,
  Tag,
  Tooltip,
} from '@arco-design/web-react';
import {
  Bug,
  Caution,
  CheckOne,
  Click,
  Close,
  Code,
  Down,
  FileCode,
  FolderOpen,
  FullScreen,
  Left,
  Lightning,
  Pic,
  Play,
  Record,
  Right,
  Robot,
  VideoTwo,
} from '@icon-park/react';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ideClient } from '../ideClient';
import type {
  ContextPack,
  QtStopResponse,
  RuntimeTrace,
  TraceEvent,
  TracePlatform,
  TraceStackFrame,
  UiAuditCategory,
  UiAuditReport,
} from '../ideClient';
import type {
  InspectScreenshotMode,
  InspectScreenshotResult,
  InspectVideoResult,
} from '@process/ide/elementInspectorBridge';
import type { LocatedElement } from '@process/ide/elementInspectorLocator';
import { renderMultiElementBrief } from '@process/ide/elementInspectorLocator';
import QuickTestBrowser from './QuickTestBrowser';
import type { PlatformOption, QuickRunMode, QuickRunState } from './useQuickRun';
import type { RunPlatform, RunServiceKind } from '../ideClient';

type QuickTestPanelProps = {
  rootPath: string | null;
  /** Workspace-owned controller that survives switching away from Quick Test. */
  quickRun: QuickRunState;
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
  quickRun,
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
  const [timelineVisible, setTimelineVisible] = useState(false);
  // The embedded browser tab id the user is testing against (web only). CDP
  // attaches to THIS tab, so the trace reflects exactly what the user drives.
  const [webTabId, setWebTabId] = useState<string | null>(null);

  const logRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(true);

  // Right sidebar (inspect + trace log) visibility + width.
  // User can hide it for "full browser" UX testing mode, drag to resize,
  // and the browser area becomes almost identical to a normal browser tab.
  const [railVisible, setRailVisible] = useState(true);
  const [runOverlayVisible, setRunOverlayVisible] = useState(false);
  const [railHeight, setRailHeight] = useState(280);
  const railDragRef = useRef<{ startY: number; startH: number } | null>(null);

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
    setStatus('recording');
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
  // Visual evidence is additive: every capture is kept until the user removes
  // it or sends the evidence bundle to the agent.
  const [shots, setShots] = useState<InspectScreenshotResult[]>([]);
  const [videos, setVideos] = useState<InspectVideoResult[]>([]);
  const [activeVideo, setActiveVideo] = useState<InspectVideoResult | null>(null);
  const [capturing, setCapturing] = useState(false);
  const [videoBusy, setVideoBusy] = useState(false);
  const [auditBusy, setAuditBusy] = useState(false);
  const [auditReport, setAuditReport] = useState<UiAuditReport | null>(null);
  const [auditVisible, setAuditVisible] = useState(false);
  const activeVideoRef = useRef<InspectVideoResult | null>(null);
  const rootPathRef = useRef(rootPath);
  activeVideoRef.current = activeVideo;
  rootPathRef.current = rootPath;

  useEffect(
    () => () => {
      const recording = activeVideoRef.current;
      const recordingRoot = rootPathRef.current;
      if (recording && recordingRoot) {
        void ideClient.inspectVideoStop(recordingRoot, recording.tabId).catch(() => {});
      }
    },
    []
  );

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
  }, []);

  const handleScreenshot = useCallback(
    async (mode: InspectScreenshotMode): Promise<void> => {
      if (!rootPath || capturing) return;
      setCapturing(true);
      const result = await ideClient.inspectScreenshot(rootPath, mode, webTabId ?? undefined).catch((): null => null);
      if (!mountedRef.current) return;
      setCapturing(false);
      if (result?.ok && result.data) {
        setShots((prev) => [...prev, result.data as InspectScreenshotResult]);
      } else if (result && !result.ok) {
        Message.error((result as { ok: false; error: string }).error);
      }
    },
    [rootPath, capturing, webTabId]
  );

  const handleUiAudit = useCallback(async (): Promise<void> => {
    if (!rootPath || !webTabId || auditBusy) return;
    setAuditBusy(true);
    const result = await ideClient.inspectAudit(rootPath, webTabId).catch((error): null => {
      console.error('[QuickTest] UI audit failed', error);
      if (mountedRef.current) {
        Message.error(error instanceof Error ? error.message : String(error));
      }
      return null;
    });
    if (!mountedRef.current) return;
    setAuditBusy(false);
    if (result?.ok && result.data) {
      setAuditReport(result.data);
      setAuditVisible(true);
    } else if (result && !result.ok) {
      Message.error((result as { ok: false; error: string }).error);
    } else if (result) {
      Message.error(t('ide.quicktest.uiAuditFailed'));
    }
  }, [rootPath, webTabId, auditBusy, t]);

  const removeEvidenceFile = useCallback((filePath: string): void => {
    void ideClient
      .deleteFile(filePath)
      .then((result) => {
        if (!result.ok) Message.error((result as { ok: false; error: string }).error);
      })
      .catch(() => {});
  }, []);

  const handleRemoveScreenshot = useCallback(
    (index: number): void => {
      const evidence = shots[index];
      setShots((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
      if (evidence) removeEvidenceFile(evidence.filePath);
    },
    [shots, removeEvidenceFile]
  );

  const handleRemoveVideo = useCallback(
    (index: number): void => {
      const evidence = videos[index];
      setVideos((prev) => prev.filter((_, itemIndex) => itemIndex !== index));
      if (evidence) removeEvidenceFile(evidence.filePath);
    },
    [videos, removeEvidenceFile]
  );

  const handleVideoToggle = useCallback(async (): Promise<void> => {
    const targetTabId = activeVideo?.tabId ?? webTabId;
    if (!rootPath || !targetTabId || videoBusy) return;
    setVideoBusy(true);
    const result = activeVideo
      ? await ideClient.inspectVideoStop(rootPath, targetTabId).catch((): null => null)
      : await ideClient.inspectVideoStart(rootPath, targetTabId).catch((): null => null);
    if (!mountedRef.current) return;
    setVideoBusy(false);
    if (result?.ok && result.data) {
      if (activeVideo) {
        setVideos((prev) => [...prev, result.data as InspectVideoResult]);
        setActiveVideo(null);
      } else {
        setActiveVideo(result.data);
      }
    } else if (result && !result.ok) {
      Message.error((result as { ok: false; error: string }).error);
    }
  }, [rootPath, webTabId, videoBusy, activeVideo]);

  const handleAskAboutElement = useCallback((): void => {
    if (picks.length === 0 && shots.length === 0 && videos.length === 0) return;
    const prompt = renderMultiElementBrief(picks, designRequest, shots, videos);
    onAskAboutElement(prompt);
    setPicks([]);
    setShots([]);
    setVideos([]);
    setDesignRequest('');
  }, [picks, designRequest, shots, videos, onAskAboutElement]);

  // ── One button drives BOTH run + record ──────────────────────────────────
  // The Quick-Run bar's Run/Stop is the single control. Pressing Run launches
  // the app (no AI); the moment it is up (`running`), recording auto-starts.
  // Pressing Stop tears the run down and that auto-stops + captures the trace.
  // This removes the old redundant second button (the header Start/Stop).
  const phaseRef = useRef<QuickRunState['phase'] | null>(null);
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
    if (quickRun.phase === 'running' && (prev !== 'running' || status === 'idle') && (platform !== 'web' || webTabId)) {
      void handleStart();
    }
  }, [quickRun.phase, platform, webTabId, status, handleStart]);

  // The run stopped (Stop pressed, or it errored) while we were recording →
  // capture + stop the trace so the single Stop tears down everything.
  useEffect(() => {
    if (!quickRun.active && status === 'recording') void handleStop();
  }, [quickRun.active, status, handleStop]);

  // Drag-to-resize the bottom inspect/activity dock.
  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      const drag = railDragRef.current;
      if (!drag) return;
      const delta = drag.startY - e.clientY;
      const next = Math.max(180, Math.min(480, drag.startH + delta));
      setRailHeight(next);
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
      railDragRef.current = { startY: e.clientY, startH: railHeight };
      document.body.style.userSelect = 'none';
      document.body.style.cursor = 'row-resize';
    },
    [railHeight]
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
          onOpenTimeline={() => setTimelineVisible(true)}
        />
      )}
      {status === 'error' && <ErrorBody message={errorMsg} onRetry={() => setStatus('idle')} />}
      {trace ? (
        <TraceTimelineModal
          trace={trace}
          contextPack={contextPack}
          visible={timelineVisible}
          onClose={() => setTimelineVisible(false)}
        />
      ) : null}
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
        // Web: the live app keeps the full available width. The inspect/trace
        // tools dock below it so responsive breakpoints match a normal browser.
        // The browser stays mounted across status changes so the user keeps
        // their session (and CDP target) while recording and after stopping.
        <div className='flex-1 min-h-0 flex flex-col'>
          <div className='flex-1 min-w-0 min-h-0'>
            <QuickTestBrowser
              onTabReady={setWebTabId}
              navigateUrl={quickRun.readyUrl}
              nativeOverlayBlocked={runOverlayVisible || timelineVisible || auditVisible}
              toolbarLeading={<QuickRunInlineStart run={quickRun} />}
              toolbarTrailing={
                <QuickRunInlineEnd
                  run={quickRun}
                  disabled={status === 'recording'}
                  railVisible={railVisible}
                  onToggleRail={() => setRailVisible((v) => !v)}
                  onOverlayVisibleChange={setRunOverlayVisible}
                />
              }
            />
          </div>

          {railVisible ? (
            <div className='shrink-0 flex flex-col min-w-0 bg-1 border-t border-t-1' style={{ height: railHeight }}>
              {/* Bottom dock preserves the tested page's real browser width. */}
              <div
                role='separator'
                aria-orientation='horizontal'
                aria-label={t('ide.quicktest.resizeSidebar')}
                onMouseDown={startRailResize}
                className='h-4px w-full shrink-0 cursor-row-resize bg-transparent hover:bg-primary-light-2 active:bg-primary transition-colors'
              />
              <div className='flex-1 min-w-0 min-h-0 overflow-y-auto flex flex-col'>
                {/* Visual element picker — additive to the trace flow above. */}
                <InspectBar
                  inspecting={inspecting}
                  picked={picks[0] ?? null}
                  shots={shots}
                  videos={videos}
                  activeVideo={activeVideo}
                  capturing={capturing}
                  videoBusy={videoBusy}
                  auditBusy={auditBusy}
                  designRequest={designRequest}
                  disabled={!webTabId}
                  onInspect={() => void handleInspect()}
                  onCancel={handleCancelInspect}
                  onScreenshot={(mode) => void handleScreenshot(mode)}
                  onAudit={() => void handleUiAudit()}
                  onVideoToggle={() => void handleVideoToggle()}
                  onDesignRequestChange={setDesignRequest}
                  onAsk={handleAskAboutElement}
                  onClearPick={handleClearPicks}
                  onRemoveScreenshot={handleRemoveScreenshot}
                  onRemoveVideo={handleRemoveVideo}
                />
                {railBody}
              </div>
            </div>
          ) : null}
        </div>
      ) : (
        <div className='flex-1 min-h-0 overflow-y-auto'>{railBody}</div>
      )}
      {auditReport ? (
        <UiAuditModal
          report={auditReport}
          visible={auditVisible}
          onClose={() => setAuditVisible(false)}
          onAsk={(report) => {
            onAskAboutElement(renderUiAuditBrief(report));
            setAuditVisible(false);
          }}
        />
      ) : null}
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
  onOpenTimeline: () => void;
}> = ({ trace, verification, contextPack, onFixWithAgent, onRestart, onOpenTimeline }) => {
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
          <Button
            type='text'
            size='mini'
            className='!justify-start !p-0 !h-auto text-11px text-t-tertiary hover:text-t-primary'
            onClick={onOpenTimeline}
          >
            {t('ide.quicktest.duration', { s: duration })} · {trace.events.length} {t('ide.quicktest.events')}
          </Button>
        </div>
      </div>

      {trace.evidence ? (
        <Section icon={<Bug theme='outline' size={13} />} title={t('ide.quicktest.evidenceLevel')}>
          <div className='flex flex-col gap-7px'>
            <div className='flex items-center gap-8px'>
              <Tag
                color={
                  trace.evidence.level === 'full' ? 'green' : trace.evidence.level === 'runtime' ? 'orange' : 'blue'
                }
              >
                {trace.evidence.level === 'full'
                  ? t('ide.quicktest.evidenceFull')
                  : trace.evidence.level === 'accessibility'
                    ? t('ide.quicktest.evidenceAccessibility')
                    : trace.evidence.level === 'runtime'
                      ? t('ide.quicktest.evidenceRuntime')
                      : t('ide.quicktest.evidenceVisual')}
              </Tag>
              <code className='text-11px text-t-tertiary'>{trace.evidence.adapter}</code>
            </div>
            {trace.evidence.noteKey ? (
              <p className='m-0 text-11px text-t-secondary leading-relaxed'>
                {trace.evidence.noteKey === 'full'
                  ? t('ide.quicktest.evidenceFullHint')
                  : trace.evidence.noteKey === 'accessibility'
                    ? t('ide.quicktest.evidenceAccessibilityHint')
                    : trace.evidence.noteKey === 'runtime'
                      ? t('ide.quicktest.evidenceRuntimeHint')
                      : t('ide.quicktest.evidenceVisualHint')}
              </p>
            ) : null}
            <div className='flex flex-wrap gap-4px'>
              {trace.evidence.capabilities.map((capability) => (
                <Tag key={capability} size='small'>
                  {capability}
                </Tag>
              ))}
            </div>
          </div>
        </Section>
      ) : null}

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

type TimelineFilter = 'all' | 'interaction' | 'network' | 'error';

const isTimelineEventVisible = (event: TraceEvent, filter: TimelineFilter): boolean => {
  if (filter === 'all') return true;
  if (filter === 'interaction') return event.kind === 'click' || event.kind === 'input' || event.kind === 'navigate';
  if (filter === 'network') return event.kind === 'network';
  return (
    event.kind === 'exception' ||
    (event.kind === 'console' && event.level === 'error') ||
    (event.kind === 'network' && (Boolean(event.error) || event.status >= 400))
  );
};

const timelineSummary = (event: TraceEvent, labels: Record<TraceEvent['kind'], string>): string => {
  if (event.kind === 'click') return `${labels.click} · ${event.text || event.selector}`;
  if (event.kind === 'input') return `${labels.input} · ${event.selector}`;
  if (event.kind === 'navigate') return `${labels.navigate} · ${event.url}`;
  if (event.kind === 'network') return `${event.method} ${event.status || 'ERR'} · ${event.url}`;
  if (event.kind === 'console') return `${labels.console} [${event.level.toUpperCase()}] · ${event.message}`;
  return `${labels.exception} · ${event.message.split('\n')[0]}`;
};

const StackFrames: React.FC<{ frames: TraceStackFrame[]; unknownLabel: string }> = ({ frames, unknownLabel }) => (
  <div className='flex flex-col gap-3px'>
    {frames.map((frame, index) => (
      <span
        key={`${frame.url ?? ''}:${frame.line ?? 0}:${index}`}
        className='font-mono text-11px text-t-secondary break-all'
      >
        {frame.functionName}() · {frame.url ?? unknownLabel}
        {frame.line ? `:${frame.line}` : ''}
      </span>
    ))}
  </div>
);

const EventDetails: React.FC<{ event: TraceEvent }> = ({ event }) => {
  const { t } = useTranslation();
  return (
    <div className='flex flex-col gap-8px px-6px pb-8px'>
      {event.kind === 'click' ? (
        <>
          <code className='text-11px text-t-secondary break-all'>{event.selector}</code>
          <span className='text-11px text-t-primary'>{event.text}</span>
        </>
      ) : null}
      {event.kind === 'input' ? (
        <>
          <code className='text-11px text-t-secondary break-all'>{event.selector}</code>
          <pre className='m-0 p-8px rd-6px bg-fill-2 text-11px text-t-primary whitespace-pre-wrap break-all'>
            {event.value}
          </pre>
        </>
      ) : null}
      {event.kind === 'navigate' ? <code className='text-11px text-t-secondary break-all'>{event.url}</code> : null}
      {event.kind === 'network' ? (
        <>
          <code className='text-11px text-t-secondary break-all'>
            {event.method} {event.url}
          </code>
          <div className='flex items-center gap-6px'>
            <Tag size='small'>{event.resourceType ?? t('ide.quicktest.networkEvents')}</Tag>
            <Tag size='small' color={event.status >= 400 || event.error ? 'red' : 'green'}>
              {event.status || event.error}
            </Tag>
          </div>
          {event.requestBody ? (
            <>
              <span className='text-11px font-600 text-t-primary'>{t('ide.quicktest.requestPayload')}</span>
              <pre className='m-0 max-h-180px overflow-auto p-8px rd-6px bg-fill-2 text-11px text-t-secondary whitespace-pre-wrap break-all'>
                {event.requestBody}
              </pre>
            </>
          ) : null}
          {event.responseHeaders ? (
            <>
              <span className='text-11px font-600 text-t-primary'>{t('ide.quicktest.responseHeaders')}</span>
              <pre className='m-0 max-h-160px overflow-auto p-8px rd-6px bg-fill-2 text-11px text-t-secondary whitespace-pre-wrap break-all'>
                {JSON.stringify(event.responseHeaders, null, 2)}
              </pre>
            </>
          ) : null}
          {event.responseBody ? (
            <>
              <span className='text-11px font-600 text-t-primary'>{t('ide.quicktest.responsePayload')}</span>
              <pre className='m-0 max-h-180px overflow-auto p-8px rd-6px bg-fill-2 text-11px text-t-secondary whitespace-pre-wrap break-all'>
                {event.responseBody}
              </pre>
            </>
          ) : null}
        </>
      ) : null}
      {event.kind === 'console' ? (
        <pre className='m-0 text-11px text-t-secondary whitespace-pre-wrap break-all'>{event.message}</pre>
      ) : null}
      {event.kind === 'exception' ? (
        <>
          <pre className='m-0 text-11px text-danger whitespace-pre-wrap break-all'>{event.stack || event.message}</pre>
          {event.stackFrames?.length ? (
            <StackFrames frames={event.stackFrames} unknownLabel={t('ide.quicktest.unknownSource')} />
          ) : null}
        </>
      ) : null}
      {(event.kind === 'click' || event.kind === 'input') && event.coverage?.length ? (
        <div className='flex flex-col gap-4px border-t border-arco-2 pt-8px'>
          <span className='text-11px font-600 text-t-primary'>{t('ide.quicktest.executedCode')}</span>
          {event.coverage.slice(0, 20).map((fn, index) => (
            <code key={`${fn.file}:${fn.line}:${index}`} className='text-11px text-t-secondary break-all'>
              {fn.file}
              {fn.line ? `:${fn.line}` : ''} · {fn.functionName}() ×{fn.callCount}
            </code>
          ))}
        </div>
      ) : null}
    </div>
  );
};

const TraceTimelineModal: React.FC<{
  trace: RuntimeTrace;
  contextPack: ContextPack | null;
  visible: boolean;
  onClose: () => void;
}> = ({ trace, contextPack, visible, onClose }) => {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<TimelineFilter>('all');
  const events = trace.events.filter((event) => isTimelineEventVisible(event, filter));
  const labels: Record<TraceEvent['kind'], string> = {
    click: t('ide.quicktest.eventClick'),
    input: t('ide.quicktest.eventInput'),
    navigate: t('ide.quicktest.eventNavigate'),
    network: t('ide.quicktest.networkEvents'),
    console: t('ide.quicktest.eventConsole'),
    exception: t('ide.quicktest.eventException'),
  };
  return (
    <Modal
      visible={visible}
      title={`${t('ide.quicktest.eventTimeline')} · ${trace.events.length}`}
      onCancel={onClose}
      autoFocus={false}
      focusLock
      style={{ width: 820 }}
      footer={
        <Button type='primary' onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <div className='flex flex-col gap-12px'>
        <Button.Group>
          {(['all', 'interaction', 'network', 'error'] as const).map((value) => (
            <Button
              key={value}
              size='small'
              type={filter === value ? 'primary' : 'secondary'}
              onClick={() => setFilter(value)}
            >
              {value === 'all'
                ? t('ide.quicktest.timelineAll')
                : value === 'interaction'
                  ? t('ide.quicktest.interactionPath')
                  : value === 'network'
                    ? t('ide.quicktest.networkEvents')
                    : t('ide.quicktest.errorDetail')}
            </Button>
          ))}
        </Button.Group>
        <div className='max-h-430px overflow-auto pr-4px'>
          <Collapse bordered={false} lazyload>
            {events.map((event, index) => (
              <Collapse.Item
                key={`${event.at}:${index}`}
                name={`${event.at}:${index}`}
                header={
                  <div className='min-w-0 flex items-center gap-10px'>
                    <span className='shrink-0 font-mono text-10px text-t-tertiary'>
                      +{((event.at - trace.startedAt) / 1000).toFixed(3)}s
                    </span>
                    <span className='truncate text-12px text-t-primary'>{timelineSummary(event, labels)}</span>
                  </div>
                }
              >
                <EventDetails event={event} />
              </Collapse.Item>
            ))}
          </Collapse>
        </div>
        {trace.coverage?.length ? (
          <Section icon={<Code theme='outline' size={13} />} title={t('ide.quicktest.executedCode')}>
            <div className='max-h-160px overflow-auto flex flex-col gap-4px'>
              {trace.coverage.map((fn, index) => (
                <code key={`${fn.file}:${fn.line}:${index}`} className='text-11px text-t-secondary break-all'>
                  {fn.file}
                  {fn.line ? `:${fn.line}` : ''} · {fn.functionName}() ×{fn.callCount}
                </code>
              ))}
            </div>
          </Section>
        ) : null}
        {contextPack?.slices.length ? (
          <Section icon={<FileCode theme='outline' size={13} />} title={t('ide.quicktest.suspectedFiles')}>
            <div className='max-h-140px overflow-auto flex flex-col gap-4px'>
              {contextPack.slices.map((slice) => (
                <div key={slice.path} className='flex items-center gap-6px'>
                  <code className='flex-1 text-11px text-t-secondary break-all'>{slice.path}</code>
                  <Tag size='small'>{slice.layer}</Tag>
                </div>
              ))}
            </div>
          </Section>
        ) : null}
      </div>
    </Modal>
  );
};

const UI_AUDIT_CATEGORIES: UiAuditCategory[] = ['contrast', 'typography', 'accessibility', 'layout', 'interaction'];

const renderUiAuditBrief = (report: UiAuditReport): string => {
  const newline = String.fromCharCode(10);
  const findings = report.findings.slice(0, 100).map((finding, index) => {
    const source = finding.sourceFile
      ? ' · ' + finding.sourceFile + (finding.sourceLine ? ':' + finding.sourceLine : '')
      : '';
    const values =
      finding.measured || finding.expected
        ? ' · measured=' + (finding.measured || '—') + ' · expected=' + (finding.expected || '—')
        : '';
    return (
      String(index + 1) +
      '. [' +
      finding.severity +
      '/' +
      finding.category +
      '] ' +
      finding.ruleId +
      ' · ' +
      finding.selector +
      values +
      source +
      newline +
      '   ' +
      finding.detail
    );
  });
  return [
    '# Deterministic UI quality audit',
    'URL: ' + report.url,
    'Score: ' + report.score + '/100 · Elements: ' + report.elementCount + ' · Findings: ' + report.findings.length,
    'Category scores: ' + JSON.stringify(report.categoryScores),
    '',
    ...findings,
    report.findings.length > findings.length ? 'Only the first 100 findings are included.' : '',
    '',
    'Fix the findings in severity order. Preserve the product intent and verify the measured values after changes.',
  ].join(newline);
};

const uiAuditSeverityColor = (severity: string): string =>
  severity === 'critical' || severity === 'serious' ? 'red' : severity === 'moderate' ? 'orange' : 'blue';

const UiAuditModal: React.FC<{
  report: UiAuditReport;
  visible: boolean;
  onClose: () => void;
  onAsk: (report: UiAuditReport) => void;
}> = ({ report, visible, onClose, onAsk }) => {
  const { t } = useTranslation();
  const [filter, setFilter] = useState<UiAuditCategory | 'all'>('all');
  const findings = filter === 'all' ? report.findings : report.findings.filter((item) => item.category === filter);
  const categoryLabel = (category: UiAuditCategory): string => {
    const keys: Record<UiAuditCategory, string> = {
      contrast: 'ide.quicktest.uiAuditCategory_contrast',
      typography: 'ide.quicktest.uiAuditCategory_typography',
      accessibility: 'ide.quicktest.uiAuditCategory_accessibility',
      layout: 'ide.quicktest.uiAuditCategory_layout',
      interaction: 'ide.quicktest.uiAuditCategory_interaction',
    };
    return t(keys[category]);
  };

  return (
    <Modal
      visible={visible}
      title={t('ide.quicktest.uiAuditTitle')}
      onCancel={onClose}
      autoFocus={false}
      focusLock
      style={{ width: 900 }}
      footer={
        <div className='flex justify-end gap-8px'>
          <Button onClick={onClose}>{t('common.close')}</Button>
          <Button type='primary' icon={<Robot theme='outline' size={14} />} onClick={() => onAsk(report)}>
            {t('ide.quicktest.uiAuditFix')}
          </Button>
        </div>
      }
    >
      <div className='flex flex-col gap-14px'>
        <div className='grid grid-cols-[150px_1fr] gap-12px'>
          <div className='flex flex-col items-center justify-center rd-10px bg-fill-2 px-12px py-16px'>
            <span className='text-32px leading-36px font-700 text-primary'>{report.score}</span>
            <span className='text-11px text-t-secondary'>{t('ide.quicktest.uiAuditScore')}</span>
          </div>
          <div className='grid grid-cols-2 gap-8px'>
            <div className='rd-8px bg-fill-1 px-12px py-9px'>
              <div className='text-11px text-t-tertiary'>{t('ide.quicktest.uiAuditElements')}</div>
              <div className='text-16px font-600 text-t-primary'>{report.elementCount}</div>
            </div>
            <div className='rd-8px bg-fill-1 px-12px py-9px'>
              <div className='text-11px text-t-tertiary'>{t('ide.quicktest.uiAuditFindings')}</div>
              <div className='text-16px font-600 text-t-primary'>{report.findings.length}</div>
            </div>
            <code className='col-span-2 truncate rd-8px bg-fill-1 px-12px py-9px text-11px text-t-secondary'>
              {report.url}
            </code>
          </div>
        </div>
        <div className='grid grid-cols-5 gap-6px'>
          {UI_AUDIT_CATEGORIES.map((category) => (
            <div key={category} className='rd-8px border border-arco-2 px-8px py-7px text-center'>
              <div className='text-10px text-t-tertiary'>{categoryLabel(category)}</div>
              <div className='text-14px font-600 text-t-primary'>{report.categoryScores[category]}</div>
            </div>
          ))}
        </div>
        <Button.Group>
          <Button size='small' type={filter === 'all' ? 'primary' : 'secondary'} onClick={() => setFilter('all')}>
            {t('ide.quicktest.timelineAll')}
          </Button>
          {UI_AUDIT_CATEGORIES.map((category) => (
            <Button
              key={category}
              size='small'
              type={filter === category ? 'primary' : 'secondary'}
              onClick={() => setFilter(category)}
            >
              {categoryLabel(category)}
            </Button>
          ))}
        </Button.Group>
        <div className='max-h-410px overflow-auto pr-4px'>
          {findings.length === 0 ? (
            <div className='py-36px text-center text-12px text-t-secondary'>{t('ide.quicktest.uiAuditNoFindings')}</div>
          ) : (
            <Collapse bordered={false} lazyload>
              {findings.map((finding, index) => (
                <Collapse.Item
                  key={finding.ruleId + ':' + finding.selector + ':' + index}
                  name={finding.ruleId + ':' + index}
                  header={
                    <div className='min-w-0 flex items-center gap-8px'>
                      <Tag size='small' color={uiAuditSeverityColor(finding.severity)}>
                        {finding.severity}
                      </Tag>
                      <code className='shrink-0 text-11px text-primary'>{finding.ruleId}</code>
                      <span className='truncate text-11px text-t-secondary'>{finding.selector}</span>
                    </div>
                  }
                >
                  <div className='flex flex-col gap-8px text-12px'>
                    <p className='m-0 text-t-primary'>{finding.detail}</p>
                    {finding.measured || finding.expected ? (
                      <div className='grid grid-cols-2 gap-8px'>
                        <div className='rd-6px bg-fill-2 p-8px'>
                          <div className='text-10px text-t-tertiary'>{t('ide.quicktest.uiAuditMeasured')}</div>
                          <code className='text-11px text-t-primary'>{finding.measured || '—'}</code>
                        </div>
                        <div className='rd-6px bg-fill-2 p-8px'>
                          <div className='text-10px text-t-tertiary'>{t('ide.quicktest.uiAuditExpected')}</div>
                          <code className='text-11px text-t-primary'>{finding.expected || '—'}</code>
                        </div>
                      </div>
                    ) : null}
                    {finding.rect ? (
                      <code className='text-11px text-t-secondary'>
                        x={Math.round(finding.rect.x)}, y={Math.round(finding.rect.y)}, w=
                        {Math.round(finding.rect.width)}, h={Math.round(finding.rect.height)}
                      </code>
                    ) : null}
                    {finding.sourceFile ? (
                      <div className='flex items-center gap-6px'>
                        <FileCode theme='outline' size={13} className='text-primary' />
                        <span className='text-10px text-t-tertiary'>{t('ide.quicktest.uiAuditSource')}</span>
                        <code className='break-all text-11px text-t-secondary'>
                          {finding.sourceFile}
                          {finding.sourceLine ? ':' + finding.sourceLine : ''}
                        </code>
                      </div>
                    ) : null}
                  </div>
                </Collapse.Item>
              ))}
            </Collapse>
          )}
        </div>
      </div>
    </Modal>
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

const RUN_MODE_KEYS: Record<QuickRunMode, string> = {
  interface: 'ide.quickrun.modeInterface',
  full: 'ide.quickrun.modeFull',
  custom: 'ide.quickrun.modeCustom',
};

const SERVICE_KIND_KEYS: Record<RunServiceKind, string> = {
  frontend: 'ide.quickrun.serviceFrontend',
  backend: 'ide.quickrun.serviceBackend',
  ai: 'ide.quickrun.serviceAi',
  database: 'ide.quickrun.serviceDatabase',
  worker: 'ide.quickrun.serviceWorker',
  other: 'ide.quickrun.serviceOther',
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
  onOverlayVisibleChange: (visible: boolean) => void;
}> = ({ run, disabled, railVisible, onToggleRail, onOverlayVisibleChange }) => {
  const { t } = useTranslation();
  const busy = run.phase === 'launching' || run.phase === 'waiting';
  const selectedOption = run.options.find((o) => o.platform === run.selected);
  const statusText = quickRunStatusText(run, t);
  const [runMode, setRunMode] = useState<QuickRunMode>('interface');
  const [customVisible, setCustomVisible] = useState(false);
  const [dropdownVisible, setDropdownVisible] = useState(false);
  const [customServiceIds, setCustomServiceIds] = useState<string[]>([]);
  const selectableServices = run.services.filter((service) => !service.orchestrator);

  useEffect(() => {
    onOverlayVisibleChange(dropdownVisible || customVisible);
  }, [customVisible, dropdownVisible, onOverlayVisibleChange]);

  useEffect(
    () => () => {
      onOverlayVisibleChange(false);
    },
    [onOverlayVisibleChange]
  );

  const selectRunMode = useCallback((mode: QuickRunMode): void => {
    setRunMode(mode);
    if (mode === 'custom') setCustomVisible(true);
  }, []);

  const runMenu = (
    <Menu selectedKeys={[runMode]} onClickMenuItem={(key) => selectRunMode(key as QuickRunMode)}>
      <Menu.Item key='interface'>
        <div className='flex flex-col gap-1px py-2px'>
          <span className='text-12px font-500 text-t-primary'>{t('ide.quickrun.modeInterface')}</span>
          <span className='text-10px text-t-tertiary'>{t('ide.quickrun.modeInterfaceHint')}</span>
        </div>
      </Menu.Item>
      <Menu.Item key='full'>
        <div className='flex flex-col gap-1px py-2px'>
          <span className='text-12px font-500 text-t-primary'>{t('ide.quickrun.modeFull')}</span>
          <span className='text-10px text-t-tertiary'>{t('ide.quickrun.modeFullHint')}</span>
        </div>
      </Menu.Item>
      <Menu.Item key='custom' disabled={selectableServices.length === 0}>
        <div className='flex flex-col gap-1px py-2px'>
          <span className='text-12px font-500 text-t-primary'>{t('ide.quickrun.modeCustom')}</span>
          <span className='text-10px text-t-tertiary'>{t('ide.quickrun.modeCustomHint')}</span>
        </div>
      </Menu.Item>
    </Menu>
  );

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
      ) : run.selected === 'web' ? (
        <Button.Group>
          <Button
            size='mini'
            type='primary'
            icon={<Play theme='outline' size={11} />}
            disabled={disabled || run.phase === 'loading'}
            onClick={() =>
              runMode === 'custom' && customServiceIds.length === 0
                ? setCustomVisible(true)
                : void run.run({ mode: runMode, serviceIds: customServiceIds })
            }
          >
            {t(RUN_MODE_KEYS[runMode])}
          </Button>
          <Dropdown
            droplist={runMenu}
            trigger='click'
            position='br'
            popupVisible={dropdownVisible}
            onVisibleChange={setDropdownVisible}
          >
            <Button
              size='mini'
              type='primary'
              icon={<Down theme='outline' size={11} />}
              disabled={disabled || run.phase === 'loading'}
              aria-label={t('ide.quickrun.runOptions')}
            />
          </Dropdown>
        </Button.Group>
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
      <Modal
        visible={customVisible}
        title={t('ide.quickrun.customTitle')}
        okText={t('ide.quickrun.runSelected')}
        cancelText={t('common.cancel')}
        okButtonProps={{ disabled: customServiceIds.length === 0 }}
        onCancel={() => setCustomVisible(false)}
        onOk={() => {
          if (customServiceIds.length === 0) return;
          setRunMode('custom');
          setCustomVisible(false);
          void run.run({ mode: 'custom', serviceIds: customServiceIds });
        }}
      >
        <div className='flex flex-col gap-10px'>
          <p className='m-0 text-12px leading-relaxed text-t-secondary'>{t('ide.quickrun.customHint')}</p>
          <Checkbox
            checked={customServiceIds.length > 0 && customServiceIds.length === selectableServices.length}
            indeterminate={customServiceIds.length > 0 && customServiceIds.length < selectableServices.length}
            onChange={(checked) => setCustomServiceIds(checked ? selectableServices.map((service) => service.id) : [])}
          >
            {t('ide.quickrun.selectAll')}
          </Checkbox>
          <div className='max-h-320px overflow-y-auto flex flex-col gap-6px'>
            {selectableServices.map((service) => (
              <Checkbox
                key={service.id}
                checked={customServiceIds.includes(service.id)}
                onChange={(checked) =>
                  setCustomServiceIds((current) =>
                    checked ? [...current, service.id] : current.filter((id) => id !== service.id)
                  )
                }
                className='w-full px-10px py-8px rd-6px border border-arco-2 bg-fill-1 hover:bg-fill-2 transition-colors'
              >
                <span className='inline-flex items-center gap-6px min-w-0'>
                  <Tag
                    size='small'
                    color={service.kind === 'ai' ? 'purple' : service.kind === 'backend' ? 'orange' : 'arcoblue'}
                  >
                    {t(SERVICE_KIND_KEYS[service.kind])}
                  </Tag>
                  <span className='font-500 text-t-primary'>{service.name}</span>
                  <span className='truncate text-10px text-t-tertiary'>{service.command}</span>
                </span>
              </Checkbox>
            ))}
          </div>
        </div>
      </Modal>
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

  const [runMode, setRunMode] = useState<QuickRunMode>('interface');
  const [customVisible, setCustomVisible] = useState(false);
  const [customServiceIds, setCustomServiceIds] = useState<string[]>([]);

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

  const selectableServices = run.services.filter((service) => !service.orchestrator);
  const selectRunMode = useCallback((mode: QuickRunMode): void => {
    setRunMode(mode);
    if (mode === 'custom') setCustomVisible(true);
  }, []);
  const runMenu = (
    <Menu selectedKeys={[runMode]} onClickMenuItem={(key) => selectRunMode(key as QuickRunMode)}>
      <Menu.Item key='interface'>
        <div className='flex flex-col gap-1px py-2px'>
          <span className='text-12px font-500 text-t-primary'>{t('ide.quickrun.modeInterface')}</span>
          <span className='text-10px text-t-tertiary'>{t('ide.quickrun.modeInterfaceHint')}</span>
        </div>
      </Menu.Item>
      <Menu.Item key='full'>
        <div className='flex flex-col gap-1px py-2px'>
          <span className='text-12px font-500 text-t-primary'>{t('ide.quickrun.modeFull')}</span>
          <span className='text-10px text-t-tertiary'>{t('ide.quickrun.modeFullHint')}</span>
        </div>
      </Menu.Item>
      <Menu.Item key='custom' disabled={selectableServices.length === 0}>
        <div className='flex flex-col gap-1px py-2px'>
          <span className='text-12px font-500 text-t-primary'>{t('ide.quickrun.modeCustom')}</span>
          <span className='text-10px text-t-tertiary'>{t('ide.quickrun.modeCustomHint')}</span>
        </div>
      </Menu.Item>
    </Menu>
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
        ) : run.selected === 'web' ? (
          <Button.Group>
            <Button
              size='mini'
              type='primary'
              icon={<Play theme='outline' size={11} />}
              disabled={disabled || run.phase === 'loading'}
              onClick={() =>
                runMode === 'custom' && customServiceIds.length === 0
                  ? setCustomVisible(true)
                  : void run.run({ mode: runMode, serviceIds: customServiceIds })
              }
            >
              {t(RUN_MODE_KEYS[runMode])}
            </Button>
            <Dropdown droplist={runMenu} trigger='click' position='br'>
              <Button
                size='mini'
                type='primary'
                icon={<Down theme='outline' size={11} />}
                disabled={disabled || run.phase === 'loading'}
                aria-label={t('ide.quickrun.runOptions')}
              />
            </Dropdown>
          </Button.Group>
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

      <Modal
        visible={customVisible}
        title={t('ide.quickrun.customTitle')}
        okText={t('ide.quickrun.runSelected')}
        cancelText={t('common.cancel')}
        okButtonProps={{ disabled: customServiceIds.length === 0 }}
        onCancel={() => setCustomVisible(false)}
        onOk={() => {
          if (customServiceIds.length === 0) return;
          setRunMode('custom');
          setCustomVisible(false);
          void run.run({ mode: 'custom', serviceIds: customServiceIds });
        }}
      >
        <div className='flex flex-col gap-10px'>
          <p className='m-0 text-12px leading-relaxed text-t-secondary'>{t('ide.quickrun.customHint')}</p>
          <Checkbox
            checked={customServiceIds.length > 0 && customServiceIds.length === selectableServices.length}
            indeterminate={customServiceIds.length > 0 && customServiceIds.length < selectableServices.length}
            onChange={(checked) => setCustomServiceIds(checked ? selectableServices.map((service) => service.id) : [])}
          >
            {t('ide.quickrun.selectAll')}
          </Checkbox>
          <div className='max-h-320px overflow-y-auto flex flex-col gap-6px'>
            {selectableServices.map((service) => (
              <Checkbox
                key={service.id}
                checked={customServiceIds.includes(service.id)}
                onChange={(checked) =>
                  setCustomServiceIds((current) =>
                    checked ? [...current, service.id] : current.filter((id) => id !== service.id)
                  )
                }
                className='w-full px-10px py-8px rd-6px border border-arco-2 bg-fill-1 hover:bg-fill-2 transition-colors'
              >
                <span className='inline-flex items-center gap-6px min-w-0'>
                  <Tag
                    size='small'
                    color={service.kind === 'ai' ? 'purple' : service.kind === 'backend' ? 'orange' : 'arcoblue'}
                  >
                    {t(SERVICE_KIND_KEYS[service.kind])}
                  </Tag>
                  <span className='font-500 text-t-primary'>{service.name}</span>
                  <span className='truncate text-10px text-t-tertiary'>{service.command}</span>
                </span>
              </Checkbox>
            ))}
          </div>
        </div>
      </Modal>
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
  shots: InspectScreenshotResult[];
  videos: InspectVideoResult[];
  activeVideo: InspectVideoResult | null;
  capturing: boolean;
  videoBusy: boolean;
  auditBusy: boolean;
  designRequest: string;
  disabled: boolean;
  onInspect: () => void;
  onCancel: () => void;
  onScreenshot: (mode: InspectScreenshotMode) => void;
  onAudit: () => void;
  onVideoToggle: () => void;
  onDesignRequestChange: (v: string) => void;
  onAsk: () => void;
  onClearPick: () => void;
  onRemoveScreenshot: (index: number) => void;
  onRemoveVideo: (index: number) => void;
}> = ({
  inspecting,
  picked,
  shots,
  videos,
  activeVideo,
  capturing,
  videoBusy,
  auditBusy,
  designRequest,
  disabled,
  onInspect,
  onCancel,
  onScreenshot,
  onAudit,
  onVideoToggle,
  onDesignRequestChange,
  onAsk,
  onClearPick,
  onRemoveScreenshot,
  onRemoveVideo,
}) => {
  const { t } = useTranslation();
  const screenshotMenu = (
    <Menu onClickMenuItem={(key) => onScreenshot(key as InspectScreenshotMode)}>
      <Menu.Item key='viewport'>
        <div className='min-h-38px flex items-center gap-9px !leading-normal'>
          <span className='size-22px shrink-0 inline-flex items-center justify-center rd-5px bg-primary-light-1 leading-none'>
            <Pic theme='outline' size={14} className='text-primary' style={{ lineHeight: 0 }} />
          </span>
          <div className='min-w-0 flex flex-col gap-1px !leading-normal'>
            <span className='text-12px leading-16px font-500 text-t-primary'>
              {t('ide.quicktest.screenshotViewport')}
            </span>
            <span className='text-10px leading-14px text-t-tertiary'>{t('ide.quicktest.screenshotViewportHint')}</span>
          </div>
        </div>
      </Menu.Item>
      <Menu.Item key='fullPage'>
        <div className='min-h-38px flex items-center gap-9px !leading-normal'>
          <span className='size-22px shrink-0 inline-flex items-center justify-center rd-5px bg-primary-light-1 leading-none'>
            <FullScreen theme='outline' size={14} className='text-primary' style={{ lineHeight: 0 }} />
          </span>
          <div className='min-w-0 flex flex-col gap-1px !leading-normal'>
            <span className='text-12px leading-16px font-500 text-t-primary'>
              {t('ide.quicktest.screenshotFullPage')}
            </span>
            <span className='text-10px leading-14px text-t-tertiary'>{t('ide.quicktest.screenshotFullPageHint')}</span>
          </div>
        </div>
      </Menu.Item>
    </Menu>
  );
  return (
    <div className='shrink-0 flex flex-col gap-8px px-16px py-10px border-b border-b-1 bg-fill-1'>
      <div className='flex items-center gap-6px flex-wrap'>
        <span className='flex items-center gap-6px text-11px font-600 uppercase tracking-wide text-t-tertiary'>
          <Click theme='outline' size={13} className='text-primary' />
          {t('ide.quicktest.inspectTitle')}
        </span>
        <div className='flex-1' />
        <Button
          size='small'
          icon={<CheckOne theme='outline' size={13} />}
          loading={auditBusy}
          disabled={disabled || auditBusy}
          title={disabled ? t('ide.quicktest.inspectNoTab') : t('ide.quicktest.uiAuditHint')}
          onClick={onAudit}
        >
          {t('ide.quicktest.uiAudit')}
        </Button>
        <Button
          size='small'
          type={activeVideo ? 'primary' : 'secondary'}
          status={activeVideo ? 'danger' : 'default'}
          icon={
            activeVideo ? (
              <span className='size-8px rd-full bg-1 animate-pulse' aria-hidden />
            ) : (
              <Record theme='outline' size={13} />
            )
          }
          loading={videoBusy}
          disabled={(!activeVideo && disabled) || videoBusy}
          title={disabled ? t('ide.quicktest.inspectNoTab') : t('ide.quicktest.recordVideoHint')}
          onClick={onVideoToggle}
        >
          {t(activeVideo ? 'ide.quicktest.stopVideo' : 'ide.quicktest.recordVideo')}
        </Button>
        <Dropdown droplist={screenshotMenu} trigger='click' position='br'>
          <Button
            size='small'
            icon={<Pic theme='outline' size={13} />}
            loading={capturing}
            disabled={disabled || capturing}
            title={disabled ? t('ide.quicktest.inspectNoTab') : t('ide.quicktest.screenshotHint')}
          >
            {t('ide.quicktest.screenshot')}
          </Button>
        </Dropdown>
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

      {picked || shots.length > 0 || videos.length > 0 || activeVideo ? (
        <div className='flex flex-col gap-8px px-10px py-9px rd-8px bg-1 border border-arco-2'>
          {picked ? (
            <>
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
            </>
          ) : null}

          {shots.length > 0 ? (
            <div className='flex flex-col gap-7px'>
              <div className='flex items-center gap-7px'>
                <Pic theme='outline' size={13} className='shrink-0 text-primary' />
                <span className='flex-1 text-11px font-500 text-t-primary'>
                  {t('ide.quicktest.screenshotCaptured')} · {shots.length}
                </span>
              </div>
              <div className='grid grid-cols-2 gap-6px'>
                {shots.map((shot, index) => (
                  <div
                    key={shot.filePath}
                    className='min-w-0 flex flex-col gap-4px rd-6px bg-fill-2 border border-arco-2 p-4px'
                  >
                    <div className='flex items-center gap-4px'>
                      <Tag size='small' color='arcoblue' className='min-w-0 truncate'>
                        {t(
                          shot.mode === 'fullPage'
                            ? 'ide.quicktest.screenshotFullPage'
                            : 'ide.quicktest.screenshotViewport'
                        )}
                      </Tag>
                      <div className='flex-1' />
                      <Button
                        size='mini'
                        type='text'
                        icon={<Close theme='outline' size={11} />}
                        onClick={() => onRemoveScreenshot(index)}
                        aria-label={t('ide.quicktest.screenshotRemove')}
                      />
                    </div>
                    <div className='h-96px overflow-hidden flex items-center justify-center'>
                      <Image
                        src={shot.dataUrl}
                        alt={t('ide.quicktest.screenshotPreviewAlt')}
                        preview
                        className='w-full h-full flex items-center justify-center [&_.arco-image-img]:w-full [&_.arco-image-img]:h-full [&_.arco-image-img]:object-contain'
                      />
                    </div>
                    <span className='truncate font-mono text-9px text-t-tertiary' title={shot.filePath}>
                      {shot.filePath}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {activeVideo || videos.length > 0 ? (
            <div className='flex flex-col gap-6px'>
              {activeVideo ? (
                <div className='flex items-center gap-7px px-8px py-7px rd-6px bg-danger-light-1 border border-danger-light-3'>
                  <span className='size-8px rd-full bg-danger animate-pulse' aria-hidden />
                  <span className='text-11px font-500 text-danger'>{t('ide.quicktest.recordingVideo')}</span>
                </div>
              ) : null}
              {videos.map((video, index) => (
                <div
                  key={video.filePath}
                  className='flex items-center gap-7px px-8px py-7px rd-6px bg-fill-2 border border-arco-2'
                >
                  <VideoTwo theme='outline' size={14} className='shrink-0 text-primary' />
                  <div className='min-w-0 flex-1 flex flex-col gap-2px'>
                    <span className='text-11px font-500 text-t-primary'>
                      {t('ide.quicktest.videoCaptured')} · {Math.max(1, Math.round(video.durationMs / 1000))}s
                    </span>
                    <span className='truncate font-mono text-9px text-t-tertiary' title={video.filePath}>
                      {video.filePath}
                    </span>
                  </div>
                  <Button
                    size='mini'
                    type='text'
                    icon={<Close theme='outline' size={11} />}
                    onClick={() => onRemoveVideo(index)}
                    aria-label={t('ide.quicktest.videoRemove')}
                  />
                </div>
              ))}
            </div>
          ) : null}

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

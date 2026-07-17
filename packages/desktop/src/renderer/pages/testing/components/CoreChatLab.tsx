/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Empty, Input, Modal, Select, Spin, Tag } from '@arco-design/web-react';
import { BranchOne, ExperimentOne, PauseOne, Refresh, Send } from '@icon-park/react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { WorkspaceFolderSelect } from '@/renderer/components/workspace';
import { loadKnownCompanies, saveKnownCompanies } from '@/renderer/pages/company/constants';
import {
  coreChatClient,
  type CoreEvent,
  type CorePermissionMode,
  type CoreRunSnapshot,
  type CoreSession,
  type CoreTarget,
  type CoreTargetKind,
} from '../coreChatClient';

type ChatEntry = { role: 'user' | 'assistant'; text: string };
type RunState = 'idle' | 'running' | 'completed' | 'error' | 'cancelled';

const KIND_ORDER: CoreTargetKind[] = ['builtin', 'acp', 'cli', 'remote'];

const ACTIVE_CORE_SESSION_KEY = 'tomny-core.active-session';

const rememberActiveSession = (sessionId: string): void => {
  try {
    if (sessionId) localStorage.setItem(ACTIVE_CORE_SESSION_KEY, sessionId);
    else localStorage.removeItem(ACTIVE_CORE_SESSION_KEY);
  } catch {
    // Persistence is best-effort in restricted renderer contexts.
  }
};

const rememberedActiveSession = (): string => {
  try {
    return localStorage.getItem(ACTIVE_CORE_SESSION_KEY) ?? '';
  } catch {
    return '';
  }
};

const recoveredEntries = (session: CoreSession, active?: CoreRunSnapshot): ChatEntry[] => {
  const restored = session.messages.map((message) => ({ role: message.role, text: message.text }));
  if (active?.partialText) restored.push({ role: 'assistant', text: active.partialText });
  return restored;
};

const normalizeEventText = (value: unknown): string => {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
};

const eventLabel = (event: CoreEvent): string => normalizeEventText(event.tool) || event.type;

const eventBody = (event: CoreEvent): string =>
  [event.text, event.detail]
    .map(normalizeEventText)
    .filter((value) => value.length > 0)
    .join('\n\n');

const eventTimestamp = (event: CoreEvent): number => (Number.isFinite(event.timestamp) ? event.timestamp : Date.now());

const eventKey = (event: CoreEvent, index: number): string => `${eventTimestamp(event)}-${event.type}-${index}`;

const CoreChatLab: React.FC = () => {
  const { t } = useTranslation();
  const [targets, setTargets] = useState<CoreTarget[]>([]);
  const [sessions, setSessions] = useState<CoreSession[]>([]);
  const [activeSessionId, setActiveSessionId] = useState('');
  const [selectedTarget, setSelectedTarget] = useState('');
  const [selectedModel, setSelectedModel] = useState('');
  const [permissionMode, setPermissionMode] = useState<CorePermissionMode>('workspace-write');
  const [prompt, setPrompt] = useState('');
  const [workspace, setWorkspace] = useState('');
  const [companyId, setCompanyId] = useState(() => loadKnownCompanies()[0] ?? '');
  const [entries, setEntries] = useState<ChatEntry[]>([]);
  const [events, setEvents] = useState<CoreEvent[]>([]);
  const [state, setState] = useState<RunState>('idle');
  const [statusText, setStatusText] = useState('');
  const [stepsExpanded, setStepsExpanded] = useState(false);
  const [loadingTargets, setLoadingTargets] = useState(true);
  const [loadingModels, setLoadingModels] = useState(false);
  const [targetError, setTargetError] = useState('');
  const activeRequestRef = useRef<string | null>(null);

  const kindLabel = (kind: CoreTargetKind): string => t(`testing.core.kind.${kind}`);

  const loadSessions = async (): Promise<void> => {
    const next = await coreChatClient.listSessions().catch((): CoreSession[] => []);
    setSessions(next);
  };

  const showPermission = (event: CoreEvent): void => {
    if (!event.permissionId) return;
    const permissionId = event.permissionId;
    const tool = normalizeEventText(event.tool) || t('testing.core.unknownTool');
    setStatusText(t('testing.core.permissionWaiting', { tool }));
    Modal.confirm({
      title: t('testing.core.permissionRequestTitle'),
      content: normalizeEventText(event.detail)
        ? t('testing.core.permissionRequestDetail', { tool, detail: normalizeEventText(event.detail) })
        : t('testing.core.permissionRequestBody', { tool }),
      okText: t('testing.core.allowOnce'),
      cancelText: t('testing.core.deny'),
      onOk: () => coreChatClient.resolvePermission(permissionId, true),
      onCancel: () => {
        void coreChatClient.resolvePermission(permissionId, false);
      },
    });
  };

  const selectSession = (sessionId?: string): void => {
    const session = sessions.find((candidate) => candidate.id === sessionId);
    setActiveSessionId(session?.id ?? '');

    rememberActiveSession(session?.id ?? '');
    if (!session) {
      setEntries([]);
      return;
    }
    setSelectedTarget(session.targetId);
    setSelectedModel(session.modelKey ?? '');

    setCompanyId(session.companyId ?? companyId);
    setPermissionMode(session.permissionMode);
    setWorkspace(session.workspace);
    setEntries(session.messages.map((message) => ({ role: message.role, text: message.text })));
    void coreChatClient
      .replayEvents({ sessionId: session.id })
      .then(setEvents)
      .catch(() => setEvents([]));
    const restoredState: RunState =
      session.status === 'running' || session.status === 'interrupted' ? 'cancelled' : session.status;
    setState(restoredState);
    setStatusText(session.lastError ?? t(`testing.core.sessionStatus.${session.status}`));
  };

  const forkActiveSession = async (): Promise<void> => {
    if (!activeSessionId || state === 'running') return;
    const forked = await coreChatClient.forkSession(activeSessionId);
    setSessions((previous) => [forked, ...previous]);
    setActiveSessionId(forked.id);
    rememberActiveSession(forked.id);
    setEntries(forked.messages.map((message) => ({ role: message.role, text: message.text })));
    setState('idle');
    setStatusText(t('testing.core.sessionForked'));
  };

  const loadTargets = async (): Promise<void> => {
    setLoadingTargets(true);
    setTargetError('');
    try {
      const next = await coreChatClient.listTargets();
      setTargets(next);
      setSelectedTarget((current) => (next.some((target) => target.id === current) ? current : (next[0]?.id ?? '')));
    } catch (error) {
      console.error('[CoreChatLab] Failed to load targets:', error);
      setTargets([]);
      setTargetError(t('testing.core.bridgeUnavailable'));
    } finally {
      setLoadingTargets(false);
    }
  };

  useEffect(() => {
    let disposed = false;
    void loadTargets();
    void (async () => {
      const activeRuns = await coreChatClient.listActiveRuns().catch((): CoreRunSnapshot[] => []);
      const nextSessions = await coreChatClient.listSessions().catch((): CoreSession[] => []);
      if (disposed) return;
      setSessions(nextSessions);

      const rememberedId = rememberedActiveSession();
      const active = activeRuns.find((run) => run.sessionId === rememberedId) ?? activeRuns[0];
      const session =
        nextSessions.find((candidate) => candidate.id === active?.sessionId) ??
        nextSessions.find((candidate) => candidate.id === rememberedId) ??
        nextSessions[0];
      if (!session) return;
      const replayedEvents =
        active?.events ?? (await coreChatClient.replayEvents({ sessionId: session.id }).catch((): CoreEvent[] => []));
      if (disposed) return;

      setActiveSessionId(session.id);
      rememberActiveSession(session.id);
      setSelectedTarget(session.targetId);
      setSelectedModel(session.modelKey ?? '');
      setCompanyId(session.companyId ?? companyId);
      setPermissionMode(session.permissionMode);
      setWorkspace(session.workspace);
      setEntries(recoveredEntries(session, active));

      if (active) {
        activeRequestRef.current = active.requestId;
        setEvents(active.events);
        setState('running');
        const lastStatus = active.events
          .toReversed()
          .find((event) => event.type === 'status' || event.type === 'thinking' || event.type === 'step');
        setStatusText(normalizeEventText(lastStatus?.text) || t('testing.core.running'));
        const pendingPermission = active.events
          .toReversed()
          .find((event) => event.permissionId && active.pendingPermissionIds.includes(event.permissionId));
        if (pendingPermission) showPermission(pendingPermission);
        return;
      }

      setEvents(replayedEvents);
      if (session.status === 'interrupted') {
        setState('running');
        setStatusText(t('testing.core.connecting'));
        try {
          const recoveryRequestId = crypto.randomUUID();
          activeRequestRef.current = recoveryRequestId;
          await coreChatClient.resumeInterrupted(session.id, recoveryRequestId);
          if (disposed) return;
        } catch (error) {
          if (disposed) return;
          setState('error');
          setStatusText(error instanceof Error ? error.message : t('testing.core.failed'));
        }
        return;
      }
      const restoredState: RunState = session.status === 'running' ? 'cancelled' : session.status;
      setState(restoredState);
      setStatusText(session.lastError ?? t('testing.core.sessionStatus.' + session.status));
    })();
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(
    () =>
      coreChatClient.onEvent((event) => {
        if (event.requestId !== activeRequestRef.current) return;
        setEvents((previous) =>
          previous.some((candidate) => candidate.sequence === event.sequence) ? previous : [...previous, event]
        );
        if (event.type === 'delta' && event.text !== undefined) {
          setEntries((previous) => {
            const next = [...previous];
            const last = next.at(-1);
            if (last?.role === 'assistant') {
              if (event.mode === 'replace' && event.text === '') next.pop();
              else {
                next[next.length - 1] = {
                  role: 'assistant',
                  text: event.mode === 'replace' ? event.text : last.text + event.text,
                };
              }
            } else if (event.text) {
              next.push({ role: 'assistant', text: event.text });
            }
            return next;
          });
        } else if (event.type === 'status' || event.type === 'thinking' || event.type === 'step') {
          setStatusText(normalizeEventText(event.text));
        } else if (event.type === 'tool-call') {
          const tool = normalizeEventText(event.tool);
          setStatusText(tool ? t('testing.core.toolRunning', { tool }) : normalizeEventText(event.text));
        } else if (event.type === 'tool-result') {
          const tool = normalizeEventText(event.tool) || t('testing.core.unknownTool');
          setStatusText(
            event.outcome === 'error'
              ? t('testing.core.toolFailed', { tool })
              : t('testing.core.toolCompleted', { tool })
          );
        } else if (
          event.type === 'orchestration-created' &&
          event.orchestrationKind === 'company' &&
          normalizeEventText(event.orchestrationId)
        ) {
          const orchestrationId = normalizeEventText(event.orchestrationId);
          const known = loadKnownCompanies();
          if (!known.includes(orchestrationId)) saveKnownCompanies([...known, orchestrationId]);
          setStatusText(normalizeEventText(event.text));
        } else if (event.type === 'permission' && event.permissionId) {
          showPermission(event);
        } else if (event.type === 'completed') {
          setState('completed');
          setStatusText(t('testing.core.completed'));
          activeRequestRef.current = null;
          setTimeout(() => void loadSessions(), 100);
        } else if (event.type === 'error') {
          setState('error');
          setStatusText(normalizeEventText(event.text) || t('testing.core.failed'));
          activeRequestRef.current = null;
          setTimeout(() => void loadSessions(), 100);
        } else if (event.type === 'cancelled') {
          setState('cancelled');
          setStatusText(t('testing.core.cancelled'));
          activeRequestRef.current = null;
          setTimeout(() => void loadSessions(), 100);
        }
      }),
    [t]
  );

  const options = useMemo(
    () =>
      KIND_ORDER.flatMap((kind) =>
        targets
          .filter((target) => target.kind === kind)
          .map((target) => ({
            value: target.id,
            label: `${kindLabel(kind)} \u00b7 ${target.name}`,
            disabled: !target.available,
          }))
      ),
    [targets, t]
  );

  const sessionOptions = useMemo(
    () =>
      sessions.map((session) => ({
        value: session.id,
        label: `${new Date(session.updatedAt).toLocaleString()} · ${t(`testing.core.sessionStatus.${session.status}`)}`,
      })),
    [sessions, t]
  );

  const permissionOptions = useMemo(
    () => [
      { value: 'read-only', label: t('testing.core.permissionReadOnly') },
      { value: 'workspace-write', label: t('testing.core.permissionWorkspaceWrite') },
      { value: 'full-access', label: t('testing.core.permissionFullAccess') },
    ],
    [t]
  );

  const selectPermissionMode = (value: CorePermissionMode): void => {
    if (value !== 'full-access') {
      setPermissionMode(value);
      return;
    }
    Modal.confirm({
      title: t('testing.core.fullAccessTitle'),
      content: t('testing.core.fullAccessWarning'),
      okText: t('testing.core.enableFullAccess'),
      cancelText: t('common.cancel'),
      okButtonProps: { status: 'danger' },
      onOk: () => setPermissionMode('full-access'),
    });
  };

  const activeTarget = useMemo(() => targets.find((target) => target.id === selectedTarget), [selectedTarget, targets]);
  const isCompanyTarget = selectedTarget === 'company';
  const companyOptions = useMemo(() => loadKnownCompanies().map((id) => ({ value: id, label: id })), [selectedTarget]);
  const thinkingText = useMemo(
    () =>
      events
        .filter((event) => event.type === 'thinking' && normalizeEventText(event.text))
        .map((event) => normalizeEventText(event.text))
        .join('\n\n'),
    [events]
  );
  const stepEvents = useMemo(
    () => events.filter((event) => event.type === 'step' || event.type === 'tool-call' || event.type === 'tool-result'),
    [events]
  );
  useEffect(() => {
    if (!selectedTarget || !workspace.trim()) return;
    let cancelled = false;
    setLoadingModels(true);
    void coreChatClient
      .listModels(selectedTarget, workspace.trim())
      .catch((): CoreTarget['models'] => [])
      .then((models) => {
        if (cancelled) return;
        setTargets((previous) =>
          previous.map((target) =>
            target.id === selectedTarget
              ? {
                  ...target,
                  models,
                  defaultModelKey: models.find((model) => model.isDefault)?.key ?? models[0]?.key,
                }
              : target
          )
        );
      })
      .finally(() => {
        if (!cancelled) setLoadingModels(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedTarget, workspace]);

  const modelOptions = useMemo(
    () => activeTarget?.models.map((model) => ({ value: model.key, label: model.label })) ?? [],
    [activeTarget]
  );

  useEffect(() => {
    const models = activeTarget?.models ?? [];
    setSelectedModel((current) =>
      models.some((model) => model.key === current) ? current : (activeTarget?.defaultModelKey ?? models[0]?.key ?? '')
    );
  }, [activeTarget]);

  const sendPrompt = async (): Promise<void> => {
    const text = prompt.trim();
    if (!text || !selectedTarget || !workspace.trim() || (isCompanyTarget && !companyId) || state === 'running') return;
    const requestId = crypto.randomUUID();
    activeRequestRef.current = requestId;
    setEntries((previous) => [...previous, { role: 'user', text }]);
    setEvents([]);
    setStepsExpanded(false);
    rememberActiveSession(activeSessionId);
    setState('running');
    setStatusText(t('testing.core.connecting'));
    setPrompt('');
    try {
      const started = await coreChatClient.start({
        requestId,
        sessionId: activeSessionId || undefined,
        targetId: selectedTarget,
        prompt: text,
        workspace: workspace.trim(),
        modelKey: selectedModel || undefined,
        companyId: isCompanyTarget ? companyId : undefined,
        surface: 'chat',
        agentId: 'tomny',
        personalId: 'default',
        permissionMode,
      });
      setActiveSessionId(started.sessionId);
      rememberActiveSession(started.sessionId);
    } catch (error) {
      activeRequestRef.current = null;
      setState('error');
      setStatusText(error instanceof Error ? error.message : t('testing.core.failed'));
    }
  };

  const cancel = async (): Promise<void> => {
    const requestId = activeRequestRef.current;
    if (!requestId) return;
    await coreChatClient.cancel(requestId).catch(() => false);
  };

  return (
    <div className='h-full min-h-0 flex flex-col gap-12px'>
      <div className='flex items-start justify-between gap-16px border border-border-base rd-8px bg-fill-1 p-14px'>
        <div className='flex gap-10px'>
          <span className='size-36px shrink-0 flex-center rd-8px bg-primary-light-1 text-primary'>
            <ExperimentOne theme='outline' size='19' />
          </span>
          <div>
            <h2 className='m-0 text-16px font-700 text-t-primary'>{t('testing.core.title')}</h2>
            <p className='m-0 mt-3px max-w-680px text-12px text-t-secondary'>{t('testing.core.subtitle')}</p>
          </div>
        </div>
        <Tag color='arcoblue'>{t('testing.core.transportNotice')}</Tag>
      </div>

      <div className='grid flex-1 min-h-0 grid-cols-[minmax(0,1fr)_280px] gap-12px'>
        <section className='min-h-0 flex flex-col border border-border-base rd-8px bg-bg-2'>
          <div className='flex flex-col gap-8px border-b border-border-base p-10px'>
            <div className='flex items-center gap-8px'>
              <Select
                className='min-w-0 flex-1'
                value={activeSessionId || undefined}
                options={sessionOptions}
                allowClear
                disabled={state === 'running'}
                placeholder={t('testing.core.newSession')}
                onChange={(value) => selectSession(value as string | undefined)}
                onClear={() => selectSession()}
              />
              <Button
                icon={<BranchOne theme='outline' />}
                disabled={!activeSessionId || state === 'running'}
                onClick={() => void forkActiveSession()}
              >
                {t('testing.core.forkSession')}
              </Button>
            </div>
            <div className='flex items-center gap-8px'>
              <Select
                className='min-w-0 flex-[3]'
                value={selectedTarget || undefined}
                options={options}
                loading={loadingTargets}
                disabled={state === 'running'}
                placeholder={t('testing.core.selectTarget')}
                onChange={setSelectedTarget}
              />
              <Select
                className='min-w-0 flex-[2]'
                value={selectedModel || undefined}
                options={modelOptions}
                loading={loadingModels}
                disabled={state === 'running' || modelOptions.length === 0}
                placeholder={modelOptions.length === 0 ? t('testing.core.agentDefault') : t('testing.core.selectModel')}
                onChange={setSelectedModel}
              />
              <Select
                className='min-w-0 flex-[2]'
                value={permissionMode}
                options={permissionOptions}
                disabled={state === 'running'}
                onChange={(value) => selectPermissionMode(value as CorePermissionMode)}
              />
              <Button icon={<Refresh theme='outline' />} onClick={() => void loadTargets()} loading={loadingTargets} />
            </div>
            {isCompanyTarget && (
              <Select
                value={companyId || undefined}
                options={companyOptions}
                disabled={state === 'running'}
                placeholder={companyOptions.length === 0 ? t('company.picker.empty') : t('company.picker.title')}
                onChange={setCompanyId}
              />
            )}
            <WorkspaceFolderSelect
              value={workspace}
              onChange={setWorkspace}
              onClear={() => setWorkspace('')}
              placeholder={t('testing.core.selectWorkspace')}
              input_placeholder={t('testing.core.workspacePlaceholder')}
              recentLabel={t('testing.core.recentWorkspaces')}
              chooseDifferentLabel={t('testing.core.chooseWorkspace')}
              triggerTestId='core-chat-workspace-trigger'
              menuTestId='core-chat-workspace-menu'
            />
          </div>

          <div className='flex-1 min-h-0 overflow-auto p-14px'>
            {loadingTargets ? (
              <div className='h-full flex-center'>
                <Spin />
              </div>
            ) : targetError ? (
              <div className='h-full flex flex-col items-center justify-center gap-10px'>
                <Empty description={targetError} />
                <Button icon={<Refresh theme='outline' />} onClick={() => void loadTargets()}>
                  {t('testing.core.retry')}
                </Button>
              </div>
            ) : targets.length === 0 ? (
              <Empty description={t('testing.core.noTargets')} />
            ) : entries.length === 0 ? (
              <div className='h-full flex-center text-center text-12px text-t-tertiary'>{t('testing.core.empty')}</div>
            ) : (
              <div className='flex flex-col gap-10px'>
                {(thinkingText || stepEvents.length > 0) && (
                  <div className='w-full max-w-[92%] self-start border border-border-base rd-8px bg-fill-1 p-10px'>
                    {thinkingText && (
                      <div>
                        <div className='mb-6px flex items-center justify-between gap-8px'>
                          <span className='text-11px font-600 text-t-primary'>{t('testing.core.thinking')}</span>
                          {state === 'running' && <Tag size='small'>{t('testing.core.running')}</Tag>}
                        </div>
                        <div className='max-h-96px overflow-auto whitespace-pre-wrap text-12px leading-18px text-t-secondary'>
                          {thinkingText}
                        </div>
                      </div>
                    )}
                    {stepEvents.length > 0 && (
                      <div className={thinkingText ? 'mt-8px border-t border-border-base pt-8px' : ''}>
                        <Button size='mini' type='text' onClick={() => setStepsExpanded((value) => !value)}>
                          {stepsExpanded ? t('testing.core.hideSteps') : t('testing.core.viewSteps')}
                        </Button>
                        {stepsExpanded && (
                          <div className='mt-6px max-h-160px overflow-auto'>
                            {stepEvents.map((event, index) => {
                              const body = eventBody(event);
                              return (
                                <div
                                  key={eventKey(event, index)}
                                  className='border-l-2 border-border-base py-5px pl-8px text-11px text-t-secondary'
                                >
                                  <div className='flex flex-wrap items-center gap-6px'>
                                    <span className='font-600 text-t-primary'>{eventLabel(event)}</span>
                                    {event.phase ? <Tag size='small'>{event.phase}</Tag> : null}
                                    {event.outcome ? <Tag size='small'>{event.outcome}</Tag> : null}
                                  </div>
                                  {body ? (
                                    <div className='mt-3px max-h-180px overflow-auto whitespace-pre-wrap break-words text-11px leading-17px text-t-secondary'>
                                      {body}
                                    </div>
                                  ) : null}
                                  {normalizeEventText(event.workspace) ? (
                                    <div className='mt-3px break-words text-10px text-t-tertiary'>
                                      {t('testing.core.toolWorkspace', {
                                        workspace: normalizeEventText(event.workspace),
                                      })}
                                    </div>
                                  ) : null}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
                {entries.map((entry, index) => (
                  <div
                    key={`${entry.role}-${index}`}
                    className={`max-w-[82%] whitespace-pre-wrap rd-8px px-12px py-9px text-13px leading-20px ${
                      entry.role === 'user'
                        ? 'self-end bg-primary text-color-white'
                        : 'self-start border border-border-base bg-fill-1 text-t-primary'
                    }`}
                  >
                    {entry.text}
                  </div>
                ))}
                {state === 'running' && !entries.some((entry) => entry.role === 'assistant') && <Spin size={16} />}
              </div>
            )}
          </div>

          <div className='border-t border-border-base p-10px'>
            <Input.TextArea
              value={prompt}
              autoSize={{ minRows: 2, maxRows: 5 }}
              placeholder={t('testing.core.promptPlaceholder')}
              disabled={state === 'running'}
              onChange={setPrompt}
            />
            <div className='mt-8px flex items-center justify-between gap-8px'>
              <span className='truncate text-11px text-t-tertiary'>{statusText || t('testing.core.ready')}</span>
              {state === 'running' ? (
                <Button status='warning' icon={<PauseOne theme='outline' />} onClick={() => void cancel()}>
                  {t('testing.core.stop')}
                </Button>
              ) : (
                <Button
                  type='primary'
                  icon={<Send theme='outline' />}
                  disabled={!prompt.trim() || !selectedTarget || !workspace.trim() || (isCompanyTarget && !companyId)}
                  onClick={() => void sendPrompt()}
                >
                  {t('testing.core.send')}
                </Button>
              )}
            </div>
          </div>
        </section>

        <aside className='min-h-0 flex flex-col border border-border-base rd-8px bg-fill-1 p-10px'>
          <div className='mb-8px flex items-center justify-between'>
            <span className='text-12px font-600 text-t-primary'>{t('testing.core.events')}</span>
            <Tag size='small'>{events.length}</Tag>
          </div>
          <div className='flex-1 min-h-0 overflow-auto'>
            {events.length === 0 ? (
              <Empty description={t('testing.core.noEvents')} />
            ) : (
              <div className='flex flex-col gap-6px'>
                {events.map((event, index) => (
                  <div key={eventKey(event, index)} className='border-l-2 border-primary pl-8px'>
                    <div className='flex items-center justify-between gap-6px'>
                      <span className='text-11px font-600 text-t-primary'>{event.type}</span>
                      <span className='text-10px text-t-tertiary'>
                        {new Date(eventTimestamp(event)).toLocaleTimeString()}
                      </span>
                    </div>
                    {eventBody(event) && (
                      <p className='m-0 mt-2px max-h-72px overflow-auto whitespace-pre-wrap break-words text-10px leading-15px text-t-secondary'>
                        {eventBody(event)}
                      </p>
                    )}
                    {normalizeEventText(event.workspace) && (
                      <p className='m-0 mt-1px break-words text-10px text-t-tertiary'>
                        {t('testing.core.toolWorkspace', { workspace: normalizeEventText(event.workspace) })}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
};

export default CoreChatLab;

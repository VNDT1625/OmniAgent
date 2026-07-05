/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `IdeChatPanel` — the IDE workspace's "Chat" mode body. Replaces the previous
 * weak in-IDE Ask + Agent panels with the MAIN conversation/CLI-agent system.
 *
 * Each tab in the strip is a real conversation pinned to the IDE's open folder
 * (`extra.workspace = rootPath`), so a CLI agent (Claude Code / Codex / Gemini …)
 * runs with that folder as its cwd and can read every subdirectory. The body
 * embeds {@link ChatConversation} for the active tab — the same component that
 * renders the routed `/conversation/:id` page — so the IDE chat is functionally
 * identical to the main chat (full feature set, send box, preview, etc.) and
 * the conversation also shows up in the global sidebar history.
 *
 * Multi-tab = multiple parallel agents working on the same folder. The "+" menu
 * lists the user's detected CLI agents and preset assistants and opens a fresh
 * conversation per click. Tab ids persist per `rootPath` (see `useIdeChat`) so
 * reopening the same folder restores the strip.
 *
 * Renderer-only; Arco + icon-park + UnoCSS tokens; all text via i18n.
 */

import { Button, Dropdown, Empty, Input, Menu, Spin, Switch, Tooltip } from '@arco-design/web-react';
import {
  Brain,
  Check,
  CheckOne,
  CloseSmall,
  Down,
  FileCode,
  FolderClose,
  Plus,
  Right,
  Robot,
  Search,
  Shield,
} from '@icon-park/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import type { TChatConversation } from '@/common/config/storage';
import type { MtuiPolicyViolation } from '@process/terminal/mtuiPolicy';
import { useConversationAgents } from '@/renderer/pages/conversation/hooks/useConversationAgents';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import ChatConversation from '@/renderer/pages/conversation/components/ChatConversation';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { useAddEventListener } from '@/renderer/utils/emitter';
import {
  ideClient,
  type SpecApprovalGate,
  type SpecLifecyclePhase,
  type SpecLifecycleStatus,
  type SpecListEntry,
  type SpecTaskRunbook,
} from '../ideClient';
import { useIdeChat, type IdeChatTab } from '../useIdeChat';
import type { CloudWorkspaceConnection } from '../teamEdit/cloud/useCloudWorkspace';
import MemorySessionDrawer from '../memory/MemorySessionDrawer';
import {
  enforceStrictIdeSessionMode,
  isStrictIdeModeEnabled,
  setStrictIdeModeEnabled,
} from '@/renderer/pages/conversation/platforms/strictIdeModeGuard';

type IdeChatPanelProps = {
  rootPath: string | null;
  /** Absolute path of the file open in the Files-mode editor, or null. */
  activeFile: string | null;
  /** Relative file paths in the repo (from the import graph), for @-mention. */
  repoFiles: string[];
  /** Cloud session when the IDE is mounted from a cloud-authoritative workspace. */
  cloudWorkspace?: CloudWorkspaceConnection | null;
};

const IdeChatPanel: React.FC<IdeChatPanelProps> = ({ rootPath, activeFile, repoFiles, cloudWorkspace }) => {
  const { t, i18n } = useTranslation();
  const cloudChatWorkspace = useMemo(
    () =>
      cloudWorkspace?.cachePath && cloudWorkspace.remoteMcpServer
        ? {
            workspaceId: cloudWorkspace.workspaceId,
            relayBaseUrl: cloudWorkspace.relayBaseUrl,
            cachePath: cloudWorkspace.cachePath,
            remoteMcpServer: cloudWorkspace.remoteMcpServer,
          }
        : null,
    [cloudWorkspace]
  );
  const chat = useIdeChat(rootPath, { cloudWorkspace: cloudChatWorkspace });
  const { cliAgents, presetAssistants, isLoading: loadingAgents } = useConversationAgents();
  const { addToSendBox, activeTab } = usePreviewContext();

  // Open the agent menu — defer building it until the user actually opens it,
  // so a slow `assistants.list` does not block the initial render.
  const [pickerOpen, setPickerOpen] = useState(false);
  // Session-memory drawer (per active tab).
  const [memoryOpen, setMemoryOpen] = useState(false);
  // Strict IDE Mode: hard-deny any non-`ide_*` tool call (per workspace).
  const [strictMode, setStrictMode] = useState(false);
  useEffect(() => {
    setStrictMode(isStrictIdeModeEnabled(rootPath ?? undefined));
  }, [rootPath]);
  useEffect(() => {
    if (!rootPath || !cloudWorkspace) return;
    setStrictIdeModeEnabled(rootPath, true);
    setStrictMode(true);
  }, [cloudWorkspace, rootPath]);
  const toggleStrictMode = (enabled: boolean): void => {
    if (!rootPath) return;
    setStrictIdeModeEnabled(rootPath, enabled);
    setStrictMode(enabled);
  };
  useEffect(() => {
    if (!strictMode) return;
    for (const tab of chat.tabs) void enforceStrictIdeSessionMode(tab.id);
  }, [chat.tabs, strictMode]);
  const activeMemId = useMemo(
    () => chat.tabs.find((tab) => tab.id === chat.activeId)?.memId ?? null,
    [chat.tabs, chat.activeId]
  );

  // Default tab: when no tab is open and at least one agent exists, do nothing
  // (the user explicitly picks). A click on "+" opens a tab with the chosen
  // agent. This avoids creating empty conversations the user did not ask for.

  const noFolder = !rootPath;

  /** Normalise an absolute path to a repo-relative, forward-slash path. */
  const toRel = (abs: string): string => {
    if (!rootPath) return abs.replace(/\\/g, '/');
    const root = rootPath.replace(/[\\/]+$/, '');
    if (abs.startsWith(root + '/') || abs.startsWith(root + '\\')) {
      return abs.slice(root.length + 1).replace(/\\/g, '/');
    }
    return abs.replace(/\\/g, '/');
  };

  // The file to offer as one-click context. Prefer the file currently OPEN IN
  // THE CHAT's preview pane (what the user is actually looking at while
  // chatting), then fall back to the file open in Files mode. The preview tab
  // carries the workspace file path in its metadata.
  const activeRelPath = useMemo<string | null>(() => {
    const meta = activeTab?.metadata;
    const previewPath = meta?.file_path || meta?.file_name;
    if (previewPath) return toRel(previewPath);
    if (activeTab?.title && /\.[a-z0-9]+$/i.test(activeTab.title)) return activeTab.title;
    if (activeFile) return toRel(activeFile);
    return null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, activeFile, rootPath]);

  /**
   * Insert an `@<relPath>` mention into the active tab's composer. Mirrors
   * Cursor's `@file` — pinning a file as ground-truth context for the next
   * turn. Used both by the active-file chip and the manual mention picker.
   */
  const insertMention = (relPath: string): void => {
    if (!relPath || !chat.activeId) return;
    addToSendBox(`@${relPath} `);
  };

  // An IDE Agent Hook with the `askAgent` action fired: drop its prompt into the
  // active chat composer. If no tab is open yet, open one with the first CLI
  // agent (or preset assistant) and then fill the composer once it mounts.
  useAddEventListener(
    'ide.hook.askAgent',
    (payload) => {
      if (!rootPath || payload.rootPath !== rootPath) return;
      const fill = (): void => addToSendBox(payload.prompt);
      if (chat.activeId) {
        fill();
        return;
      }
      const launcher = cliAgents.find((a) => a.available !== false)
        ? ({ kind: 'cli', agent: cliAgents.find((a) => a.available !== false)! } as const)
        : presetAssistants.find((a) => a.enabled !== false)
          ? ({
              kind: 'preset',
              assistant: presetAssistants.find((a) => a.enabled !== false)!,
              language: i18n.language,
            } as const)
          : null;
      if (!launcher) return;
      void chat.open(launcher).then((id) => {
        // Defer until the new tab's composer mounts.
        if (id) setTimeout(fill, 400);
      });
    },
    [rootPath, chat.activeId, cliAgents, presetAssistants, i18n.language]
  );

  return (
    <div className='size-full flex flex-col min-h-0 bg-1'>
      <ChatTabStrip
        tabs={chat.tabs}
        activeId={chat.activeId}
        creating={chat.creating}
        onSelect={chat.setActive}
        onClose={(id) => void chat.close(id)}
        rightActions={
          <div className='flex items-center gap-8px'>
            <Tooltip content={t('ide.memory.tooltip')} mini>
              <Button
                size='small'
                icon={<Brain theme='outline' size={14} />}
                disabled={!chat.activeId}
                onClick={() => setMemoryOpen(true)}
              >
                {t('ide.memory.button')}
              </Button>
            </Tooltip>
            <Tooltip content={t('ide.chat.planningHint')} mini>
              <span className='inline-flex items-center gap-6px px-8px py-4px rd-8px bg-fill-1 border border-arco-2'>
                <span className='text-12px font-500 text-t-secondary'>{t('ide.chat.planning')}</span>
                <Switch
                  size='small'
                  checked={chat.planningEnabled}
                  disabled={noFolder}
                  onChange={chat.setPlanningEnabled}
                />
              </span>
            </Tooltip>
            <Tooltip content={t('ide.chat.strictModeHint')} mini>
              <span className='inline-flex items-center gap-6px px-8px py-4px rd-8px bg-fill-1 border border-arco-2'>
                <Shield theme='outline' size={13} />
                <span className='text-12px font-500 text-t-secondary'>{t('ide.chat.strictMode')}</span>
                <Switch size='small' checked={strictMode} disabled={noFolder} onChange={toggleStrictMode} />
              </span>
            </Tooltip>
            <Dropdown
              position='br'
              popupVisible={pickerOpen}
              onVisibleChange={setPickerOpen}
              trigger='click'
              droplist={
                <AgentMenu
                  cliAgents={cliAgents}
                  presetAssistants={presetAssistants}
                  language={i18n.language}
                  loading={loadingAgents}
                  disabled={noFolder || chat.creating}
                  onPick={async (launcher) => {
                    setPickerOpen(false);
                    await chat.open(launcher);
                  }}
                />
              }
            >
              <Tooltip content={noFolder ? t('ide.chat.noFolder') : t('ide.chat.newTab')} mini>
                <Button
                  type='primary'
                  size='small'
                  loading={chat.creating}
                  disabled={noFolder}
                  icon={<Plus theme='outline' size={14} />}
                >
                  {t('ide.chat.newTab')}
                </Button>
              </Tooltip>
            </Dropdown>
          </div>
        }
      />

      {chat.planningEnabled && rootPath ? <PlanningStatusBar rootPath={rootPath} /> : null}

      {chat.activeId ? (
        <ActiveFileBar
          relPath={activeRelPath}
          repoFiles={repoFiles}
          onAttachActive={() => activeRelPath && insertMention(activeRelPath)}
          onPickMention={insertMention}
        />
      ) : null}

      <div className='flex-1 min-h-0 relative'>
        {noFolder ? (
          <ChatEmpty
            icon={<FolderClose theme='outline' size={28} />}
            title={t('ide.chat.noFolderTitle')}
            hint={t('ide.chat.noFolderHint')}
          />
        ) : chat.tabs.length === 0 ? (
          <ChatEmpty
            icon={<Robot theme='outline' size={28} />}
            title={t('ide.chat.emptyTitle')}
            hint={t('ide.chat.emptyHint')}
          />
        ) : (
          // Mount one ChatConversation per tab; only the active one is visible.
          // Keeping inactive tabs MOUNTED preserves their composer state and
          // streaming AI work while the user toggles tabs.
          chat.tabs.map((tab) => (
            <ChatTabBody
              key={tab.id}
              tab={tab}
              active={chat.activeId === tab.id}
              onResolveTitle={(title) => chat.rename(tab.id, title)}
            />
          ))
        )}
      </div>

      <MemorySessionDrawer memId={activeMemId} visible={memoryOpen} onClose={() => setMemoryOpen(false)} />
    </div>
  );
};

const executeCommandFor = (slug?: string): string => (slug ? `/execute @.omni/specs/${slug}/ ` : '/execute @');

/** The approval gate the user can act on while in a given phase (null = none). */
const gateForPhase = (phase: SpecLifecyclePhase | null): SpecApprovalGate | null =>
  phase === 'requirements' || phase === 'design' || phase === 'tasks' ? phase : null;

/**
 * Planning Mode status bar — the spec lifecycle command center for the IDE chat.
 *
 * Unlike the previous version (which silently surfaced whichever spec was
 * touched most recently), this binds to the workspace's EXPLICIT active spec.
 * It lets the user pick/clear the active spec, shows the Kiro-style lifecycle
 * phase, gates `/execute` behind phase approvals, and surfaces the MTUI policy
 * state — so planning is observable and deliberate, never accidental.
 */
const PlanningStatusBar: React.FC<{ rootPath: string }> = ({ rootPath }) => {
  const { t } = useTranslation();
  const { addToSendBox } = usePreviewContext();
  const [status, setStatus] = useState<SpecLifecycleStatus | null>(null);
  const [specs, setSpecs] = useState<SpecListEntry[]>([]);
  const [runbook, setRunbook] = useState<SpecTaskRunbook | null>(null);
  const [mtuiViolations, setMtuiViolations] = useState<MtuiPolicyViolation[]>([]);
  const [mtuiViolationCount, setMtuiViolationCount] = useState(0);
  const [busy, setBusy] = useState(false);

  const refresh = React.useCallback(async (): Promise<void> => {
    const result = await ideClient.specStatus(rootPath).catch((): null => null);
    if (result?.ok) {
      setStatus(result.data);
      const tasksResult = result.data.exists
        ? await ideClient.specTaskList(rootPath, result.data.slug ?? undefined).catch((): null => null)
        : null;
      setRunbook(tasksResult?.ok ? tasksResult.data : null);
    }
    const listResult = await ideClient.specList(rootPath).catch((): null => null);
    if (listResult?.ok) setSpecs(listResult.data);
    const gitResult = await ideClient.gitStatus(rootPath).catch((): null => null);
    const changedPaths = gitResult?.ok ? gitResult.data.map((change) => change.path) : [];
    if (changedPaths.length === 0) {
      setMtuiViolations([]);
      setMtuiViolationCount(0);
      return;
    }
    const policyResult = await ideClient.mtuiPolicyCheck(rootPath, changedPaths).catch((): null => null);
    const policy = policyResult?.ok ? policyResult.data : null;
    setMtuiViolations(policy?.violations ?? []);
    setMtuiViolationCount(policy?.violationCount ?? policy?.violations.length ?? 0);
  }, [rootPath]);

  useEffect(() => {
    let cancelled = false;
    const tick = (): void => {
      if (!cancelled) void refresh();
    };
    tick();
    const timer = window.setInterval(tick, 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [refresh]);

  const createScaffold = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const rootName =
        rootPath
          .replace(/[\\/]+$/, '')
          .split(/[\\/]/)
          .pop() || 'planning';
      const result = await ideClient.specInit(rootPath, rootName);
      if (result.ok) setStatus(result.data);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const setActiveSpec = async (slug: string | null): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await ideClient.specSetActive(rootPath, slug);
      if (result.ok) setStatus(result.data);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const approveGate = async (gate: SpecApprovalGate): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const result = await ideClient.specAdvancePhase(rootPath, gate, status?.slug ?? undefined);
      if (result.ok) setStatus(result.data);
      await refresh();
    } finally {
      setBusy(false);
    }
  };

  const phase = status?.exists ? status.phase : null;
  const activeGate = gateForPhase(phase);
  const canExecute = phase === 'execution' || phase === 'complete';

  const specSwitcherMenu = (
    <Menu>
      {specs.length > 0 ? (
        specs.map((spec) => (
          <Menu.Item key={spec.slug} onClick={() => void setActiveSpec(spec.active ? null : spec.slug)}>
            <div className='flex items-center gap-8px min-w-220px'>
              {spec.active ? (
                <Check theme='outline' size={13} className='text-primary shrink-0' />
              ) : (
                <span className='size-13px shrink-0' />
              )}
              <div className='flex flex-col flex-1 min-w-0'>
                <span className='text-12px font-600 truncate'>{spec.title}</span>
                <span className='text-11px text-t-tertiary truncate'>
                  {`.omni/specs/${spec.slug}/`}
                  {` · ${t(`ide.chat.planningStatus.phase.${spec.phase}`)}`}
                </span>
              </div>
            </div>
          </Menu.Item>
        ))
      ) : (
        <Menu.Item key='none' disabled>
          {t('ide.chat.planningStatus.noSpecsYet')}
        </Menu.Item>
      )}
      <Menu.Item key='__create' onClick={() => void createScaffold()}>
        <span className='inline-flex items-center gap-6px text-primary'>
          <Plus theme='outline' size={13} />
          {t('ide.chat.planningStatus.create')}
        </span>
      </Menu.Item>
      {status?.exists ? (
        <Menu.Item key='__clear' onClick={() => void setActiveSpec(null)}>
          {t('ide.chat.planningStatus.clearActive')}
        </Menu.Item>
      ) : null}
    </Menu>
  );

  const mtuiPolicyMenu = (
    <Menu>
      {mtuiViolationCount > 0 ? (
        <>
          <Menu.Item key='summary' disabled>
            {t('ide.chat.planningStatus.mtuiViolationSummary', { count: mtuiViolationCount })}
          </Menu.Item>
          {mtuiViolations.slice(0, 8).map((violation) => (
            <Menu.Item key={violation.path} disabled>
              <div className='flex flex-col min-w-220px max-w-360px'>
                <span className='text-12px font-600 truncate'>{violation.path}</span>
                <span className='text-11px text-t-tertiary truncate'>{violation.reason}</span>
              </div>
            </Menu.Item>
          ))}
          <Menu.Item key='history' onClick={() => addToSendBox(t('ide.chat.planningStatus.mtuiResolvePrompt'))}>
            {t('ide.chat.planningStatus.mtuiHistory')}
          </Menu.Item>
        </>
      ) : (
        <Menu.Item key='ok' disabled>
          {t('ide.chat.planningStatus.mtuiOkHint')}
        </Menu.Item>
      )}
    </Menu>
  );

  return (
    <PlanningStatusBarView
      t={t}
      status={status}
      phase={phase}
      activeGate={activeGate}
      canExecute={canExecute}
      busy={busy}
      runbook={runbook}
      mtuiViolationCount={mtuiViolationCount}
      specSwitcherMenu={specSwitcherMenu}
      mtuiPolicyMenu={mtuiPolicyMenu}
      onApprove={approveGate}
      onExecute={() => status?.slug && addToSendBox(executeCommandFor(status.slug))}
    />
  );
};

/** Human label + tone for the lifecycle phase chip. */
const phaseTone = (phase: SpecLifecyclePhase): string => {
  if (phase === 'complete') return 'text-success-6 bg-success-light-1 border-success-3';
  if (phase === 'execution') return 'text-primary bg-primary-light-1 border-primary-6';
  return 'text-warning-6 bg-warning-light-1 border-warning-3';
};

type PlanningStatusBarViewProps = {
  t: (key: string, opts?: Record<string, unknown>) => string;
  status: SpecLifecycleStatus | null;
  phase: SpecLifecyclePhase | null;
  activeGate: SpecApprovalGate | null;
  canExecute: boolean;
  busy: boolean;
  runbook: SpecTaskRunbook | null;
  mtuiViolationCount: number;
  specSwitcherMenu: React.ReactNode;
  mtuiPolicyMenu: React.ReactNode;
  onApprove: (gate: SpecApprovalGate) => void;
  onExecute: () => void;
};

/** Pure presentational layer of the planning bar (kept testable + lean). */
const PlanningStatusBarView: React.FC<PlanningStatusBarViewProps> = ({
  t,
  status,
  phase,
  activeGate,
  canExecute,
  busy,
  runbook,
  mtuiViolationCount,
  specSwitcherMenu,
  mtuiPolicyMenu,
  onApprove,
  onExecute,
}) => {
  const exists = Boolean(status?.exists);
  const total = status?.taskCounts.total ?? 0;
  const done = status?.taskCounts.done ?? 0;
  const activeTask = runbook?.tasks.find((task) => task.id === runbook.activeTaskId) ?? null;
  const nextTask = runbook?.tasks.find((task) => task.id === runbook.nextTaskId) ?? null;
  const taskLabel = activeTask
    ? `${activeTask.id}: ${activeTask.title}`
    : nextTask
      ? `${nextTask.id}: ${nextTask.title}`
      : null;

  return (
    <div className='shrink-0 flex items-center gap-8px px-12px py-7px border-b border-b-1 bg-fill-1'>
      <FileCode theme='outline' size={14} className='text-primary shrink-0' />
      <div className='flex-1 min-w-0 flex flex-col gap-2px'>
        <div className='flex items-center gap-8px min-w-0'>
          <span className='text-12px font-600 text-t-primary shrink-0'>{t('ide.chat.planningStatus.title')}</span>
          {exists && phase ? (
            <span
              className={`inline-flex items-center gap-3px shrink-0 px-6px py-1px rd-full border text-10px font-600 ${phaseTone(phase)}`}
            >
              {t(`ide.chat.planningStatus.phase.${phase}`)}
            </span>
          ) : null}
          <Dropdown droplist={specSwitcherMenu} trigger='click' position='bl'>
            <span
              role='button'
              tabIndex={0}
              className='inline-flex items-center gap-4px min-w-0 text-12px text-t-secondary cursor-pointer hover:text-primary transition-colors'
            >
              <span className='truncate'>
                {status?.slug ? `.omni/specs/${status.slug}/` : t('ide.chat.planningStatus.noActiveSpec')}
              </span>
              <Down theme='outline' size={11} className='shrink-0' />
            </span>
          </Dropdown>
        </div>
        <span className='text-11px text-t-tertiary truncate'>
          {exists ? t(`ide.chat.planningStatus.phaseHint.${phase}`) : t('ide.chat.planningStatus.noActiveHint')}
          {exists && total > 0 ? ` · ${t('ide.chat.planningStatus.tasks', { done, total })}` : ''}
          {canExecute && taskLabel ? ` · ${taskLabel}` : ''}
        </span>
      </div>
      {!exists ? (
        <Dropdown droplist={specSwitcherMenu} trigger='click' position='br'>
          <Button size='mini' type='secondary' loading={busy} icon={<Plus theme='outline' size={12} />}>
            {t('ide.chat.planningStatus.startPlanning')}
          </Button>
        </Dropdown>
      ) : (
        <div className='shrink-0 flex items-center gap-6px'>
          <Dropdown droplist={mtuiPolicyMenu} trigger='click' position='br'>
            <Button
              size='mini'
              type={mtuiViolationCount > 0 ? 'primary' : 'secondary'}
              status={mtuiViolationCount > 0 ? 'danger' : undefined}
              icon={<Shield theme='outline' size={12} />}
            >
              {mtuiViolationCount > 0
                ? t('ide.chat.planningStatus.mtuiViolation', { count: mtuiViolationCount })
                : t('ide.chat.planningStatus.mtuiOk')}
            </Button>
          </Dropdown>
          {activeGate ? (
            <Button
              size='mini'
              type='primary'
              loading={busy}
              icon={<CheckOne theme='outline' size={12} />}
              onClick={() => onApprove(activeGate)}
            >
              {t(`ide.chat.planningStatus.approve.${activeGate}`)}
            </Button>
          ) : (
            <Tooltip content={canExecute ? undefined : t('ide.chat.planningStatus.executeLocked')} mini>
              <Button size='mini' type='primary' disabled={!canExecute} onClick={onExecute}>
                <span className='inline-flex items-center gap-4px'>
                  {t('ide.chat.planningStatus.execute')}
                  <Right theme='outline' size={11} />
                </span>
              </Button>
            </Tooltip>
          )}
        </div>
      )}
    </div>
  );
};

/** The tab strip across the top: list + close + a right-side action slot. */
const ChatTabStrip: React.FC<{
  tabs: IdeChatTab[];
  activeId: string | null;
  creating: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  rightActions: React.ReactNode;
}> = ({ tabs, activeId, creating, onSelect, onClose, rightActions }) => {
  return (
    <div className='shrink-0 flex items-center gap-6px px-12px py-8px border-b border-b-1'>
      <div className='flex-1 min-w-0 flex items-center gap-6px overflow-x-auto'>
        {tabs.map((tab) => {
          const active = activeId === tab.id;
          return (
            <span
              key={tab.id}
              role='button'
              tabIndex={0}
              onClick={() => onSelect(tab.id)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSelect(tab.id);
              }}
              className={`group inline-flex items-center gap-6px shrink-0 max-w-200px px-10px py-5px rd-8px cursor-pointer transition-colors ${active ? 'bg-primary-light-1 text-primary' : 'bg-transparent text-t-secondary hover:bg-fill-2'}`}
            >
              <Robot theme='outline' size={13} />
              <span className='truncate text-13px font-500' title={tab.title}>
                {tab.title}
              </span>
              <button
                type='button'
                aria-label='close'
                className='flex-center size-16px rd-full text-t-tertiary hover:bg-fill-3 hover:text-t-primary border-none bg-transparent cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity'
                onClick={(e) => {
                  e.stopPropagation();
                  onClose(tab.id);
                }}
              >
                <CloseSmall theme='outline' size={12} />
              </button>
            </span>
          );
        })}
        {creating ? <Spin size={14} className='shrink-0' /> : null}
      </div>
      <div className='shrink-0'>{rightActions}</div>
    </div>
  );
};

/** Empty/no-folder placeholder. */
const ChatEmpty: React.FC<{ icon: React.ReactNode; title: string; hint: string }> = ({ icon, title, hint }) => (
  <div className='size-full flex-center'>
    <Empty
      icon={<span className='size-56px flex-center rd-16px bg-primary-light-1 text-primary'>{icon}</span>}
      description={
        <div className='flex flex-col gap-6px max-w-440px text-center'>
          <span className='text-15px font-600 text-t-primary'>{title}</span>
          <span className='text-13px text-t-secondary leading-relaxed'>{hint}</span>
        </div>
      }
    />
  </div>
);

/**
 * `ActiveFileBar` — a thin strip above the chat that gives the agent file
 * context, the lightweight counterpart to Cursor's `@file`:
 *
 *  - the file currently open in Files mode, as a one-click "attach" chip, and
 *  - an **@ Reference** button opening a searchable file picker (sourced from
 *    the repo's import graph) so the user can pin ANY file, not just the open
 *    one. Both insert `@<relPath>` into the active tab's composer via
 *    `addToSendBox`.
 *
 * Hidden when no tab exists. Shows just the Reference button when no file is
 * open in the editor.
 */
const ActiveFileBar: React.FC<{
  relPath: string | null;
  repoFiles: string[];
  onAttachActive: () => void;
  onPickMention: (relPath: string) => void;
}> = ({ relPath, repoFiles, onAttachActive, onPickMention }) => {
  const { t } = useTranslation();
  const fileName = useMemo(() => {
    if (!relPath) return null;
    const parts = relPath.split('/');
    return parts[parts.length - 1] || relPath;
  }, [relPath]);
  return (
    <div className='shrink-0 flex items-center gap-8px px-12px py-6px border-b border-b-1 bg-fill-1'>
      <span className='shrink-0 text-11px font-600 uppercase tracking-wide text-t-tertiary'>
        {t('ide.chat.contextLabel')}
      </span>
      {relPath && fileName ? (
        <Tooltip content={relPath} mini>
          <span
            role='button'
            tabIndex={0}
            onClick={onAttachActive}
            onKeyDown={(e) => {
              if (e.key === 'Enter') onAttachActive();
            }}
            className='inline-flex items-center gap-6px max-w-280px px-8px py-3px rd-6px bg-2 border border-arco-2 cursor-pointer hover:border-primary hover:bg-primary-light-1 transition-colors'
          >
            <span className='truncate text-12px font-500 text-t-primary' title={relPath}>
              {fileName}
            </span>
            <span className='shrink-0 text-10px text-t-tertiary'>{t('ide.chat.attachFile')}</span>
          </span>
        </Tooltip>
      ) : null}
      <div className='flex-1' />
      <MentionPicker repoFiles={repoFiles} onPick={onPickMention} />
    </div>
  );
};

/** The "@ Reference" file picker: search the repo's files and insert a mention. */
const MentionPicker: React.FC<{ repoFiles: string[]; onPick: (relPath: string) => void }> = ({ repoFiles, onPick }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  // Rank files by a simple substring match on the path; cap the list so a huge
  // repo stays responsive in the popup.
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pool = repoFiles;
    if (!q) return pool.slice(0, 50);
    const scored = pool
      .filter((p) => p.toLowerCase().includes(q))
      .toSorted((a, b) => {
        // Prefer a basename match, then shorter path.
        const aBase = a.toLowerCase().split('/').pop() ?? a;
        const bBase = b.toLowerCase().split('/').pop() ?? b;
        const aHit = aBase.includes(q) ? 0 : 1;
        const bHit = bBase.includes(q) ? 0 : 1;
        if (aHit !== bHit) return aHit - bHit;
        return a.length - b.length;
      });
    return scored.slice(0, 50);
  }, [query, repoFiles]);

  const droplist = (
    <div className='w-360px max-w-[80vw] bg-2 border border-arco-2 rd-8px shadow-md overflow-hidden'>
      <div className='p-8px border-b border-b-1'>
        <Input
          autoFocus
          size='small'
          placeholder={t('ide.chat.mentionSearch')}
          value={query}
          onChange={setQuery}
          prefix={<Search theme='outline' size={13} />}
          allowClear
        />
      </div>
      <div className='max-h-300px overflow-y-auto py-4px'>
        {results.length === 0 ? (
          <div className='px-12px py-16px text-center text-12px text-t-tertiary'>{t('ide.chat.mentionEmpty')}</div>
        ) : (
          results.map((file) => {
            const base = file.split('/').pop() ?? file;
            return (
              <button
                key={file}
                type='button'
                onClick={() => {
                  onPick(file);
                  setOpen(false);
                  setQuery('');
                }}
                className='w-full flex items-center gap-8px px-12px py-6px cursor-pointer border-none bg-transparent text-left hover:bg-fill-2 transition-colors'
              >
                <span className='shrink-0 text-12px font-500 text-t-primary'>{base}</span>
                <span className='truncate text-10px text-t-tertiary' title={file}>
                  {file}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );

  return (
    <Dropdown popupVisible={open} onVisibleChange={setOpen} trigger='click' droplist={droplist} position='br'>
      <Button type='text' size='mini' className='!text-t-secondary' disabled={repoFiles.length === 0}>
        {t('ide.chat.mention')}
      </Button>
    </Dropdown>
  );
};

/**
 * Mount + embed `<ChatConversation>` for one tab. The conversation object is
 * fetched via the same SWR cache the routed `/conversation/:id` page uses, so
 * a tab share its underlying state with the main chat surface.
 */
const ChatTabBody: React.FC<{
  tab: IdeChatTab;
  active: boolean;
  onResolveTitle: (title: string) => void;
}> = ({ tab, active, onResolveTitle }) => {
  const { data, isLoading } = useSWR<TChatConversation | null>(`conversation/${tab.id}`, () =>
    getConversationOrNull(tab.id)
  );

  // Sync the tab title with the conversation name (auto-titled by the chat
  // history syncer); falls back to the launcher title until that lands.
  useEffect(() => {
    if (data?.name && data.name !== tab.title) onResolveTitle(data.name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.name]);

  return (
    <div className='absolute inset-0' style={{ display: active ? 'block' : 'none' }} aria-hidden={!active}>
      {isLoading || !data ? (
        <div className='size-full flex-center'>
          <Spin />
        </div>
      ) : (
        <ChatConversation conversation={data} />
      )}
    </div>
  );
};

/** The "+" dropdown menu — CLI agents + preset assistants. */
const AgentMenu: React.FC<{
  cliAgents: ReturnType<typeof useConversationAgents>['cliAgents'];
  presetAssistants: ReturnType<typeof useConversationAgents>['presetAssistants'];
  language: string;
  loading: boolean;
  disabled: boolean;
  onPick: (launcher: import('../useIdeChat').IdeChatLauncher) => void | Promise<void>;
}> = ({ cliAgents, presetAssistants, language, loading, disabled, onPick }) => {
  const { t } = useTranslation();
  const cliItems = useMemo(() => cliAgents.filter((agent) => agent.available !== false), [cliAgents]);
  const presetItems = useMemo(
    () => presetAssistants.filter((assistant) => assistant.enabled !== false),
    [presetAssistants]
  );

  // Cap the menu height so a long assistant list scrolls inside the popup
  // instead of overflowing the window (and getting clipped at the screen edge).
  const menuStyle: React.CSSProperties = { maxHeight: 360, overflowY: 'auto', minWidth: 220, maxWidth: 280 };

  if (loading) {
    return (
      <Menu style={menuStyle}>
        <Menu.Item key='loading' disabled>
          <Spin size={12} /> <span className='ml-6px'>{t('ide.chat.loading')}</span>
        </Menu.Item>
      </Menu>
    );
  }

  if (cliItems.length === 0 && presetItems.length === 0) {
    return (
      <Menu style={menuStyle}>
        <Menu.Item key='noAgents' disabled>
          {t('ide.chat.noAgents')}
        </Menu.Item>
      </Menu>
    );
  }

  return (
    <Menu style={menuStyle}>
      {cliItems.length > 0 ? (
        <Menu.ItemGroup title={t('ide.chat.cliGroup')}>
          {cliItems.map((agent) => (
            <Menu.Item key={`cli:${agent.id}`} disabled={disabled} onClick={() => void onPick({ kind: 'cli', agent })}>
              <span className='block truncate' title={agent.name}>
                {agent.name}
              </span>
            </Menu.Item>
          ))}
        </Menu.ItemGroup>
      ) : null}
      {presetItems.length > 0 ? (
        <Menu.ItemGroup title={t('ide.chat.presetGroup')}>
          {presetItems.map((assistant) => (
            <Menu.Item
              key={`preset:${assistant.id}`}
              disabled={disabled}
              onClick={() => void onPick({ kind: 'preset', assistant, language })}
            >
              <span className='block truncate' title={assistant.name}>
                {assistant.name}
              </span>
            </Menu.Item>
          ))}
        </Menu.ItemGroup>
      ) : null}
    </Menu>
  );
};

export default IdeChatPanel;

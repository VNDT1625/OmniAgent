/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `UnderstandPanel` — the body of the IDE "Understand" mode (an in-app
 * adaptation of github.com/Lum1104/Understand-Anything, MIT). It turns a repo
 * into something you can explore and LEARN, not just look at.
 *
 *  - **Header** — model picker (persisted), Build/Rebuild, a Live toggle
 *    (realtime watch + incremental auto-rebuild), and a {@link GenerationProgress}
 *    bar while building.
 *  - **Overview-first** — after a build the default view is the {@link OverviewPanel}
 *    ("teach me this codebase": tagline, description, tech, and entry points),
 *    because graphs that teach beat graphs that impress.
 *  - **Graph** — a {@link C4GraphView} with a C4 level switcher (Context /
 *    Container / Component / Code) and a layout switcher (Columns / Force), plus
 *    a node-detail rail. A live edit paints a diff-impact overlay on the graph.
 *
 * Incremental builds reuse unchanged files' summaries; every file always shows a
 * summary (LLM or a deterministic fallback, badged accordingly). Renderer-only;
 * Arco + icon-park + UnoCSS tokens; all text via i18n.
 */

import { Button, Empty, Progress, Select, Switch, Tag, Tooltip } from '@arco-design/web-react';
import { Caution, Compass, GraphicStitching, Lightning } from '@icon-park/react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AcpModelInfo } from '@/common/types/platform/acpTypes';
import { useAgents } from '@/renderer/hooks/agent/useAgents';
import { useModelProviderList } from '@/renderer/hooks/agent/useModelProviderList';
import type { AgentMetadata } from '@/renderer/utils/model/agentTypes';
import { makeCliModelId } from '@process/services/agentChat/cliModelId';
import { useUnderstand } from '../useUnderstand';
import { computeImpact, deriveC4, liftChangedToView } from '../graphModel';
import C4GraphView, { type C4Layout } from './C4GraphView';
import OverviewPanel from './OverviewPanel';
import NodeDetailRail from './NodeDetailRail';
import type { C4Level, KnowledgeBuildPhase } from '../ideClient';
import type { UnderstandBuildEvent } from '../useUnderstand';

/** localStorage keys for persisted Understand-mode preferences. */
const UNDERSTAND_MODEL_KEY = 'studio.ide.understandModel';
const UNDERSTAND_LEVEL_KEY = 'studio.ide.c4Level';
const UNDERSTAND_LAYOUT_KEY = 'studio.ide.graphLayout';
const UNDERSTAND_LIVE_KEY_PREFIX = 'studio.ide.understandLive';

type UnderstandPanelProps = {
  rootPath: string | null;
};

type UnderstandModelOption = {
  value: string;
  label: string;
};

/** Which top-level view is showing after a build. */
type ViewTab = 'overview' | 'graph';

/** The four C4 levels in display order. */
const C4_LEVELS: C4Level[] = ['context', 'container', 'component', 'code'];

const BUILD_PHASES: KnowledgeBuildPhase[] = ['scanning', 'parsing', 'reusing', 'summarizing', 'modules', 'overview'];

/** Persist a preference to localStorage (non-fatal when storage is unavailable). */
const persistPref = (key: string, value: string): void => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable — non-fatal */
  }
};

const livePrefKey = (rootPath: string): string => `${UNDERSTAND_LIVE_KEY_PREFIX}:${rootPath}`;

const readLivePref = (rootPath: string): boolean => {
  try {
    return localStorage.getItem(livePrefKey(rootPath)) === '1';
  } catch {
    return false;
  }
};

const persistLivePref = (rootPath: string, enabled: boolean): void => {
  persistPref(livePrefKey(rootPath), enabled ? '1' : '0');
};

const UnderstandPanel: React.FC<UnderstandPanelProps> = ({ rootPath }) => {
  const { i18n } = useTranslation();
  const { providers, getAvailableModels } = useModelProviderList();
  const { agents } = useAgents();
  const understand = useUnderstand(rootPath);
  const {
    graph,
    status,
    phase,
    phaseDetail,
    buildEvents,
    error,
    errorCode,
    live,
    changedFiles,
    loadExisting,
    build,
    setLive,
    clearChanged,
  } = understand;

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<ViewTab>('overview');
  const [level, setLevel] = useState<C4Level>(
    () => (localStorage.getItem(UNDERSTAND_LEVEL_KEY) as C4Level) || 'component'
  );
  const [layout, setLayout] = useState<C4Layout>(
    () => (localStorage.getItem(UNDERSTAND_LAYOUT_KEY) as C4Layout) || 'columns'
  );
  const restoredLiveKeyRef = useRef('');

  // Load a previously-built graph on mount / when the repo changes.
  useEffect(() => {
    void loadExisting();
    setSelectedId(null);
    setTab('overview');
  }, [loadExisting]);

  const modelOptions = useMemo<UnderstandModelOption[]>(() => {
    const seen = new Set<string>();
    const options: UnderstandModelOption[] = [];
    for (const provider of providers) {
      for (const model of getAvailableModels(provider)) {
        if (seen.has(model)) continue;
        seen.add(model);
        options.push({ value: model, label: model });
      }
    }
    for (const option of buildCliModelOptions(agents)) {
      if (seen.has(option.value)) continue;
      seen.add(option.value);
      options.push(option);
    }
    return options;
  }, [agents, providers, getAvailableModels]);

  const [model, setModel] = useState<string | null>(() => localStorage.getItem(UNDERSTAND_MODEL_KEY));
  useEffect(() => {
    if (!model && modelOptions.length > 0) setModel(modelOptions[0].value);
  }, [model, modelOptions]);

  const handlePickModel = (value: string): void => {
    setModel(value);
    persistPref(UNDERSTAND_MODEL_KEY, value);
    if (live && rootPath) {
      setLive(true, value, i18n.language);
    }
  };
  const handlePickLevel = (value: C4Level): void => {
    setLevel(value);
    persistPref(UNDERSTAND_LEVEL_KEY, value);
  };
  const handlePickLayout = (value: C4Layout): void => {
    setLayout(value);
    persistPref(UNDERSTAND_LAYOUT_KEY, value);
  };

  const building = status === 'building';
  const handleBuild = (): void => {
    if (!rootPath || !model || building) return;
    void build(model, i18n.language, true);
  };
  const handleImprove = (): void => {
    if (!rootPath || !model || building) return;
    void build(model, i18n.language, false);
  };
  const handleToggleLive = (on: boolean): void => {
    if (rootPath) {
      persistLivePref(rootPath, on);
    }
    setLive(on, model, i18n.language);
  };

  useEffect(() => {
    if (!rootPath || !model || !graph || live || !readLivePref(rootPath)) {
      return;
    }
    const key = `${rootPath}:${model}:${i18n.language}`;
    if (restoredLiveKeyRef.current === key) {
      return;
    }
    restoredLiveKeyRef.current = key;
    setLive(true, model, i18n.language);
  }, [graph, i18n.language, live, model, rootPath, setLive]);

  // Derive the C4 view + diff-impact overlay (pure, memoized).
  const view = useMemo(() => (graph ? deriveC4(graph, level) : null), [graph, level]);
  const impact = useMemo(
    () => (graph && changedFiles.length > 0 ? computeImpact(graph.edges, changedFiles) : null),
    [graph, changedFiles]
  );
  const changedIds = useMemo(
    () => (view && impact ? liftChangedToView(view, impact.changed) : undefined),
    [view, impact]
  );
  const impactedIds = useMemo(
    () => (view && impact ? liftChangedToView(view, impact.impacted) : undefined),
    [view, impact]
  );

  const selectedNode = useMemo(
    () => (graph && selectedId ? (graph.nodes.find((n) => n.id === selectedId) ?? null) : null),
    [graph, selectedId]
  );

  const handleSelectNode = (id: string): void => {
    setSelectedId(id);
    if (graph?.nodes.some((n) => n.id === id)) setTab('graph');
  };

  return (
    <div className='size-full flex flex-col min-h-0 bg-1'>
      <UnderstandToolbar
        model={model}
        modelOptions={modelOptions}
        building={building}
        live={live}
        canBuild={Boolean(rootPath && model)}
        hasGraph={Boolean(graph)}
        onPickModel={handlePickModel}
        onBuild={handleBuild}
        onImprove={handleImprove}
        onToggleLive={handleToggleLive}
      />

      {building ? (
        <div className='shrink-0 px-16px py-8px border-b border-b-1 bg-fill-1'>
          <UnderstandBuildProgress phase={phase} phaseDetail={phaseDetail} events={buildEvents} />
        </div>
      ) : null}

      {graph && status !== 'error' ? (
        <ViewTabs
          tab={tab}
          level={level}
          layout={layout}
          live={live}
          changedCount={impact?.changed.length ?? 0}
          onTab={setTab}
          onLevel={handlePickLevel}
          onLayout={handlePickLayout}
          onClearChanged={clearChanged}
        />
      ) : null}

      <div className='flex-1 min-h-0'>
        {status === 'error' ? (
          <BuildError code={errorCode} message={error} canBuild={Boolean(rootPath && model)} onBuild={handleBuild} />
        ) : graph && view ? (
          tab === 'overview' ? (
            <OverviewPanel
              graph={graph}
              onSelectNode={handleSelectNode}
              onOpenGraph={() => setTab('graph')}
              onRebuild={handleBuild}
            />
          ) : (
            <div className='size-full flex min-h-0'>
              <div className='flex-1 min-w-0 min-h-0'>
                <C4GraphView
                  view={view}
                  selectedId={selectedId}
                  layout={layout}
                  changedIds={changedIds}
                  impactedIds={impactedIds}
                  onSelectNode={setSelectedId}
                />
              </div>
              <NodeDetailRail graph={graph} node={selectedNode} />
            </div>
          )
        ) : (
          <EmptyState
            building={building}
            loading={status === 'loading'}
            canBuild={Boolean(rootPath && model)}
            onBuild={handleBuild}
          />
        )}
      </div>
    </div>
  );
};

/** Map a build phase to its translated, human label (with optional detail). */
const phaseLabel = (
  t: (k: string, o?: Record<string, unknown>) => string,
  phase: KnowledgeBuildPhase,
  detail: string
): string => {
  const base = t(`ide.understand.phase.${phase}`);
  return detail ? `${base} · ${detail}` : base;
};

const isAcpModelInfo = (value: unknown): value is AcpModelInfo => {
  if (!value || typeof value !== 'object') return false;
  const info = value as { available_models?: unknown };
  return Array.isArray(info.available_models);
};

const buildCliModelOptions = (agents: AgentMetadata[]): UnderstandModelOption[] => {
  const options: UnderstandModelOption[] = [];
  for (const agent of agents) {
    if (agent.available === false || agent.enabled === false) continue;
    const modelInfo = isAcpModelInfo(agent.handshake?.available_models) ? agent.handshake.available_models : null;
    if (!modelInfo || modelInfo.available_models.length === 0) {
      options.push({ value: makeCliModelId(agent.id), label: agent.name });
      continue;
    }
    for (const model of modelInfo.available_models) {
      options.push({
        value: makeCliModelId(agent.id, model.id),
        label: `${agent.name} / ${model.label || model.id}`,
      });
    }
  }
  return options;
};

const parsePhaseRatio = (detail: string): number => {
  const match = detail.match(/(\d+)\s*\/\s*(\d+)/);
  if (!match) return 0;
  const current = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return 0;
  return Math.max(0, Math.min(1, current / total));
};

const buildPercent = (phase: KnowledgeBuildPhase, detail: string): number => {
  if (phase === 'done') return 100;
  if (phase === 'error') return 100;
  const index = BUILD_PHASES.indexOf(phase);
  if (index < 0) return 0;
  const phaseWeight = 100 / BUILD_PHASES.length;
  return Math.round(index * phaseWeight + parsePhaseRatio(detail) * phaseWeight);
};

const latestEventByPhase = (events: UnderstandBuildEvent[]): Map<KnowledgeBuildPhase, UnderstandBuildEvent> => {
  const map = new Map<KnowledgeBuildPhase, UnderstandBuildEvent>();
  for (const event of events) {
    map.set(event.phase, event);
  }
  return map;
};

const UnderstandBuildProgress: React.FC<{
  phase: KnowledgeBuildPhase;
  phaseDetail: string;
  events: UnderstandBuildEvent[];
}> = ({ phase, phaseDetail, events }) => {
  const { t } = useTranslation();
  const seen = latestEventByPhase(events);
  const percent = buildPercent(phase, phaseDetail);
  const currentIndex = BUILD_PHASES.indexOf(phase);

  return (
    <div className='flex flex-col gap-8px'>
      <div className='flex items-center gap-10px min-w-0'>
        <div className='flex-1 min-w-0'>
          <div className='text-13px font-600 text-t-primary truncate'>{phaseLabel(t, phase, phaseDetail)}</div>
          <div className='text-12px text-t-tertiary truncate'>{t('ide.understand.progress.hint')}</div>
        </div>
        <Tag color='arcoblue' size='small'>
          {t('ide.understand.progress.percent', { percent })}
        </Tag>
      </div>
      <Progress percent={percent} showText={false} strokeWidth={6} />
      <div className='grid grid-cols-2 md:grid-cols-6 gap-6px'>
        {BUILD_PHASES.map((item, index) => {
          const event = seen.get(item);
          const active = item === phase;
          const done = currentIndex > index || phase === 'done';
          return (
            <div
              key={item}
              className={`min-w-0 rd-8px px-8px py-6px border border-solid ${
                active
                  ? 'border-primary bg-primary-light-1'
                  : done
                    ? 'border-success bg-success-light-1'
                    : 'border-2 bg-2'
              }`}
            >
              <div className={`text-11px font-600 truncate ${active ? 'text-primary' : 'text-t-secondary'}`}>
                {t(`ide.understand.phase.${item}`)}
              </div>
              <div className='text-11px text-t-tertiary truncate'>
                {event?.detail ||
                  (done ? t('ide.understand.progress.completed') : t('ide.understand.progress.pending'))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/** Top toolbar: title, model picker, Live toggle, build/rebuild. */
const UnderstandToolbar: React.FC<{
  model: string | null;
  modelOptions: UnderstandModelOption[];
  building: boolean;
  live: boolean;
  canBuild: boolean;
  hasGraph: boolean;
  onPickModel: (value: string) => void;
  onBuild: () => void;
  onImprove: () => void;
  onToggleLive: (on: boolean) => void;
}> = ({ model, modelOptions, building, live, canBuild, hasGraph, onPickModel, onBuild, onImprove, onToggleLive }) => {
  const { t } = useTranslation();
  return (
    <div className='shrink-0 flex items-center gap-10px px-16px h-48px border-b border-b-1'>
      <span className='flex items-center gap-8px text-t-primary'>
        <Compass theme='outline' size={16} className='text-primary' />
        <span className='text-13px font-600'>{t('ide.understand.title')}</span>
      </span>
      <div className='flex-1' />
      {hasGraph ? (
        <Tooltip content={t('ide.understand.live.hint')}>
          <span
            className={`flex items-center gap-6px px-8px h-28px rd-8px border transition-colors ${live ? 'border-primary bg-primary-light-1' : 'border-arco-2'}`}
          >
            <Lightning
              theme={live ? 'filled' : 'outline'}
              size={14}
              className={live ? 'text-primary' : 'text-t-tertiary'}
            />
            <span className={`text-12px font-500 ${live ? 'text-primary' : 'text-t-secondary'}`}>
              {t('ide.understand.live.label')}
            </span>
            <Switch size='small' checked={live} onChange={onToggleLive} />
          </span>
        </Tooltip>
      ) : null}
      <Select
        value={model ?? undefined}
        placeholder={t('ide.understand.pickModel')}
        onChange={onPickModel}
        className='!w-200px'
        size='small'
        showSearch
      >
        {modelOptions.map((opt) => (
          <Select.Option key={opt.value} value={opt.value}>
            {opt.label}
          </Select.Option>
        ))}
      </Select>
      <Button
        type='primary'
        size='small'
        loading={building}
        disabled={!canBuild}
        icon={<GraphicStitching theme='outline' size={14} />}
        onClick={onBuild}
      >
        {hasGraph ? t('ide.understand.rebuildFresh') : t('ide.understand.build')}
      </Button>
      {hasGraph ? (
        <Tooltip content={t('ide.understand.improveHint')}>
          <Button
            size='small'
            disabled={!canBuild || building}
            icon={<Lightning theme='outline' size={14} />}
            onClick={onImprove}
          >
            {t('ide.understand.improve')}
          </Button>
        </Tooltip>
      ) : null}
    </div>
  );
};

/** Secondary bar: Overview/Graph tabs + (graph only) C4 level + layout + diff badge. */
const ViewTabs: React.FC<{
  tab: ViewTab;
  level: C4Level;
  layout: C4Layout;
  live: boolean;
  changedCount: number;
  onTab: (tab: ViewTab) => void;
  onLevel: (level: C4Level) => void;
  onLayout: (layout: C4Layout) => void;
  onClearChanged: () => void;
}> = ({ tab, level, layout, live, changedCount, onTab, onLevel, onLayout, onClearChanged }) => {
  const { t } = useTranslation();
  return (
    <div className='shrink-0 flex items-center gap-12px px-16px h-40px border-b border-b-1 bg-fill-1'>
      <Segmented<ViewTab>
        value={tab}
        options={[
          { value: 'overview', label: t('ide.understand.viewMode.overview') },
          { value: 'graph', label: t('ide.understand.viewMode.graph') },
        ]}
        onChange={onTab}
      />
      {tab === 'graph' ? (
        <>
          <span className='w-1px h-18px bg-fill-3' aria-hidden />
          <Tooltip content={t('ide.understand.c4.hint')}>
            <span className='text-11px font-600 uppercase tracking-wide text-t-tertiary cursor-help'>C4</span>
          </Tooltip>
          <Segmented<C4Level>
            value={level}
            options={C4_LEVELS.map((l) => ({ value: l, label: t(`ide.understand.c4.${l}`) }))}
            onChange={onLevel}
          />
          <div className='flex-1' />
          <Segmented<C4Layout>
            value={layout}
            options={[
              { value: 'columns', label: t('ide.understand.layout.columns') },
              { value: 'force', label: t('ide.understand.layout.force') },
            ]}
            onChange={onLayout}
          />
        </>
      ) : (
        <div className='flex-1' />
      )}
      {changedCount > 0 ? (
        <Button
          size='mini'
          type='outline'
          status='warning'
          onClick={onClearChanged}
          icon={<Lightning theme='filled' size={12} />}
        >
          {t('ide.understand.live.changedBadge', { count: changedCount })}
        </Button>
      ) : live ? (
        <span className='flex items-center gap-5px text-11px text-t-tertiary'>
          <span className='size-7px rd-full bg-success animate-pulse' aria-hidden />
          {t('ide.understand.live.watching')}
        </span>
      ) : null}
    </div>
  );
};

/** A tiny segmented control built on Arco buttons (keeps a consistent look). */
function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}): React.ReactElement {
  return (
    <div className='flex items-center gap-2px p-2px rd-8px bg-fill-2'>
      {options.map((opt) => {
        const active = opt.value === value;
        return (
          <Button
            key={opt.value}
            type={active ? 'primary' : 'text'}
            size='mini'
            onClick={() => onChange(opt.value)}
            className='!h-24px'
          >
            {opt.label}
          </Button>
        );
      })}
    </div>
  );
}

/** Idle / empty body: invite the user to build the knowledge graph. */
const EmptyState: React.FC<{ building: boolean; loading: boolean; canBuild: boolean; onBuild: () => void }> = ({
  building,
  loading,
  canBuild,
  onBuild,
}) => {
  const { t } = useTranslation();
  return (
    <div className='size-full flex-center flex-col gap-14px px-24px text-center'>
      <Empty
        icon={
          <span className='size-56px flex-center rd-16px bg-primary-light-1 text-primary'>
            <Compass theme='outline' size={28} />
          </span>
        }
        description={
          <div className='flex flex-col gap-6px max-w-460px'>
            <span className='text-16px font-600 text-t-primary'>{t('ide.understand.emptyTitle')}</span>
            <span className='text-13px text-t-secondary leading-relaxed'>{t('ide.understand.emptyHint')}</span>
          </div>
        }
      />
      <Button
        type='primary'
        loading={building || loading}
        disabled={!canBuild}
        icon={<GraphicStitching theme='outline' size={15} />}
        onClick={onBuild}
      >
        {t('ide.understand.build')}
      </Button>
    </div>
  );
};

/** Build-failure body: a friendly hint (special-cased for missing model). */
const BuildError: React.FC<{
  code: 'no-model' | 'error' | null;
  message: string | null;
  canBuild: boolean;
  onBuild: () => void;
}> = ({ code, message, canBuild, onBuild }) => {
  const { t } = useTranslation();
  const noModel = code === 'no-model';
  return (
    <div className='size-full flex-center flex-col gap-12px px-24px text-center'>
      <span className='size-52px flex-center rd-14px bg-danger-light-1 text-danger'>
        <Caution theme='outline' size={26} />
      </span>
      <p className='m-0 text-15px font-600 text-t-primary'>
        {noModel ? t('ide.understand.noModelTitle') : t('ide.understand.errorTitle')}
      </p>
      <p className='m-0 max-w-440px text-13px text-t-secondary leading-relaxed'>
        {noModel ? t('ide.understand.noModelHint') : (message ?? t('ide.understand.errorHint'))}
      </p>
      {!noModel ? (
        <Button type='outline' disabled={!canBuild} onClick={onBuild}>
          {t('ide.understand.retry')}
        </Button>
      ) : null}
    </div>
  );
};

export default UnderstandPanel;

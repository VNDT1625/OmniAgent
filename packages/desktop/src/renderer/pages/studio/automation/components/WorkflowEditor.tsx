/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `WorkflowEditor` — edits one workflow on a real node-based canvas powered by
 * React Flow (`@xyflow/react`). A left palette adds steps, the centre is the
 * draggable {@link WorkflowCanvas}, and the right panel hosts the selected
 * step's name + {@link NodeConfigForm}.
 *
 * The backend contract stays a LINEAR ordered pipeline: although the canvas is
 * free-form, the persisted node order is derived from each node's vertical (Y)
 * position at save time (ties broken by X). Connecting edges are recomputed from
 * that same Y order on every change, so the canvas always reads as one chain and
 * the engine keeps executing steps deterministically in order.
 *
 * Local edit state is committed via `onSave`. Renderer-only; all text via i18n;
 * Arco + icon-park + UnoCSS tokens only.
 */

import { Button, Empty, Input, InputNumber, Message, Switch } from '@arco-design/web-react';
import { Save } from '@icon-park/react';
import { MarkerType, useNodesState, type Edge } from '@xyflow/react';
import React, { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SaveWorkflowRequest } from '@process/automation/automationBridge';
import { useThemeContext } from '@renderer/hooks/context/ThemeContext';
import type { Workflow, WorkflowNode, WorkflowNodeKind } from '../automationClient';
import { metaFor, NODE_KIND_META } from '../nodeKindMeta';
import NodeConfigForm from './NodeConfigForm';
import BranchEditor from './BranchEditor';
import WorkflowCanvas from './WorkflowCanvas';
import type { StepNodeType } from './nodes/StepNode';

type WorkflowEditorProps = {
  workflow: Workflow;
  onSave: (workflow: SaveWorkflowRequest['workflow']) => Promise<Workflow | null>;
};

/** Default branch skeleton for a freshly-added control-flow node. */
const defaultBranches = (kind: WorkflowNodeKind): Record<string, WorkflowNode[]> | undefined => {
  switch (kind) {
    case 'control.if':
      return { then: [], else: [] };
    case 'control.loop':
      return { body: [] };
    case 'control.tryCatch':
      return { try: [], catch: [] };
    case 'control.switch':
      return { default: [] };
    case 'control.parallel':
      return { 'branch:0': [], 'branch:1': [] };
    default:
      return undefined;
  }
};

/** Horizontal lane the chain is laid out on (px). */
const LANE_X = 60;
/** Vertical spacing between consecutive steps (px). */
const ROW_GAP = 130;
/** Y of the first step (px). */
const START_Y = 24;

let nodeCounter = 0;
const nextNodeId = (): string => `n${Date.now().toString(36)}-${(nodeCounter++).toString(36)}`;

/** Project the persisted linear nodes into vertically-stacked canvas nodes. */
const toCanvasNodes = (nodes: WorkflowNode[]): StepNodeType[] =>
  nodes.map((node, index) => ({
    id: node.id,
    type: 'step',
    position: { x: LANE_X, y: START_Y + index * ROW_GAP },
    data: { kind: node.kind, name: node.name, config: node.config, branches: node.branches, onError: node.onError },
  }));

/** Sort a copy of the canvas nodes by Y (then X) — the engine's execution order. */
const sortByPosition = (nodes: StepNodeType[]): StepNodeType[] =>
  nodes.toSorted((a, b) => a.position.y - b.position.y || a.position.x - b.position.x);

/** Collapse canvas nodes back to the persisted linear pipeline (Y-then-X order). */
const toOrderedNodes = (nodes: StepNodeType[]): WorkflowNode[] =>
  sortByPosition(nodes).map((node) => {
    const out: WorkflowNode = { id: node.id, kind: node.data.kind, name: node.data.name, config: node.data.config };
    if (node.data.branches) out.branches = node.data.branches;
    if (node.data.onError) out.onError = node.data.onError;
    return out;
  });

/** Build the single top-to-bottom chain of edges from the current Y order. */
const toChainEdges = (nodes: StepNodeType[]): Edge[] => {
  const ordered = sortByPosition(nodes);
  const edges: Edge[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const source = ordered[i];
    const target = ordered[i + 1];
    edges.push({
      id: `e-${source.id}-${target.id}`,
      source: source.id,
      target: target.id,
      type: 'smoothstep',
      markerEnd: { type: MarkerType.ArrowClosed },
    });
  }
  return edges;
};

const WorkflowEditor: React.FC<WorkflowEditorProps> = ({ workflow, onSave }) => {
  const { t } = useTranslation();
  const { theme } = useThemeContext();
  const [name, setName] = useState(workflow.name);
  const [nodes, setNodes, onNodesChange] = useNodesState<StepNodeType>(toCanvasNodes(workflow.nodes));
  const [activeNodeId, setActiveNodeId] = useState<string | null>(workflow.nodes[0]?.id ?? null);
  const [saving, setSaving] = useState(false);

  // Reset local state when switching to a different workflow.
  useEffect(() => {
    setName(workflow.name);
    setNodes(toCanvasNodes(workflow.nodes));
    setActiveNodeId(workflow.nodes[0]?.id ?? null);
  }, [workflow.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const orderedNodes = useMemo(() => toOrderedNodes(nodes), [nodes]);
  const edges = useMemo(() => toChainEdges(nodes), [nodes]);

  const dirty = useMemo(
    () => name !== workflow.name || JSON.stringify(orderedNodes) !== JSON.stringify(workflow.nodes),
    [name, orderedNodes, workflow]
  );

  const addNode = (kind: WorkflowNodeKind): void => {
    const meta = metaFor(kind);
    const id = nextNodeId();
    setNodes((prev) => {
      const lowestY = prev.reduce((max, n) => Math.max(max, n.position.y), START_Y - ROW_GAP);
      const node: StepNodeType = {
        id,
        type: 'step',
        position: { x: LANE_X, y: lowestY + ROW_GAP },
        data: { kind, name: t(meta.labelKey), config: meta.defaultConfig(), branches: defaultBranches(kind) },
      };
      return [...prev, node];
    });
    setActiveNodeId(id);
  };

  const removeNode = (id: string): void => {
    setNodes((prev) => prev.filter((n) => n.id !== id));
    setActiveNodeId((current) => (current === id ? null : current));
  };

  const patchNodeConfig = (id: string, config: Record<string, unknown>): void => {
    setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, data: { ...n.data, config } } : n)));
  };

  const renameNode = (id: string, value: string): void => {
    setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, data: { ...n.data, name: value } } : n)));
  };

  const patchNodeBranches = (id: string, branches: Record<string, WorkflowNode[]>): void => {
    setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, data: { ...n.data, branches } } : n)));
  };

  const patchNodeError = (
    id: string,
    onError: { retries?: number; retryDelayMs?: number; continueOnError?: boolean } | undefined
  ): void => {
    setNodes((prev) => prev.map((n) => (n.id === id ? { ...n, data: { ...n.data, onError } } : n)));
  };

  const handleSave = async (): Promise<void> => {
    if (name.trim().length === 0) {
      Message.warning(t('automation.editor.nameRequired'));
      return;
    }
    setSaving(true);
    const saved = await onSave({ id: workflow.id, name: name.trim(), nodes: orderedNodes, enabled: workflow.enabled });
    setSaving(false);
    if (saved) Message.success(t('automation.editor.saved'));
  };

  const activeNode = nodes.find((n) => n.id === activeNodeId) ?? null;

  return (
    <div className='size-full flex flex-col min-h-0'>
      <header className='shrink-0 flex items-center gap-10px px-16px py-12px border-b border-b-1'>
        <Input
          value={name}
          onChange={setName}
          placeholder={t('automation.editor.namePlaceholder')}
          className='!w-280px'
        />
        <div className='flex-1' />
        <Button
          type='primary'
          loading={saving}
          disabled={!dirty}
          icon={<Save theme='outline' size={15} />}
          onClick={() => void handleSave()}
        >
          {t('automation.editor.save')}
        </Button>
      </header>

      <div className='flex-1 min-h-0 flex'>
        {/* Palette */}
        <aside className='w-200px shrink-0 min-h-0 overflow-y-auto border-r border-b-1 p-12px flex flex-col gap-6px'>
          <span className='text-12px text-t-tertiary font-[500] mb-2px'>{t('automation.editor.addStep')}</span>
          {NODE_KIND_META.map((meta) => {
            const Icon = meta.Icon;
            return (
              <Button
                key={meta.kind}
                long
                className='!h-auto !rd-8px !px-10px !py-8px !text-left'
                onClick={() => addNode(meta.kind)}
              >
                <span className='flex items-start gap-8px w-full'>
                  <span className={`flex-center shrink-0 mt-1px ${meta.accentClass}`}>
                    <Icon theme='outline' size={16} fill='currentColor' />
                  </span>
                  <span className='flex flex-col min-w-0'>
                    <span className='text-13px font-[500] text-t-primary'>{t(meta.labelKey)}</span>
                    <span className='text-11px text-t-tertiary leading-snug whitespace-normal'>{t(meta.descKey)}</span>
                  </span>
                </span>
              </Button>
            );
          })}
        </aside>

        {/* Canvas */}
        <main className='relative flex-1 min-w-0 min-h-0'>
          <WorkflowCanvas
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onSelect={setActiveNodeId}
            onDelete={removeNode}
            colorMode={theme}
          />
          {nodes.length === 0 ? (
            <div className='pointer-events-none absolute inset-0 flex-center'>
              <Empty description={t('automation.editor.emptyPipeline')} />
            </div>
          ) : null}
        </main>

        {/* Config */}
        <aside className='w-300px shrink-0 min-h-0 overflow-y-auto border-l border-b-1 p-16px'>
          {activeNode ? (
            <div className='flex flex-col gap-12px'>
              <label className='flex flex-col gap-4px'>
                <span className='text-12px text-t-secondary font-[500]'>{t('automation.config.stepName')}</span>
                <Input value={activeNode.data.name} onChange={(v) => renameNode(activeNode.id, v)} size='small' />
              </label>
              <div className='h-1px bg-2' />
              <NodeConfigForm
                node={{
                  id: activeNode.id,
                  kind: activeNode.data.kind,
                  name: activeNode.data.name,
                  config: activeNode.data.config,
                }}
                onChange={(config) => patchNodeConfig(activeNode.id, config)}
              />
              {activeNode.data.kind.startsWith('control.') &&
              activeNode.data.kind !== 'control.merge' &&
              activeNode.data.kind !== 'control.stop' ? (
                <>
                  <div className='h-1px bg-2' />
                  <BranchEditor
                    kind={activeNode.data.kind}
                    branches={activeNode.data.branches ?? {}}
                    onChange={(branches) => patchNodeBranches(activeNode.id, branches)}
                  />
                </>
              ) : null}
              {!activeNode.data.kind.startsWith('control.') && !activeNode.data.kind.startsWith('trigger.') ? (
                <>
                  <div className='h-1px bg-2' />
                  <ErrorPolicyEditor
                    value={activeNode.data.onError}
                    onChange={(policy) => patchNodeError(activeNode.id, policy)}
                  />
                </>
              ) : null}
            </div>
          ) : (
            <div className='h-full flex-center'>
              <Empty description={t('automation.editor.pickStep')} />
            </div>
          )}
        </aside>
      </div>
    </div>
  );
};

/**
 * `ErrorPolicyEditor` — edits a leaf node's retry/error policy (retries, retry
 * delay, continue-on-error). Off by default; enabling reveals the fields.
 */
const ErrorPolicyEditor: React.FC<{
  value?: { retries?: number; retryDelayMs?: number; continueOnError?: boolean };
  onChange: (policy: { retries?: number; retryDelayMs?: number; continueOnError?: boolean } | undefined) => void;
}> = ({ value, onChange }) => {
  const { t } = useTranslation();
  const enabled = value !== undefined;
  return (
    <div className='flex flex-col gap-8px'>
      <label className='flex items-center justify-between gap-8px'>
        <span className='text-12px text-t-secondary font-[500]'>{t('automation.error.title')}</span>
        <Switch
          size='small'
          checked={enabled}
          onChange={(on) => onChange(on ? { retries: 0, retryDelayMs: 0, continueOnError: false } : undefined)}
        />
      </label>
      {enabled ? (
        <>
          <label className='flex flex-col gap-2px'>
            <span className='text-11px text-t-tertiary'>{t('automation.error.retries')}</span>
            <InputNumber
              value={value?.retries ?? 0}
              onChange={(v) => onChange({ ...value, retries: typeof v === 'number' ? v : 0 })}
              min={0}
              max={10}
              size='mini'
              className='w-100px'
            />
          </label>
          <label className='flex flex-col gap-2px'>
            <span className='text-11px text-t-tertiary'>{t('automation.error.retryDelay')}</span>
            <InputNumber
              value={value?.retryDelayMs ?? 0}
              onChange={(v) => onChange({ ...value, retryDelayMs: typeof v === 'number' ? v : 0 })}
              min={0}
              step={250}
              size='mini'
              className='w-120px'
            />
          </label>
          <label className='flex items-center justify-between gap-8px'>
            <span className='text-11px text-t-tertiary'>{t('automation.error.continueOnError')}</span>
            <Switch
              size='small'
              checked={value?.continueOnError ?? false}
              onChange={(on) => onChange({ ...value, continueOnError: on })}
            />
          </label>
        </>
      ) : null}
    </div>
  );
};

export default WorkflowEditor;

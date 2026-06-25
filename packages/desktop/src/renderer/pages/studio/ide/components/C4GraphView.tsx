/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `C4GraphView` — a React Flow visualization that renders ANY {@link C4View}
 * (the four C4 abstraction levels: Context / Container / Component / Code) with
 * two selectable layouts:
 *
 *  - **columns** — deterministic per-layer columns (files/modules stacked by
 *    weight). Great for "which layer is this in?".
 *  - **force** — a deterministic radial/clustered layout: the heaviest node
 *    sits at the centre and the rest fan out on a ring, grouped by layer angle.
 *    A calmer, "see the shape" view than 3D, without occlusion or motion sickness.
 *
 * It also paints a **diff-impact overlay**: ids in `changedIds` glow (changed),
 * ids in `impactedIds` get a softer ring (downstream dependents), the rest dim.
 *
 * The heavy view→flow conversion is memoized on `[view, layout]`. Selecting a
 * node calls `onSelectNode` with the C4 node id. Renderer-only; Arco/UnoCSS
 * tokens, the only raw colours are the categorical layer palette. i18n for text.
 */

import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Panel,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  MarkerType,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useTheme from '@renderer/hooks/system/useTheme';
import type { ArchLayer } from '@process/ide/understandTypes';
import type { C4Edge, C4Node, C4View } from '../graphModel';
import { LAYER_COLORS, LAYER_ORDER } from './layerColors';

/** The two layout strategies. */
export type C4Layout = 'columns' | 'force';

type C4GraphViewProps = {
  view: C4View;
  selectedId: string | null;
  layout: C4Layout;
  /** Ids that changed directly (diff-impact glow). */
  changedIds?: Set<string>;
  /** Ids transitively impacted by a change (softer ring). */
  impactedIds?: Set<string>;
  onSelectNode: (id: string) => void;
};

/** Highlight state relative to focus + diff overlay. */
type Highlight = 'none' | 'focus' | 'neighbor' | 'dim' | 'changed' | 'impacted';

/** Per-node payload carried on each flow node. */
type C4NodeData = {
  id: string;
  label: string;
  layer: ArchLayer;
  color: string;
  kind: C4Node['kind'];
  dot: number;
  font: number;
  bold: boolean;
  highlight: Highlight;
};

type C4FlowNode = Node<C4NodeData, 'c4'>;

// --- Geometry --------------------------------------------------------------
const NODE_H = 36;
const NODE_W_MIN = 150;
const NODE_W_MAX = 220;
const COL_GAP = 268;
const ROW_GAP = 52;
const RING_RADIUS = 320;

/** Clamp + linear interpolation. */
const lerp = (a: number, b: number, t: number): number => a + (b - a) * Math.min(1, Math.max(0, t));

/** Idle edge stroke (inherited Arco token). */
const EDGE_IDLE = 'var(--color-fill-3)';

/** Build one idle edge. */
const baseEdge = (e: C4Edge): Edge => ({
  id: `${e.from}__${e.to}`,
  source: e.from,
  target: e.to,
  type: 'default',
  style: { stroke: EDGE_IDLE, strokeWidth: 1, opacity: 0.26 },
  markerEnd: { type: MarkerType.ArrowClosed, width: 13, height: 13, color: EDGE_IDLE },
});

/** Colour for a node: layer palette, but actors/externals get neutral hues. */
const colorOf = (node: C4Node): string => {
  if (node.kind === 'actor') return '#64748B';
  if (node.kind === 'external') return '#A78BFA';
  if (node.kind === 'system') return LAYER_COLORS.service;
  return LAYER_COLORS[node.layer];
};

/** Layers actually present in the view, in display order (for the legend). */
const presentLayers = (view: C4View): ArchLayer[] => {
  const set = new Set(
    view.nodes.filter((n) => n.kind === 'file' || n.kind === 'module' || n.kind === 'container').map((n) => n.layer)
  );
  return LAYER_ORDER.filter((l) => set.has(l));
};

/** Deterministic per-layer column layout. */
const layoutColumns = (view: C4View, maxWeight: number): C4FlowNode[] => {
  const byLayer = new Map<ArchLayer, C4Node[]>();
  // Actors/externals/system share a synthetic leading column by kind.
  for (const node of view.nodes) {
    const list = byLayer.get(node.layer) ?? [];
    list.push(node);
    byLayer.set(node.layer, list);
  }
  const layers = LAYER_ORDER.filter((l) => (byLayer.get(l)?.length ?? 0) > 0);
  const nodes: C4FlowNode[] = [];
  layers.forEach((layer, colIndex) => {
    const column = [...(byLayer.get(layer) ?? [])].toSorted((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
    const x = colIndex * COL_GAP;
    column.forEach((node, rowIndex) => {
      const tt = maxWeight > 0 ? node.weight / maxWeight : 0;
      const width = Math.round(lerp(NODE_W_MIN, NODE_W_MAX, tt));
      nodes.push(makeFlowNode(node, x - width / 2, rowIndex * ROW_GAP, width, tt));
    });
  });
  return nodes;
};

/** Deterministic radial/clustered layout — heaviest node centred, rest on a ring. */
const layoutForce = (view: C4View, maxWeight: number): C4FlowNode[] => {
  const sorted = [...view.nodes].toSorted((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));
  const nodes: C4FlowNode[] = [];
  const ringCount = Math.max(1, sorted.length - 1);
  sorted.forEach((node, index) => {
    const tt = maxWeight > 0 ? node.weight / maxWeight : 0;
    const width = Math.round(lerp(NODE_W_MIN, NODE_W_MAX, tt));
    if (index === 0) {
      nodes.push(makeFlowNode(node, -width / 2, 0, width, tt));
      return;
    }
    // Angle blends layer (cluster) with index so same-layer nodes sit together.
    const layerSlot = LAYER_ORDER.indexOf(node.layer);
    const baseAngle = (layerSlot >= 0 ? layerSlot : 7) * ((2 * Math.PI) / LAYER_ORDER.length);
    const jitter = ((index - 1) / ringCount) * 2 * Math.PI;
    const angle = baseAngle + jitter * 0.45;
    const radius = RING_RADIUS + (index % 3) * 64;
    const x = Math.cos(angle) * radius - width / 2;
    const y = Math.sin(angle) * radius;
    nodes.push(makeFlowNode(node, x, y, width, tt));
  });
  return nodes;
};

/** Build a flow node from a C4 node + computed position/size. */
const makeFlowNode = (node: C4Node, x: number, y: number, width: number, tt: number): C4FlowNode => ({
  id: node.id,
  type: 'c4',
  position: { x, y },
  width,
  height: NODE_H,
  draggable: true,
  connectable: false,
  data: {
    id: node.id,
    label: node.label,
    layer: node.layer,
    color: colorOf(node),
    kind: node.kind,
    dot: Math.round(lerp(9, 17, tt)),
    font: Math.round(lerp(11, 14, tt)),
    bold: tt >= 0.5 || node.kind === 'system',
    highlight: 'none',
  },
});

/** Hidden handle (present for edge attachment, invisible). */
const HANDLE_STYLE: React.CSSProperties = {
  opacity: 0,
  width: 1,
  height: 1,
  minWidth: 1,
  minHeight: 1,
  border: 'none',
  background: 'transparent',
};

/** Build undirected adjacency for neighbour highlighting. */
const buildNeighbors = (edges: C4Edge[]): Map<string, Set<string>> => {
  const map = new Map<string, Set<string>>();
  const link = (a: string, b: string): void => {
    let set = map.get(a);
    if (!set) {
      set = new Set<string>();
      map.set(a, set);
    }
    set.add(b);
  };
  for (const e of edges) {
    link(e.from, e.to);
    link(e.to, e.from);
  }
  return map;
};

/** Classify a node for highlight: diff overlay wins, then focus/neighbour. */
const classify = (
  id: string,
  focusId: string | null,
  neighbors: Map<string, Set<string>>,
  changed?: Set<string>,
  impacted?: Set<string>
): Highlight => {
  if (changed?.has(id)) return 'changed';
  if (impacted?.has(id)) return 'impacted';
  if (!focusId) return 'none';
  if (id === focusId) return 'focus';
  return neighbors.get(focusId)?.has(id) ? 'neighbor' : 'dim';
};

/** The custom node renderer: a colour-dot pill, shaped by kind. */
const C4GraphNode: React.FC<NodeProps<C4FlowNode>> = ({ data, selected }) => {
  const { label, color, dot, font, bold, highlight, kind, id } = data;
  const dimmed = highlight === 'dim';
  const emphasized = highlight === 'focus' || highlight === 'changed' || selected;
  const isActor = kind === 'actor' || kind === 'external' || kind === 'system';
  const ring =
    highlight === 'changed'
      ? 'shadow-[0_0_0_2px_var(--color-warning)]'
      : highlight === 'impacted'
        ? 'shadow-[0_0_0_2px_var(--color-primary-light-3)]'
        : emphasized
          ? 'shadow-[0_0_0_2px_var(--primary)] border-primary'
          : 'border-arco-2';
  return (
    <div
      title={id}
      className={`flex items-center gap-8px w-full h-full px-10px border bg-2 transition-all duration-150 ${isActor ? 'rd-full' : 'rd-10px'} ${ring}`}
      style={{ opacity: dimmed ? 0.3 : 1 }}
    >
      <Handle type='target' position={Position.Left} style={HANDLE_STYLE} isConnectable={false} />
      <span className='shrink-0 rd-full' style={{ width: dot, height: dot, backgroundColor: color }} aria-hidden />
      <span className='truncate text-t-primary leading-none' style={{ fontSize: font, fontWeight: bold ? 600 : 400 }}>
        {label}
      </span>
      <Handle type='source' position={Position.Right} style={HANDLE_STYLE} isConnectable={false} />
    </div>
  );
};

const MemoC4GraphNode = React.memo(C4GraphNode);

const FIT_VIEW_OPTIONS = { padding: 0.2 } as const;

const C4GraphView: React.FC<C4GraphViewProps> = ({
  view,
  selectedId,
  layout,
  changedIds,
  impactedIds,
  onSelectNode,
}) => {
  const { t } = useTranslation();
  const [theme] = useTheme();
  const [hoverId, setHoverId] = useState<string | null>(null);

  const model = useMemo(() => {
    const maxWeight = view.nodes.reduce((m, n) => Math.max(m, n.weight), 0);
    const flowNodes = layout === 'force' ? layoutForce(view, maxWeight) : layoutColumns(view, maxWeight);
    const flowEdges = view.edges.map(baseEdge);
    return { flowNodes, flowEdges, neighbors: buildNeighbors(view.edges), layers: presentLayers(view) };
  }, [view, layout]);

  const nodeTypes = useMemo<NodeTypes>(() => ({ c4: MemoC4GraphNode }), []);
  const [nodes, setNodes, onNodesChange] = useNodesState<C4FlowNode>(model.flowNodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>(model.flowEdges);

  useEffect(() => {
    setNodes(model.flowNodes);
    setEdges(model.flowEdges);
  }, [model, setNodes, setEdges]);

  const focusId = hoverId ?? selectedId;

  useEffect(() => {
    setNodes((prev) =>
      prev.map((node) => {
        const highlight = classify(node.id, focusId, model.neighbors, changedIds, impactedIds);
        const isSelected = node.id === selectedId;
        if (node.data.highlight === highlight && node.selected === isSelected) return node;
        return { ...node, selected: isSelected, data: { ...node.data, highlight } };
      })
    );
  }, [focusId, selectedId, model, changedIds, impactedIds, setNodes]);

  const handleNodeClick = useCallback<NodeMouseHandler<C4FlowNode>>(
    (_e, node) => onSelectNode(node.id),
    [onSelectNode]
  );
  const handleEnter = useCallback<NodeMouseHandler<C4FlowNode>>((_e, node) => setHoverId(node.id), []);
  const handleLeave = useCallback<NodeMouseHandler<C4FlowNode>>(() => setHoverId(null), []);
  const minimapColor = useCallback((node: C4FlowNode) => node.data.color, []);

  return (
    <div className='size-full bg-fill-1'>
      <ReactFlow<C4FlowNode, Edge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onNodeMouseEnter={handleEnter}
        onNodeMouseLeave={handleLeave}
        colorMode={theme}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={0.1}
        maxZoom={2}
        nodesConnectable={false}
        nodesDraggable
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
        aria-label={t('ide.understand.graph.ariaLabel')}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color='var(--color-fill-3)' />
        <Controls showInteractive={false} aria-label={t('ide.understand.graph.controlsLabel')} />
        <MiniMap<C4FlowNode>
          nodeColor={minimapColor}
          nodeStrokeWidth={0}
          pannable
          zoomable
          ariaLabel={t('ide.understand.graph.minimapLabel')}
        />
        {model.layers.length > 0 ? (
          <Panel position='top-left'>
            <div className='max-w-200px max-h-200px overflow-y-auto flex flex-col gap-5px px-12px py-10px rd-8px bg-2 border border-arco-2 shadow-sm'>
              <span className='text-12px font-600 text-t-secondary'>{t('ide.understand.graph.legendTitle')}</span>
              {model.layers.map((layer) => (
                <span key={layer} className='flex items-center gap-6px text-12px text-t-primary'>
                  <span
                    className='shrink-0 size-8px rd-full'
                    style={{ backgroundColor: LAYER_COLORS[layer] }}
                    aria-hidden
                  />
                  <span className='truncate'>{t(`ide.understand.layer.${layer}`)}</span>
                </span>
              ))}
            </div>
          </Panel>
        ) : null}
      </ReactFlow>
    </div>
  );
};

export default C4GraphView;

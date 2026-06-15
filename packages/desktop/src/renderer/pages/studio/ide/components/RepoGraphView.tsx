/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `RepoGraphView` — an interactive dependency-graph visualization for the
 * scanned repo, built on React Flow (`@xyflow/react`). The backend graph is
 * converted once (memoized) into deterministically positioned nodes/edges:
 * files are grouped/coloured by their top-level folder and laid out in
 * concentric rings ordered by in-degree, so the most-imported "hub" modules sit
 * near the centre and read larger.
 *
 * Selecting a node calls `onSelectNode` (the parent focuses its explain panel on
 * that file); the `selectedId` prop — and hover — highlight the focused node
 * plus its direct neighbours and dim everything else. Pan/zoom, a minimap, and
 * fit-to-view come from React Flow. Dragging is allowed (positions are local
 * state), but the graph is not editable: connecting is disabled.
 *
 * Renderer-only; all fixed text via i18n; Arco/UnoCSS tokens for chrome, with
 * the categorical group palette as the only (data-viz) raw colours.
 */

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type NodeMouseHandler,
  type NodeTypes,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useTheme from '@renderer/hooks/system/useTheme';
import type { RepoGraph } from '../ideClient';
import RepoGraphNode from './RepoGraphNode';
import {
  colorForGroup,
  computeHighlight,
  computeRepoLayout,
  styleRepoEdges,
  type RepoFlowEdge,
  type RepoFlowNode,
} from './repoGraphLayout';

type RepoGraphViewProps = {
  graph: RepoGraph;
  selectedId: string | null;
  onSelectNode: (id: string) => void;
};

/** Fit-to-view padding so the ring layout isn't cropped at the edges. */
const FIT_VIEW_OPTIONS = { padding: 0.18 } as const;

const RepoGraphView: React.FC<RepoGraphViewProps> = ({ graph, selectedId, onSelectNode }) => {
  const { t } = useTranslation();
  const [theme] = useTheme();
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Heavy conversion: memoized on the graph reference so it doesn't recompute
  // on every render (graphs can hold up to ~400 nodes).
  const layout = useMemo(() => computeRepoLayout(graph), [graph]);

  const nodeTypes = useMemo<NodeTypes>(() => ({ repo: RepoGraphNode }), []);

  const [nodes, setNodes, onNodesChange] = useNodesState<RepoFlowNode>(layout.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RepoFlowEdge>(layout.edges);

  // Reset positions/edges when a fresh graph is scanned.
  useEffect(() => {
    setNodes(layout.nodes);
    setEdges(layout.edges);
  }, [layout, setNodes, setEdges]);

  // Hover wins over selection for the active focus.
  const focusId = hoverId ?? selectedId;

  // Re-skin nodes/edges for the current focus without disturbing drag positions.
  useEffect(() => {
    setNodes((prev) =>
      prev.map((node) => {
        const highlight = computeHighlight(node.id, focusId, layout.neighbors);
        const selected = node.id === selectedId;
        if (node.data.highlight === highlight && node.selected === selected) return node;
        return { ...node, selected, data: { ...node.data, highlight } };
      })
    );
    setEdges(styleRepoEdges(layout.edges, focusId, layout.colorById));
  }, [focusId, selectedId, layout, setNodes, setEdges]);

  const handleNodeClick = useCallback<NodeMouseHandler<RepoFlowNode>>(
    (_event, node) => onSelectNode(node.id),
    [onSelectNode]
  );
  const handleNodeEnter = useCallback<NodeMouseHandler<RepoFlowNode>>((_event, node) => setHoverId(node.id), []);
  const handleNodeLeave = useCallback<NodeMouseHandler<RepoFlowNode>>(() => setHoverId(null), []);
  const minimapNodeColor = useCallback((node: RepoFlowNode) => node.data.color, []);

  return (
    <div className='size-full bg-fill-1'>
      <ReactFlow<RepoFlowNode, RepoFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onNodeMouseEnter={handleNodeEnter}
        onNodeMouseLeave={handleNodeLeave}
        colorMode={theme}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={0.1}
        maxZoom={2}
        nodesConnectable={false}
        nodesDraggable
        onlyRenderVisibleElements
        proOptions={{ hideAttribution: true }}
        aria-label={t('ide.graph.ariaLabel')}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color='var(--color-fill-3)' />
        <Controls showInteractive={false} aria-label={t('ide.graph.controlsLabel')} />
        <MiniMap<RepoFlowNode>
          nodeColor={minimapNodeColor}
          nodeStrokeWidth={0}
          pannable
          zoomable
          ariaLabel={t('ide.graph.minimapLabel')}
        />
        {layout.groups.length > 0 ? (
          <Panel position='top-left'>
            <div className='max-w-220px max-h-160px overflow-y-auto flex flex-col gap-6px px-12px py-10px rd-8px bg-2 border border-arco-2 shadow-sm'>
              <span className='text-12px font-600 text-t-secondary'>{t('ide.graph.legendTitle')}</span>
              <div className='flex flex-col gap-4px'>
                {layout.groups.map((group) => (
                  <span key={group} className='flex items-center gap-6px text-12px text-t-primary'>
                    <span
                      className='shrink-0 size-8px rd-full'
                      style={{ backgroundColor: colorForGroup(group, layout.groups) }}
                      aria-hidden
                    />
                    <span className='truncate'>{group}</span>
                  </span>
                ))}
              </div>
            </div>
          </Panel>
        ) : null}
      </ReactFlow>
    </div>
  );
};

export default RepoGraphView;

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `SchemaDiagram` — an interactive ER / schema diagram for a connected database,
 * built on React Flow (`@xyflow/react`). Each table is a card ({@link DbTableNode})
 * listing its columns; each foreign key is an edge from the child table to the
 * referenced parent. Hovering a table accents its relationships and dims the
 * rest, so the shape of the schema reads at a glance.
 *
 * The backend {@link DbSchemaGraph} is converted once (memoized) into a
 * deterministic masonry layout. Pan / zoom / minimap / fit-to-view come from
 * React Flow; dragging is allowed but the graph is not editable.
 *
 * Renderer-only; Arco/UnoCSS tokens for chrome; all fixed text via i18n.
 */

import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
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
import type { DbSchemaGraph } from './dbClient';
import DbTableNode from './DbTableNode';
import {
  computeHighlight,
  computeSchemaLayout,
  styleSchemaEdges,
  type DbFlowEdge,
  type DbFlowNode,
} from './dbSchemaLayout';

type SchemaDiagramProps = {
  graph: DbSchemaGraph;
};

/** Fit-to-view padding so the masonry layout isn't cropped. */
const FIT_VIEW_OPTIONS = { padding: 0.2 } as const;

const SchemaDiagram: React.FC<SchemaDiagramProps> = ({ graph }) => {
  const { t } = useTranslation();
  const [theme] = useTheme();
  const [hoverId, setHoverId] = useState<string | null>(null);

  const layout = useMemo(() => computeSchemaLayout(graph), [graph]);
  const nodeTypes = useMemo<NodeTypes>(() => ({ dbtable: DbTableNode }), []);

  const [nodes, setNodes, onNodesChange] = useNodesState<DbFlowNode>(layout.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState<DbFlowEdge>(layout.edges);

  // Reset when a fresh schema graph arrives.
  useEffect(() => {
    setNodes(layout.nodes);
    setEdges(layout.edges);
  }, [layout, setNodes, setEdges]);

  // Re-skin nodes/edges for the hovered table without disturbing drag positions.
  useEffect(() => {
    setNodes((prev) =>
      prev.map((node) => {
        const highlight = computeHighlight(node.id, hoverId, layout.neighbors);
        if (node.data.highlight === highlight) return node;
        return { ...node, data: { ...node.data, highlight } };
      })
    );
    setEdges(styleSchemaEdges(layout.edges, hoverId));
  }, [hoverId, layout, setNodes, setEdges]);

  const handleNodeEnter = useCallback<NodeMouseHandler<DbFlowNode>>((_e, node) => setHoverId(node.id), []);
  const handleNodeLeave = useCallback<NodeMouseHandler<DbFlowNode>>(() => setHoverId(null), []);

  if (graph.tables.length === 0) {
    return (
      <div className='size-full flex-center'>
        <span className='text-12px text-t-tertiary'>{t('ide.db.diagramEmpty')}</span>
      </div>
    );
  }

  return (
    <div className='size-full bg-fill-1'>
      <ReactFlow<DbFlowNode, DbFlowEdge>
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
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
        aria-label={t('ide.db.diagramAria')}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color='var(--color-fill-3)' />
        <Controls showInteractive={false} />
        <MiniMap<DbFlowNode> nodeColor='var(--color-fill-3)' nodeStrokeWidth={0} pannable zoomable />
      </ReactFlow>
    </div>
  );
};

export default SchemaDiagram;

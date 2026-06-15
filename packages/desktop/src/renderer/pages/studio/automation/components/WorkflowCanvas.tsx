/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `WorkflowCanvas` — the React Flow (`@xyflow/react`) surface for the workflow
 * editor. It renders the {@link StepNode} custom nodes wired into a single
 * top-to-bottom chain of edges so the free-form canvas still reads as the
 * deterministic linear pipeline the engine executes.
 *
 * The component is presentational and fully controlled: nodes / edges / change
 * handlers are owned by {@link WorkflowEditor}; selection is driven by the
 * `selected` flag on each node (a projection of the editor's active id). Node
 * order is derived from Y position at save time, not from this component.
 *
 * Renderer-only. Arco + icon-park + UnoCSS tokens; React Flow's bundled CSS
 * (imported once here) handles the canvas chrome in both light and dark themes.
 */

import '@xyflow/react/dist/style.css';
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  type ColorMode,
  type Edge,
  type NodeTypes,
  type OnNodesChange,
} from '@xyflow/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import StepNode, { StepNodeActionsProvider, type StepNodeType } from './nodes/StepNode';

/** Static node-type registry (defined once so React Flow does not warn on re-creation). */
const NODE_TYPES: NodeTypes = { step: StepNode };

type WorkflowCanvasProps = {
  /** Controlled React Flow nodes (each `selected` flag mirrors the active step). */
  nodes: StepNodeType[];
  /** Controlled chain edges connecting the nodes top-to-bottom. */
  edges: Edge[];
  /** React Flow change handler (drag / dimensions / remove); selection is ignored. */
  onNodesChange: OnNodesChange<StepNodeType>;
  /** Select a step (drives the config panel). */
  onSelect: (id: string | null) => void;
  /** Remove a step from the pipeline. */
  onDelete: (id: string) => void;
  /** Follow the app theme so the canvas chrome stays legible in light and dark. */
  colorMode: ColorMode;
};

const WorkflowCanvas: React.FC<WorkflowCanvasProps> = ({
  nodes,
  edges,
  onNodesChange,
  onSelect,
  onDelete,
  colorMode,
}) => {
  const { t } = useTranslation();

  return (
    <div className='size-full bg-fill-1'>
      <StepNodeActionsProvider value={{ onDelete }}>
        <ReactFlow<StepNodeType>
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onNodeClick={(_, node) => onSelect(node.id)}
          onPaneClick={() => onSelect(null)}
          onNodesDelete={(deleted) => deleted.forEach((node) => onDelete(node.id))}
          colorMode={colorMode}
          fitView
          fitViewOptions={{ padding: 0.25, maxZoom: 1 }}
          minZoom={0.3}
          maxZoom={1.75}
          deleteKeyCode={['Delete', 'Backspace']}
          proOptions={{ hideAttribution: true }}
          nodesConnectable={false}
          className='size-full'
        >
          <Background variant={BackgroundVariant.Dots} gap={18} size={1} />
          <Controls showInteractive={false} aria-label={t('automation.canvas.controls')} />
          <MiniMap pannable zoomable ariaLabel={t('automation.canvas.minimap')} />
        </ReactFlow>
      </StepNodeActionsProvider>
    </div>
  );
};

export default WorkflowCanvas;

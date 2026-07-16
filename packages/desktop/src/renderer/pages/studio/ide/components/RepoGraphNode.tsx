/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `RepoGraphNode` — the custom React Flow node used by {@link RepoGraphView}.
 * Renders a compact pill: a categorical colour dot (sized by in-degree) plus
 * the file's basename. Selection, neighbour, and dimmed states are driven by
 * the `highlight` flag in the node data so the surrounding graph reads clearly
 * when a file is focused.
 *
 * Styling uses UnoCSS semantic tokens (Arco surface/border/text variables); the
 * only raw colour is the group's data-viz hue carried in `data.color`. The two
 * `Handle`s are hidden connectors that let edges attach to the pill — the graph
 * is not user-editable, so connecting is disabled at the flow level.
 *
 * Renderer-only.
 */

import { Handle, Position, type NodeProps } from '@xyflow/react';
import React from 'react';
import type { RepoFlowNode } from './repoGraphLayout';

/** Hidden handle style — present for edge attachment, invisible to the user. */
const HANDLE_STYLE: React.CSSProperties = {
  opacity: 0,
  width: 1,
  height: 1,
  minWidth: 1,
  minHeight: 1,
  border: 'none',
  background: 'transparent',
};

const RepoGraphNode: React.FC<NodeProps<RepoFlowNode>> = ({ data, selected }) => {
  const { label, color, dot, font, bold, highlight } = data;
  const dimmed = highlight === 'dim';
  const emphasized = highlight === 'focus' || selected;

  return (
    <div
      title={data.path}
      className={`flex items-center gap-8px w-full h-full px-10px rd-full border bg-2 transition-all duration-150 ${emphasized ? 'border-primary shadow-[0_0_0_2px_var(--primary)]' : 'border-arco-2'}`}
      style={{ opacity: dimmed ? 0.3 : 1 }}
    >
      <Handle type='target' position={Position.Top} style={HANDLE_STYLE} isConnectable={false} />
      <span className='shrink-0 rd-full' style={{ width: dot, height: dot, backgroundColor: color }} aria-hidden />
      <span className='truncate text-t-primary leading-none' style={{ fontSize: font, fontWeight: bold ? 600 : 400 }}>
        {label}
      </span>
      <Handle type='source' position={Position.Bottom} style={HANDLE_STYLE} isConnectable={false} />
    </div>
  );
};

export default React.memo(RepoGraphNode);

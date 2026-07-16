/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `StepNode` — the custom React Flow node that renders one {@link WorkflowNode}
 * on the canvas. It shows the kind icon + accent, the step name, and the kind
 * label, with a target handle on top and a source handle on the bottom so the
 * vertical pipeline reads as a chain. A small delete button (Arco) removes the
 * step; the engine still executes nodes in top-to-bottom (Y) order.
 *
 * Node-level callbacks (delete) are provided through {@link StepNodeActionsProvider}
 * so the node `data` stays a pure projection of the persisted model. Renderer
 * only; Arco + icon-park + UnoCSS tokens; all text via i18n.
 */

import { Button } from '@arco-design/web-react';
import { Delete } from '@icon-park/react';
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import React, { createContext, useContext, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import type { WorkflowNode, WorkflowNodeKind } from '../../automationClient';
import { metaFor } from '../../nodeKindMeta';

/** The slice of a {@link WorkflowNode} the canvas node needs to render. */
export type StepNodeData = {
  /** Node kind — drives icon, accent, and label. */
  kind: WorkflowNodeKind;
  /** User-facing step name. */
  name: string;
  /** Per-kind configuration (opaque to the canvas; edited in the side panel). */
  config: Record<string, unknown>;
  /** Control-flow child pipelines (then/else/body/try/catch/case:*…). Preserved across the canvas round-trip. */
  branches?: Record<string, WorkflowNode[]>;
  /** Per-node error/retry policy. Preserved across the canvas round-trip. */
  onError?: { retries?: number; retryDelayMs?: number; continueOnError?: boolean };
};

/** A React Flow node carrying {@link StepNodeData} under the `step` type. */
export type StepNodeType = Node<StepNodeData, 'step'>;

/** Imperative actions a {@link StepNode} can trigger on its owning editor. */
type StepNodeActions = {
  /** Remove the step with the given id from the pipeline. */
  onDelete: (id: string) => void;
};

const StepNodeActionsContext = createContext<StepNodeActions>({ onDelete: () => undefined });

/** Provides node-level callbacks to every {@link StepNode} below it in the tree. */
export const StepNodeActionsProvider = StepNodeActionsContext.Provider;

/** Read the node-level actions inside a {@link StepNode}. */
export const useStepNodeActions = (): StepNodeActions => useContext(StepNodeActionsContext);

const StepNode: React.FC<NodeProps<StepNodeType>> = ({ id, data, selected }) => {
  const { t } = useTranslation();
  const { onDelete } = useStepNodeActions();
  const meta = useMemo(() => metaFor(data.kind), [data.kind]);
  const Icon = meta.Icon;

  return (
    <div
      className={`group relative w-220px rd-12px border bg-base px-12px py-10px transition-all duration-150 ${selected ? 'border-primary shadow-md' : 'border-b-1 hover:border-b-2'}`}
    >
      <Handle type='target' position={Position.Top} />
      <div className='flex items-center gap-10px'>
        <span className={`flex-center shrink-0 size-32px rd-9px bg-fill-2 ${meta.accentClass}`}>
          <Icon theme='outline' size={18} fill='currentColor' />
        </span>
        <span className='flex flex-col min-w-0 flex-1'>
          <span className='text-13px font-[600] text-t-primary truncate'>{data.name || t(meta.labelKey)}</span>
          <span className='text-11px text-t-tertiary truncate'>{t(meta.labelKey)}</span>
        </span>
        <span className='nodrag nopan shrink-0 opacity-0 group-hover:opacity-100 transition-opacity'>
          <Button
            type='text'
            size='mini'
            status='danger'
            aria-label={t('automation.node.remove')}
            title={t('automation.node.remove')}
            icon={<Delete theme='outline' size={13} />}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(id);
            }}
          />
        </span>
      </div>
      <Handle type='source' position={Position.Bottom} />
    </div>
  );
};

export default StepNode;

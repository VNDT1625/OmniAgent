/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `LinkGraphView` — an Obsidian-style graph of the Learn notes' `[[wiki]]`
 * links. Each note is a node sized by its connection count; each resolved link
 * is an edge. Hovering or selecting a note highlights it and its neighbours and
 * dims the rest; clicking a node opens that note. Nodes can be dragged to
 * rearrange the layout.
 *
 * Rendering is a dependency-free inline SVG over the positions computed by
 * {@link simulateLayout}. The layout runs once per notes-set change (memoised);
 * dragging only updates the dragged node, so it stays smooth. Colours come from
 * CSS variables (semantic tokens) — never hardcoded — so it matches light/dark.
 *
 * Renderer-only. No Node.js APIs.
 */

import React, { useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Note } from '@process/manager/managerTypes';
import { buildLinkGraph, simulateLayout, type GraphNode } from './linkGraph';

type Props = {
  notes: Note[];
  /** Currently-selected note id (highlighted), if any. */
  selectedId: string | null;
  /** Open a note by id (click on a node). */
  onSelect: (id: string) => void;
};

/** SVG viewport (logical units; the SVG scales responsively via viewBox). */
const VIEW_W = 800;
const VIEW_H = 520;
const PADDING = 48;

/** Map a layout coord in [0,1] to the padded SVG viewport. */
const sx = (x: number): number => PADDING + x * (VIEW_W - 2 * PADDING);
const sy = (y: number): number => PADDING + y * (VIEW_H - 2 * PADDING);

/** Node radius from its degree (more links → bigger), clamped. */
const radiusOf = (degree: number): number => Math.min(18, 6 + degree * 2);

const LinkGraphView: React.FC<Props> = ({ notes, selectedId, onSelect }) => {
  const { t } = useTranslation();

  // Build + lay out the graph once per notes-set change. Dragging mutates a
  // local copy, so we keep positions in state seeded from the simulation.
  const initial = useMemo(() => simulateLayout(buildLinkGraph(notes)), [notes]);
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<{ id: string } | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);

  // Effective position: dragged override, else simulated.
  const posOf = (node: GraphNode): { x: number; y: number } => positions[node.id] ?? { x: node.x, y: node.y };

  const activeId = hoverId ?? selectedId;
  /** Set of node ids adjacent to the active node (incl. itself), for highlight. */
  const neighbourIds = useMemo(() => {
    if (!activeId) return null;
    const set = new Set<string>([activeId]);
    for (const e of initial.edges) {
      if (e.source === activeId) set.add(e.target);
      if (e.target === activeId) set.add(e.source);
    }
    return set;
  }, [activeId, initial.edges]);

  const isDimmed = (id: string): boolean => neighbourIds != null && !neighbourIds.has(id);

  // --- Dragging ------------------------------------------------------------
  const clientToLayout = (clientX: number, clientY: number): { x: number; y: number } => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    // Convert screen px → viewBox units → [0,1] layout space.
    const vx = ((clientX - rect.left) / rect.width) * VIEW_W;
    const vy = ((clientY - rect.top) / rect.height) * VIEW_H;
    return {
      x: (vx - PADDING) / (VIEW_W - 2 * PADDING),
      y: (vy - PADDING) / (VIEW_H - 2 * PADDING),
    };
  };

  const onPointerDownNode = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    dragRef.current = { id };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragRef.current) return;
    const { x, y } = clientToLayout(e.clientX, e.clientY);
    const clamped = { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
    setPositions((prev) => ({ ...prev, [dragRef.current!.id]: clamped }));
  };

  const movedRef = useRef(false);
  const onPointerDownNodeWrapped = (id: string) => (e: React.PointerEvent) => {
    movedRef.current = false;
    onPointerDownNode(id)(e);
  };
  const onPointerMoveWrapped = (e: React.PointerEvent) => {
    if (dragRef.current) movedRef.current = true;
    onPointerMove(e);
  };
  const onPointerUpNode = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    const wasDragging = dragRef.current?.id === id;
    dragRef.current = null;
    // A click (no real drag) opens the note.
    if (wasDragging && !movedRef.current) onSelect(id);
  };

  if (initial.nodes.length === 0) {
    return (
      <div className='h-full flex items-center justify-center text-13px text-t-tertiary'>
        {t('manager.notes.learn.graphEmpty')}
      </div>
    );
  }

  return (
    <div className='h-full w-full flex flex-col'>
      <div className='shrink-0 flex items-center gap-8px px-4px pb-8px text-12px text-t-tertiary'>
        <span>{t('manager.notes.learn.graphStats', { nodes: initial.nodes.length, edges: initial.edges.length })}</span>
        <span className='opacity-60'>· {t('manager.notes.learn.graphHint')}</span>
      </div>
      <div className='flex-1 min-h-0 rd-12px border border-solid border-arco-2 bg-fill-1 overflow-hidden'>
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className='w-full h-full select-none touch-none'
          onPointerMove={onPointerMoveWrapped}
          onPointerUp={() => {
            dragRef.current = null;
          }}
        >
          {/* Edges */}
          <g>
            {initial.edges.map((e, i) => {
              const a = initial.nodes.find((nd) => nd.id === e.source);
              const b = initial.nodes.find((nd) => nd.id === e.target);
              if (!a || !b) return null;
              const pa = posOf(a);
              const pb = posOf(b);
              const dim = isDimmed(e.source) || isDimmed(e.target);
              const active = neighbourIds != null && neighbourIds.has(e.source) && neighbourIds.has(e.target);
              return (
                <line
                  key={i}
                  x1={sx(pa.x)}
                  y1={sy(pa.y)}
                  x2={sx(pb.x)}
                  y2={sy(pb.y)}
                  stroke={active ? 'var(--color-primary-6, #4080ff)' : 'var(--color-border-2, #c9cdd4)'}
                  strokeWidth={active ? 1.6 : 1}
                  opacity={dim ? 0.15 : 0.7}
                />
              );
            })}
          </g>

          {/* Nodes */}
          <g>
            {initial.nodes.map((node) => {
              const p = posOf(node);
              const r = radiusOf(node.degree);
              const cx = sx(p.x);
              const cy = sy(p.y);
              const isSelected = node.id === selectedId;
              const dim = isDimmed(node.id);
              return (
                <g
                  key={node.id}
                  transform={`translate(${cx} ${cy})`}
                  className='cursor-pointer'
                  opacity={dim ? 0.3 : 1}
                  onPointerDown={onPointerDownNodeWrapped(node.id)}
                  onPointerUp={onPointerUpNode(node.id)}
                  onPointerEnter={() => setHoverId(node.id)}
                  onPointerLeave={() => setHoverId(null)}
                >
                  <circle
                    r={r}
                    fill={isSelected ? 'var(--color-primary-6, #4080ff)' : 'var(--color-primary-3, #94bfff)'}
                    stroke={isSelected ? 'var(--color-primary-6, #4080ff)' : 'var(--color-bg-2, #fff)'}
                    strokeWidth={2}
                  />
                  <text
                    y={r + 13}
                    textAnchor='middle'
                    fontSize={12}
                    fill='var(--color-text-2, #4e5969)'
                    style={{ pointerEvents: 'none' }}
                  >
                    {node.title.length > 22 ? `${node.title.slice(0, 22)}…` : node.title}
                  </text>
                </g>
              );
            })}
          </g>
        </svg>
      </div>
    </div>
  );
};

export default LinkGraphView;

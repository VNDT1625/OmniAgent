/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Lays out the parallel surface frames as an even, responsive grid — one column
 * per running sub-agent — so "search web A" and "edit B" appear side by side,
 * each scaled to fit while staying large enough for both the user and the agent
 * to work with.
 *
 * Renderer-only; Arco + UnoCSS. The grid uses CSS `grid-template-columns:
 * repeat(N, 1fr)` capped at 3 columns so frames never get too small; extra
 * surfaces wrap to a new row.
 */

import { Empty } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SurfaceState } from '@process/workspace/surfaceTypes';
import type { SurfaceLogLine } from '../useWorkspaceRun';
import SurfaceFrame from './SurfaceFrame';

/** Props for {@link SurfaceGrid}. */
export type SurfaceGridProps = {
  /** The live surfaces to render (one frame each). */
  surfaces: SurfaceState[];
  /** Per-surface narration logs keyed by surface id. */
  logs: Record<string, SurfaceLogLine[]>;
};

/** Maximum columns before frames wrap to a new row (keeps each frame usable). */
const MAX_COLUMNS = 3;

/** The parallel-frame grid. */
const SurfaceGrid: React.FC<SurfaceGridProps> = ({ surfaces, logs }) => {
  const { t } = useTranslation();

  if (surfaces.length === 0) {
    return (
      <div className='flex-center h-full w-full'>
        <Empty description={t('workspace.empty')} />
      </div>
    );
  }

  const columns = Math.min(MAX_COLUMNS, surfaces.length);

  return (
    <div
      className='grid gap-12px h-full w-full min-h-0 overflow-auto auto-rows-fr'
      style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}
    >
      {surfaces.map((surface) => (
        <SurfaceFrame key={surface.id} surface={surface} log={logs[surface.id] ?? []} reloadTick={0} />
      ))}
    </div>
  );
};

export default SurfaceGrid;

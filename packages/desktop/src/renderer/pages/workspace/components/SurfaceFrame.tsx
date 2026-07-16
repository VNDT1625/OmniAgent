/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * One **live surface frame** in the workspace — a scaled card showing a single
 * sub-agent's work (a browser tab or an editor file) plus its live tool
 * narration. Several of these render side-by-side while their sub-agents run in
 * parallel.
 *
 * The frame is presentational: it renders the right body for the surface kind
 * ({@link BrowserSurfaceView} for browser, {@link EditorSurfaceView} for editor)
 * and the narration log beneath it. All Arco + UnoCSS semantic tokens; no raw
 * interactive HTML, no hardcoded colours.
 */

import { Empty, Spin, Typography } from '@arco-design/web-react';
import { Components, Compass } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { SurfaceState } from '@process/workspace/surfaceTypes';
import type { SurfaceLogLine } from '../useWorkspaceRun';
import BrowserSurfaceView from './BrowserSurfaceView';
import EditorSurfaceView from './EditorSurfaceView';
import SurfaceStatusBadge from './SurfaceStatusBadge';

/** Props for {@link SurfaceFrame}. */
export type SurfaceFrameProps = {
  /** The surface this frame renders. */
  surface: SurfaceState;
  /** The surface's narration log (tool steps + observations). */
  log: SurfaceLogLine[];
  /** How many editor writes have happened (drives the editor preview reload). */
  reloadTick: number;
};

/** Count of `write`/successful steps used to bump the editor preview. */
const writeCount = (log: SurfaceLogLine[]): number =>
  log.filter((line) => line.tool === 'write' && line.status === 'ok').length;

/** A single live surface frame (header + body + narration). */
const SurfaceFrame: React.FC<SurfaceFrameProps> = ({ surface, log }) => {
  const { t } = useTranslation();
  const Icon = surface.kind === 'browser' ? Compass : Components;
  const isSettled = surface.status === 'done' || surface.status === 'error' || surface.status === 'stopped';
  const isPreparing = surface.status === 'queued' || surface.status === 'starting';

  return (
    <div className='flex flex-col min-h-0 rd-12px border border-solid border-line-2 bg-base overflow-hidden'>
      {/* Header: kind icon + title + status pill */}
      <div className='flex items-center gap-8px px-12px py-8px border-b border-solid border-line-2 bg-fill-1 shrink-0'>
        <span className='size-22px flex-center rd-6px bg-fill-2 text-t-secondary shrink-0'>
          <Icon theme='outline' size='14' />
        </span>
        <Typography.Text className='flex-1 m-0 text-13px font-600 text-t-primary truncate' title={surface.title}>
          {surface.title}
        </Typography.Text>
        <SurfaceStatusBadge status={surface.status} />
      </div>

      {/* Body: the scaled live view (browser overlay / editor preview) */}
      <div className='relative flex-1 min-h-160px'>
        {isPreparing ? (
          <div className='flex-center h-full w-full'>
            <Spin tip={t('workspace.surface.preparing')} />
          </div>
        ) : surface.kind === 'browser' ? (
          surface.tabId ? (
            <BrowserSurfaceView tabId={surface.tabId} active={!isSettled || surface.status === 'done'} />
          ) : (
            <Empty description={t('workspace.surface.noView')} />
          )
        ) : surface.filePath ? (
          <EditorSurfaceView filePath={surface.filePath} reloadTick={writeCount(log)} />
        ) : (
          <Empty description={t('workspace.surface.noFile')} />
        )}
      </div>

      {/* Narration: the sub-agent's live tool steps for this surface */}
      <div className='flex flex-col gap-2px max-h-120px overflow-auto px-12px py-8px border-t border-solid border-line-2 bg-fill-1 shrink-0'>
        {log.length === 0 ? (
          <span className='text-12px text-t-tertiary'>{t('workspace.surface.idleSteps')}</span>
        ) : (
          log.map((line) => (
            <div key={line.id} className='flex items-center gap-6px text-12px font-mono'>
              <span
                className={
                  line.status === 'ok' ? 'text-success' : line.status === 'fail' ? 'text-danger' : 'text-t-secondary'
                }
              >
                ↳
              </span>
              <span className='flex-1 truncate text-t-secondary' title={line.summary}>
                {line.summary}
              </span>
            </div>
          ))
        )}
        {surface.error ? <span className='text-12px text-danger mt-2px'>{surface.error}</span> : null}
        {surface.answer ? (
          <span className='text-12px text-t-primary mt-4px whitespace-pre-wrap'>{surface.answer}</span>
        ) : null}
      </div>
    </div>
  );
};

export default SurfaceFrame;

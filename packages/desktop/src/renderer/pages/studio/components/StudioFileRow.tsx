/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `StudioFileRow` — one row in the Studio recent/starred list. Shows the
 * file-type glyph, name, parent folder, and relative open time, plus star and
 * remove actions on hover. Presentational; all actions are passed in.
 */

import { Tooltip } from '@arco-design/web-react';
import { Star, StarOne, Close } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { resolveAdapterKind } from '@renderer/pages/editor/editorRegistry';
import { FILE_KIND_META } from '../fileKindMeta';
import type { StudioFileEntry } from '../studioStorage';

/** Parent directory of a path, for the dim secondary line. */
const parentDir = (filePath: string): string => {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return lastSlash <= 0 ? '' : filePath.slice(0, lastSlash);
};

type StudioFileRowProps = {
  entry: StudioFileEntry;
  starred: boolean;
  relativeTime: string;
  onOpen: (path: string) => void;
  onStar: (path: string) => void;
  onRemove?: (path: string) => void;
};

const StudioFileRow: React.FC<StudioFileRowProps> = ({ entry, starred, relativeTime, onOpen, onStar, onRemove }) => {
  const { t } = useTranslation();
  const kind = resolveAdapterKind({ fileName: entry.name });
  const meta = FILE_KIND_META[kind];
  const Icon = meta.Icon;

  return (
    <div
      className='group flex items-center gap-12px px-12px h-52px rd-10px cursor-pointer transition-colors hover:bg-fill-2'
      onClick={() => onOpen(entry.path)}
    >
      <span className={`size-36px flex-center rd-8px bg-fill-1 shrink-0 ${meta.accentClass}`}>
        <Icon theme='outline' size={20} fill='currentColor' />
      </span>
      <div className='flex-1 min-w-0 flex flex-col gap-2px'>
        <span className='text-14px text-t-primary font-[500] truncate leading-tight'>{entry.name}</span>
        <span className='text-12px text-t-tertiary truncate leading-tight'>
          {parentDir(entry.path) || t('studio.local')}
        </span>
      </div>
      <span className='text-12px text-t-tertiary shrink-0 mr-4px tabular-nums'>{relativeTime}</span>
      <div className='flex items-center gap-2px shrink-0' onClick={(e) => e.stopPropagation()}>
        <Tooltip content={starred ? t('studio.action.unstar') : t('studio.action.star')} mini>
          <span
            className={`size-28px flex-center rd-6px cursor-pointer transition-colors hover:bg-fill-3 ${starred ? 'text-warning' : 'text-t-tertiary opacity-0 group-hover:opacity-100'}`}
            onClick={() => onStar(entry.path)}
          >
            {starred ? (
              <Star theme='filled' size={16} fill='currentColor' />
            ) : (
              <StarOne theme='outline' size={16} fill='currentColor' />
            )}
          </span>
        </Tooltip>
        {onRemove ? (
          <Tooltip content={t('studio.action.remove')} mini>
            <span
              className='size-28px flex-center rd-6px cursor-pointer text-t-tertiary opacity-0 group-hover:opacity-100 transition-colors hover:bg-fill-3 hover:text-danger'
              onClick={() => onRemove(entry.path)}
            >
              <Close theme='outline' size={16} fill='currentColor' />
            </span>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
};

export default StudioFileRow;

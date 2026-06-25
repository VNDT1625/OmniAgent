/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `NavResultsPanel` — a floating results list for go-to-definition /
 * find-references. The workspace resolves a symbol via the IDE nav bridge and
 * shows the hits here; clicking a hit opens the file at that line. When there is
 * exactly ONE definition, the workspace jumps straight there without showing
 * this panel (handled by the caller); the panel is for the multi-hit / refs case.
 *
 * Renders with Arco Drawer + UnoCSS tokens; all text via i18n.
 */

import { Drawer, Empty, Spin } from '@arco-design/web-react';
import { CodeBrackets, Find } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { NavHit } from '../ideClient';

type NavResultsPanelProps = {
  open: boolean;
  loading: boolean;
  mode: 'definition' | 'references';
  symbol: string;
  rootPath: string;
  hits: NavHit[];
  onClose: () => void;
  onOpen: (path: string, line: number, column: number) => void;
};

/** Relative path from the root for display. */
const relOf = (abs: string, root: string): string => {
  const r = root.replace(/[/\\]+$/, '');
  const norm = abs.replace(/\\/g, '/');
  const rn = r.replace(/\\/g, '/');
  return norm.startsWith(rn + '/') ? norm.slice(rn.length + 1) : norm;
};

const NavResultsPanel: React.FC<NavResultsPanelProps> = ({
  open,
  loading,
  mode,
  symbol,
  rootPath,
  hits,
  onClose,
  onOpen,
}) => {
  const { t } = useTranslation();
  const title =
    mode === 'definition' ? t('ide.nav.definitionsTitle', { symbol }) : t('ide.nav.referencesTitle', { symbol });

  return (
    <Drawer
      width={460}
      title={
        <span className='flex items-center gap-8px'>
          {mode === 'definition' ? <CodeBrackets theme='outline' size={16} /> : <Find theme='outline' size={16} />}
          <span className='text-14px font-[500]'>{title}</span>
          {!loading ? (
            <span className='text-12px text-t-tertiary'>· {t('ide.nav.count', { count: hits.length })}</span>
          ) : null}
        </span>
      }
      visible={open}
      onCancel={onClose}
      footer={null}
    >
      {loading ? (
        <div className='flex-center h-full'>
          <Spin />
        </div>
      ) : hits.length === 0 ? (
        <Empty description={t('ide.nav.empty', { symbol })} />
      ) : (
        <div className='flex flex-col gap-2px'>
          {hits.map((hit, i) => (
            <button
              key={`${hit.path}:${hit.line}:${i}`}
              type='button'
              onClick={() => onOpen(hit.path, hit.line, hit.column)}
              className='w-full flex flex-col gap-2px px-10px py-7px rd-7px border-none bg-transparent text-left cursor-pointer hover:bg-fill-2 transition-colors'
            >
              <span className='flex items-center gap-6px text-12px'>
                <span className='font-[500] text-t-primary truncate'>{relOf(hit.path, rootPath)}</span>
                <span className='text-t-tertiary'>:{hit.line}</span>
              </span>
              <span className='text-11px text-t-secondary font-mono truncate'>{hit.text}</span>
            </button>
          ))}
        </div>
      )}
    </Drawer>
  );
};

export default NavResultsPanel;

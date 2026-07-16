/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `CommandPalette` — a VS Code-style quick switcher for the IDE workspace.
 *
 *  - **Ctrl/Cmd+P** → file mode: fuzzy-open any file in the repo (sourced from
 *    the import graph's node ids).
 *  - **Ctrl/Cmd+Shift+P** → command mode (prefixed with `>`): run an IDE
 *    command (switch mode, rescan, open hooks, …) supplied by the host.
 *
 * Pure presentation + keyboard nav; the matching is the tested
 * {@link fuzzyFilter}. The host owns the open state and the command list so the
 * palette stays decoupled from the workspace internals.
 *
 * Renders with Arco Modal + UnoCSS tokens; all text via i18n.
 */

import { Modal } from '@arco-design/web-react';
import { FileText, Right } from '@icon-park/react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { basename, fuzzyFilter } from './fuzzyMatch';

/** A runnable command shown in command (`>`) mode. */
export type PaletteCommand = {
  id: string;
  /** Display label (already localised by the host). */
  label: string;
  /** Optional hint shown on the right (e.g. a category). */
  hint?: string;
  run: () => void;
};

type CommandPaletteProps = {
  open: boolean;
  onClose: () => void;
  /** Repo-relative file paths (from the import graph). */
  files: string[];
  /** Open a file by its repo-relative path. */
  onOpenFile: (relPath: string) => void;
  /** Commands available in `>` mode. */
  commands: PaletteCommand[];
  /** Start in command mode (Ctrl+Shift+P). Default false (file mode). */
  initialCommandMode?: boolean;
};

const MAX_RESULTS = 50;

const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  files,
  onOpenFile,
  commands,
  initialCommandMode,
}) => {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset query/selection each time the palette opens; seed `>` for command mode.
  useEffect(() => {
    if (open) {
      setQuery(initialCommandMode ? '>' : '');
      setActiveIndex(0);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open, initialCommandMode]);

  const isCommandMode = query.startsWith('>');
  const term = isCommandMode ? query.slice(1) : query;

  const fileResults = useMemo(
    () => (isCommandMode ? [] : fuzzyFilter(term, files, (f) => f, MAX_RESULTS)),
    [isCommandMode, term, files]
  );
  const commandResults = useMemo(
    () => (isCommandMode ? fuzzyFilter(term, commands, (c) => c.label, MAX_RESULTS) : []),
    [isCommandMode, term, commands]
  );

  const count = isCommandMode ? commandResults.length : fileResults.length;

  // Keep the active index inside the result range as the list changes.
  useEffect(() => {
    setActiveIndex((i) => (count === 0 ? 0 : Math.min(i, count - 1)));
  }, [count]);

  const choose = (index: number): void => {
    if (isCommandMode) {
      const cmd = commandResults[index]?.item;
      if (cmd) {
        onClose();
        cmd.run();
      }
    } else {
      const file = fileResults[index]?.item;
      if (file) {
        onClose();
        onOpenFile(file);
      }
    }
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => (count === 0 ? 0 : (i + 1) % count));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => (count === 0 ? 0 : (i - 1 + count) % count));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(activeIndex);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <Modal visible={open} onCancel={onClose} footer={null} closable={false} style={{ width: 600, top: 80 }} simple>
      <div className='flex flex-col'>
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('ide.palette.placeholder')}
          className='w-full h-40px px-12px rd-8px bg-fill-2 border border-arco-2 text-14px text-t-primary placeholder:text-t-tertiary outline-none focus:border-primary transition-colors'
          aria-label={t('ide.palette.placeholder')}
        />
        <div className='mt-4px text-11px text-t-tertiary px-2px'>
          {isCommandMode ? t('ide.palette.commandHint') : t('ide.palette.fileHint')}
        </div>

        <div className='mt-8px max-h-360px overflow-y-auto -mx-4px'>
          {count === 0 ? (
            <div className='px-12px py-20px text-center text-13px text-t-tertiary'>{t('ide.palette.empty')}</div>
          ) : isCommandMode ? (
            commandResults.map((m, i) => (
              <PaletteRow
                key={m.item.id}
                active={i === activeIndex}
                icon={<Right theme='outline' size={14} />}
                primary={m.item.label}
                secondary={m.item.hint}
                onClick={() => choose(i)}
                onHover={() => setActiveIndex(i)}
              />
            ))
          ) : (
            fileResults.map((m, i) => (
              <PaletteRow
                key={m.item}
                active={i === activeIndex}
                icon={<FileText theme='outline' size={14} />}
                primary={basename(m.item)}
                secondary={m.item}
                onClick={() => choose(i)}
                onHover={() => setActiveIndex(i)}
              />
            ))
          )}
        </div>
      </div>
    </Modal>
  );
};

/** One palette result row. */
const PaletteRow: React.FC<{
  active: boolean;
  icon: React.ReactNode;
  primary: string;
  secondary?: string;
  onClick: () => void;
  onHover: () => void;
}> = ({ active, icon, primary, secondary, onClick, onHover }) => (
  <button
    type='button'
    onClick={onClick}
    onMouseEnter={onHover}
    className={`w-full flex items-center gap-10px px-12px py-7px rd-6px border-none cursor-pointer text-left transition-colors ${active ? 'bg-primary-light-1' : 'bg-transparent hover:bg-fill-2'}`}
  >
    <span className={`shrink-0 ${active ? 'text-primary' : 'text-t-tertiary'}`}>{icon}</span>
    <span className={`shrink-0 text-13px font-500 ${active ? 'text-primary' : 'text-t-primary'}`}>{primary}</span>
    {secondary ? (
      <span className='truncate text-11px text-t-tertiary' title={secondary}>
        {secondary}
      </span>
    ) : null}
  </button>
);

export default CommandPalette;

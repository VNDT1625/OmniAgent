/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `DiffReviewPanel` — the IDE's "review what the agent changed" surface, opened
 * from the Files-mode header banner. The embedded CLI agent edits files straight
 * on disk, so this panel reads the repo's Git working-tree changes and lets the
 * user review them like in Cursor:
 *
 *  - left: the list of changed files (status badge M/A/D/U + path),
 *  - right: the selected file's unified diff, rendered in a read-only Monaco
 *    editor with the `diff` language (green adds / red removes), and
 *  - per-file **Revert** (`git checkout -- <file>`) so a bad edit is one click
 *    to undo, plus **Open** to jump to the file in the editor.
 *
 * Review-only: this never auto-applies anything. "Accept" simply means leaving
 * the change in place (the agent already wrote it); "Revert" discards it. This
 * is intentionally a thin Git wrapper — no custom patch format — so it works for
 * any folder that happens to be a git repo, and stays out of the way otherwise.
 *
 * Renderer-only; Arco + icon-park + UnoCSS tokens; all text via i18n.
 */

import { Button, Empty, Modal, Spin, Tag, Tooltip } from '@arco-design/web-react';
import { Components, Delete, FileEditingOne } from '@icon-park/react';
import MonacoEditor from '@monaco-editor/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import useTheme from '@renderer/hooks/system/useTheme';
import { ideClient, type GitChange } from '../ideClient';

type DiffReviewPanelProps = {
  rootPath: string;
  changes: GitChange[];
  open: boolean;
  onClose: () => void;
  /** Re-check git status after a revert. */
  onChanged: () => void;
  /** Open a changed file in the Files editor (absolute path). */
  onOpenFile: (absPath: string) => void;
};

/** Join a repo root + a forward-slash relative path into an absolute path. */
const toAbs = (root: string, rel: string): string => {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/';
  const normRel = sep === '\\' ? rel.replace(/\//g, '\\') : rel;
  return `${root.replace(/[/\\]+$/, '')}${sep}${normRel}`;
};

/** Status badge colour per change kind. */
const STATUS_COLOR: Record<GitChange['status'], string> = {
  M: 'orange',
  A: 'green',
  U: 'green',
  D: 'red',
  R: 'blue',
  '?': 'gray',
};

const DiffReviewPanel: React.FC<DiffReviewPanelProps> = ({
  rootPath,
  changes,
  open,
  onClose,
  onChanged,
  onOpenFile,
}) => {
  const { t } = useTranslation();
  const [theme] = useTheme();
  const [selected, setSelected] = useState<string | null>(null);
  const [diff, setDiff] = useState<string>('');
  const [loadingDiff, setLoadingDiff] = useState(false);
  const [reverting, setReverting] = useState<string | null>(null);

  // Auto-select the first change when the panel opens / the list changes.
  useEffect(() => {
    if (!open) return;
    if (changes.length === 0) {
      setSelected(null);
      return;
    }
    if (!selected || !changes.some((c) => c.path === selected)) {
      setSelected(changes[0].path);
    }
  }, [open, changes, selected]);

  // Load the unified diff for the selected file.
  useEffect(() => {
    if (!open || !selected) {
      setDiff('');
      return;
    }
    let cancelled = false;
    setLoadingDiff(true);
    void ideClient
      .gitDiff(rootPath, selected)
      .then((result) => {
        if (cancelled) return;
        setDiff(result.ok ? result.data : `// ${(result as { ok: false; error: string }).error}`);
      })
      .catch((error: unknown) => {
        if (!cancelled) setDiff(`// ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        if (!cancelled) setLoadingDiff(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, selected, rootPath]);

  const handleRevert = async (relPath: string): Promise<void> => {
    setReverting(relPath);
    try {
      await ideClient.gitRevertFile(rootPath, relPath).catch((): undefined => undefined);
      onChanged();
    } finally {
      setReverting(null);
    }
  };

  const monacoTheme = theme === 'dark' ? 'vs-dark' : 'light';

  return (
    <Modal
      visible={open}
      onCancel={onClose}
      footer={null}
      title={
        <span className='flex items-center gap-8px'>
          <FileEditingOne theme='outline' size={18} className='text-primary' />
          {t('ide.diff.title')}
          <Tag size='small' className='!text-11px'>
            {t('ide.diff.changeCount', { count: changes.length })}
          </Tag>
        </span>
      }
      style={{ width: '86vw', maxWidth: 1180 }}
      className='ide-diff-modal'
      maskClosable
    >
      <div className='flex h-[68vh] min-h-0 gap-1px rd-10px overflow-hidden border border-arco-2'>
        <ChangeList
          changes={changes}
          selected={selected}
          reverting={reverting}
          onSelect={setSelected}
          onOpen={(rel) => onOpenFile(toAbs(rootPath, rel))}
          onRevert={(rel) => void handleRevert(rel)}
        />
        <div className='flex-1 min-w-0 min-h-0 bg-1'>
          {!selected ? (
            <div className='size-full flex-center'>
              <Empty description={t('ide.diff.empty')} />
            </div>
          ) : loadingDiff ? (
            <div className='size-full flex-center'>
              <Spin />
            </div>
          ) : (
            <MonacoEditor
              key={selected}
              height='100%'
              language='diff'
              theme={monacoTheme}
              value={diff || t('ide.diff.noDiff')}
              options={{
                readOnly: true,
                minimap: { enabled: false },
                lineNumbers: 'off',
                fontSize: 12,
                renderWhitespace: 'none',
                scrollBeyondLastLine: false,
                wordWrap: 'on',
              }}
            />
          )}
        </div>
      </div>
    </Modal>
  );
};

/** Left column: the changed-file list with status badge + per-row actions. */
const ChangeList: React.FC<{
  changes: GitChange[];
  selected: string | null;
  reverting: string | null;
  onSelect: (rel: string) => void;
  onOpen: (rel: string) => void;
  onRevert: (rel: string) => void;
}> = ({ changes, selected, reverting, onSelect, onOpen, onRevert }) => {
  const { t } = useTranslation();
  const baseOf = (p: string): string => p.split('/').pop() ?? p;
  return (
    <aside className='w-300px shrink-0 min-h-0 overflow-y-auto bg-2'>
      {changes.length === 0 ? (
        <div className='p-16px'>
          <Empty description={t('ide.diff.clean')} />
        </div>
      ) : (
        changes.map((change) => {
          const active = change.path === selected;
          return (
            <div
              key={change.path}
              role='button'
              tabIndex={0}
              onClick={() => onSelect(change.path)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onSelect(change.path);
              }}
              className={`group flex items-center gap-8px px-12px py-8px cursor-pointer border-b border-b-1 transition-colors ${active ? 'bg-primary-light-1' : 'hover:bg-fill-2'}`}
            >
              <Tag
                size='small'
                color={STATUS_COLOR[change.status]}
                className='!text-10px !leading-none !px-5px !py-2px shrink-0'
              >
                {change.status}
              </Tag>
              <span className='flex flex-col min-w-0 flex-1'>
                <span className='truncate text-12px font-500 text-t-primary' title={change.path}>
                  {baseOf(change.path)}
                </span>
                <span className='truncate text-10px text-t-tertiary' title={change.path}>
                  {change.path}
                </span>
              </span>
              <span className='shrink-0 flex items-center gap-2px opacity-0 group-hover:opacity-100 transition-opacity'>
                <Tooltip content={t('ide.diff.openFile')} mini>
                  <Button
                    type='text'
                    size='mini'
                    icon={<Components theme='outline' size={13} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpen(change.path);
                    }}
                  />
                </Tooltip>
                <Tooltip content={t('ide.diff.revert')} mini>
                  <Button
                    type='text'
                    size='mini'
                    status='danger'
                    loading={reverting === change.path}
                    icon={<Delete theme='outline' size={13} />}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRevert(change.path);
                    }}
                  />
                </Tooltip>
              </span>
            </div>
          );
        })
      )}
    </aside>
  );
};

export default DiffReviewPanel;

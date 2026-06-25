/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `UniversalEditor` — the frame of the Universal Editor (Yêu cầu 2a).
 *
 * Responsibilities:
 * 1. Resolve which {@link EditorAdapterKind} a file maps to via the registry
 *    ({@link resolveAdapterKind}) — never gets stuck, falls back to `'raw-text'`
 *    (criteria 2.1 / 2.9).
 * 2. Load/save the file through {@link useEditorFile} (the data layer over the fs
 *    bridge) and expose a uniform {@link EditorAdapterProps} contract.
 * 3. Render the registered adapter component for that kind. The concrete adapters
 *    (tasks 8.4–8.9) register themselves via the `./adapters` side-effect import;
 *    a kind with no component yet falls back to the raw-text editor, never crashes.
 *
 * The adapter contract + runtime registry live in `./adapterRegistry` so adapter
 * modules can register without importing this frame (no circular import).
 * Renderer-only module: no Node.js APIs.
 */

import { Button, Result, Spin } from '@arco-design/web-react';
import { Components } from '@icon-park/react';
import React, { Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import { componentForKind, rawTextFallback, type EditorAdapterProps } from './adapterRegistry';
import { useUniversalEditor, type UseUniversalEditorResult } from './hooks/useUniversalEditor';
import { type EditorContentMode, type UseEditorFileResult } from './hooks/useEditorFile';
// Side-effect: register the concrete adapters (tasks 8.4–8.9) into the registry.
import './adapters';

export type { AdapterComponent, EditorAdapterProps } from './adapterRegistry';
export { registerEditorAdapter, ADAPTER_CONTENT_MODE } from './adapterRegistry';
export type { EditorFsOverride } from './hooks/useEditorFile';

/** Props for {@link UniversalEditor}. */
export type UniversalEditorProps = {
  /** Absolute (or workspace-relative) path of the file to open. */
  filePath: string;
  /** Optional MIME hint, used by the registry when the extension is inconclusive. */
  mime?: string;
  /** Optional workspace root used to resolve workspace-relative paths. */
  workspace?: string;
  /**
   * Optional filesystem override. The IDE workspace passes a Node-`fs`-backed
   * implementation so it can edit ARBITRARY folders on disk (not just files in a
   * conversation workspace). Ignored when a `controller` is supplied.
   */
  fsOverride?: import('./hooks/useEditorFile').EditorFsOverride;
  /**
   * Optional pre-built controller (from {@link useUniversalEditor}). When given,
   * the frame renders that shared buffer instead of opening its own — letting a
   * parent (e.g. the Studio editor view) share one file state with an AI panel.
   */
  controller?: UseUniversalEditorResult;
  /**
   * Optional callback fired whenever the file's unsaved (dirty) state changes.
   * The IDE workspace uses this to track which open files have unsaved edits so
   * it can warn before discarding them (e.g. when switching folders).
   */
  onDirtyChange?: (dirty: boolean) => void;
  /** Debounced autosave delay. Omit to keep the editor manually saved. */
  autoSaveDelayMs?: number;
  /** Called only after a manual or automatic save succeeds. */
  onSaved?: (filePath: string) => void;
};

/** Build the uniform {@link EditorAdapterProps} from the hook result. */
const adapterProps = (
  filePath: string,
  mode: EditorContentMode,
  readOnly: boolean,
  file: UseEditorFileResult,
  onSave: (next?: string) => Promise<void>,
  workspace?: string
): EditorAdapterProps => ({
  filePath,
  content: file.content,
  savedContent: file.savedContent,
  mode,
  dirty: file.dirty,
  loading: file.loading,
  saving: file.saving,
  error: file.error,
  onChange: file.setContent,
  onSave,
  reload: file.reload,
  readOnly,
  workspace,
});

/**
 * The Universal Editor frame: classify → load → render the adapter.
 *
 * @param props The file to open plus optional mime/workspace hints, or a shared
 *   `controller` to reuse an externally-owned file buffer.
 */
export const UniversalEditor: React.FC<UniversalEditorProps> = ({
  filePath,
  mime,
  workspace,
  fsOverride,
  controller,
  onDirtyChange,
  autoSaveDelayMs,
  onSaved,
}) => {
  const { t } = useTranslation();
  // Reuse a shared controller when provided; otherwise own the file state here.
  // The hook is always called (Rules of Hooks); when a controller is supplied
  // the local instance is simply ignored.
  const own = useUniversalEditor({ filePath, mime, workspace, fsOverride });
  const { kind, mode, readOnly, file } = controller ?? own;
  const Adapter = componentForKind(kind);
  const saveFile = file.save;

  const save = React.useCallback(
    async (next?: string): Promise<void> => {
      await saveFile(next);
      onSaved?.(filePath);
    },
    [filePath, onSaved, saveFile]
  );

  // Report unsaved (dirty) state to an interested parent (e.g. the IDE workspace
  // tracking which tabs would lose edits on a folder switch). Clears to false on
  // unmount so a closed editor never lingers as "unsaved".
  React.useEffect(() => {
    onDirtyChange?.(file.dirty);
  }, [file.dirty, onDirtyChange]);
  React.useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  React.useEffect(() => {
    if (autoSaveDelayMs === undefined || !file.dirty || file.saving || readOnly) return;
    const timer = setTimeout(() => {
      void save().catch((): undefined => undefined);
    }, autoSaveDelayMs);
    return () => clearTimeout(timer);
  }, [autoSaveDelayMs, file.dirty, file.saving, readOnly, save]);

  // Initial load: show a spinner until the first read settles (unless it errored).
  if (file.loading && file.savedContent === '' && file.error === null) {
    return (
      <div className='flex-center h-full w-full'>
        <Spin tip={t('editor.state.loading')} />
      </div>
    );
  }

  if (file.error !== null) {
    return (
      <Result
        status='error'
        title={t('editor.state.errorTitle')}
        subTitle={file.error.message}
        extra={
          <Button type='primary' onClick={() => void file.reload()}>
            {t('editor.action.retry')}
          </Button>
        }
      />
    );
  }

  // A kind whose adapter is not registered yet: never crash — offer the inline
  // raw-text fallback so the file remains editable (criteria 2.1 / 2.9).
  if (!Adapter) {
    const Fallback = rawTextFallback();
    return (
      <div className='flex flex-col h-full gap-12px'>
        <Result
          status='info'
          icon={<Components theme='outline' size='32' />}
          title={t('editor.adapter.comingSoonTitle')}
          subTitle={t('editor.adapter.comingSoonSubtitle', { kind })}
        />
        {Fallback ? <Fallback {...adapterProps(filePath, mode, readOnly, file, save, workspace)} /> : null}
      </div>
    );
  }

  return (
    <Suspense fallback={<Spin className='flex-center h-full w-full' tip={t('editor.state.loading')} />}>
      <Adapter {...adapterProps(filePath, mode, readOnly, file, save, workspace)} />
    </Suspense>
  );
};

export default UniversalEditor;

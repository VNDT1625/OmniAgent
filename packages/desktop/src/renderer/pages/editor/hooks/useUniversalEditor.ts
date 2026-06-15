/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useUniversalEditor` — resolve a file's adapter kind and open its content in
 * one call. It wraps {@link resolveAdapterKind} + {@link useEditorFile} so a
 * caller (the {@link UniversalEditor} frame, or the Studio editor view that also
 * renders an AI side-panel) gets a single shared file controller instead of two
 * independent buffers. Renderer-only.
 */

import { useMemo } from 'react';
import { ADAPTER_CONTENT_MODE, READ_ONLY_KINDS } from '../adapterRegistry';
import { resolveAdapterKind, type EditorAdapterKind } from '../editorRegistry';
import {
  useEditorFile,
  type EditorContentMode,
  type EditorFsOverride,
  type UseEditorFileResult,
} from './useEditorFile';

/** Options for {@link useUniversalEditor}. */
export type UseUniversalEditorOptions = {
  /** Absolute (or workspace-relative) path of the file to open. */
  filePath: string;
  /** Optional MIME hint used when the extension is inconclusive. */
  mime?: string;
  /** Optional workspace root used to resolve workspace-relative paths. */
  workspace?: string;
  /** Optional filesystem override (e.g. the IDE's Node-fs plane). */
  fsOverride?: EditorFsOverride;
};

/** The resolved adapter metadata plus the shared file controller. */
export type UseUniversalEditorResult = {
  /** The adapter kind the file classified to (never throws — falls back to raw-text). */
  kind: EditorAdapterKind;
  /** Whether the adapter consumes decoded text or a base64 binary payload. */
  mode: EditorContentMode;
  /** Whether the kind is presented read-only (e.g. binary inspect). */
  readOnly: boolean;
  /** The shared read/write file controller. */
  file: UseEditorFileResult;
};

/**
 * Classify `filePath` and open it, returning the kind/mode/readOnly metadata
 * together with the file controller so multiple views can share one buffer.
 */
export const useUniversalEditor = (options: UseUniversalEditorOptions): UseUniversalEditorResult => {
  const { filePath, mime, workspace, fsOverride } = options;
  const kind = useMemo(() => resolveAdapterKind({ fileName: filePath, mime }), [filePath, mime]);
  const mode = ADAPTER_CONTENT_MODE[kind];
  const readOnly = READ_ONLY_KINDS.has(kind);
  const file = useEditorFile({ filePath, mode, workspace, fsOverride });
  return { kind, mode, readOnly, file };
};

export default useUniversalEditor;

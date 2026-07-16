/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useEditorFile` — the read/write data layer for the Universal Editor (Yêu cầu 2a).
 *
 * It loads a file's content from aioncore via `POST /api/fs/read` (text) or
 * `POST /api/fs/read-buffer` (binary → base64) and persists edits via
 * `POST /api/fs/write`, reusing the renderer's existing HTTP helper
 * (`ipcBridge.fs.*`, backed by `httpBridge`). It owns the editable content
 * buffer, tracks the dirty state (current buffer vs. last-saved snapshot), and
 * exposes a tiny, framework-agnostic surface that any editor adapter
 * (tasks 8.4–8.9) can drive.
 *
 * Renderer-only: no Node.js APIs. All file access goes through the HTTP bridge.
 */

import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import { writeBinaryFile } from '@/renderer/utils/file/writeBinaryFile';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Whether an adapter consumes a file as decoded UTF-8 `text`, a base64 `binary`
 * payload, or `none` — the adapter reads/edits the file BY PATH itself (e.g. the
 * Office/PDF adapters open the file in the ONLYOFFICE editor by path and read
 * their lightweight fallback by path too). `none` skips the eager whole-file
 * read entirely, so a huge file never gets loaded into renderer memory and never
 * hits aioncore's `/api/fs/read-buffer` size limit.
 */
export type EditorContentMode = 'text' | 'binary' | 'none';

/**
 * Options for {@link useEditorFile}.
 */
export type UseEditorFileOptions = {
  /** Absolute (or workspace-relative) path of the file to edit. */
  filePath: string;
  /**
   * How to read the bytes. `'text'` (default) returns UTF-8 text via
   * `/api/fs/read`; `'binary'` returns base64 via `/api/fs/read-buffer`.
   */
  mode?: EditorContentMode;
  /** Optional workspace root used to resolve workspace-relative paths. */
  workspace?: string;
  /**
   * Optional filesystem override. By default the hook reads/writes through the
   * aioncore workspace bridge (`/api/fs/*`). The IDE workspace, which opens
   * ARBITRARY folders on disk, injects a Node-`fs`-backed implementation so the
   * same adapters can edit any file (not just files inside a conversation
   * workspace). See {@link EditorFsOverride}.
   */
  fsOverride?: EditorFsOverride;
};

/**
 * A pluggable filesystem for {@link useEditorFile}. Each method mirrors the part
 * of the default `/api/fs/*` path the editor uses, so a caller (the IDE) can
 * route reads/writes through a different plane (Node `fs` in the Main process).
 */
export type EditorFsOverride = {
  /** Read UTF-8 text; resolve `null` on failure. */
  readText: (filePath: string) => Promise<string | null>;
  /** Read base64 bytes; resolve `null` on failure. */
  readBase64: (filePath: string) => Promise<string | null>;
  /** Write UTF-8 text; resolve `true` on success. */
  writeText: (filePath: string, data: string) => Promise<boolean>;
  /** Write decoded base64 bytes; resolve `true` on success. */
  writeBase64: (filePath: string, dataBase64: string) => Promise<boolean>;
};

/**
 * The value returned by {@link useEditorFile}.
 */
export type UseEditorFileResult = {
  /** The current (possibly edited) content buffer. Base64 string in binary mode. */
  content: string;
  /** The last-saved (or last-loaded) content snapshot. */
  savedContent: string;
  /** True while the initial load / a reload is in flight. */
  loading: boolean;
  /** True while a save is in flight. */
  saving: boolean;
  /** The most recent read/write error, or `null` when healthy. */
  error: Error | null;
  /** True when the buffer differs from the last-saved snapshot. */
  dirty: boolean;
  /** Replace the in-memory buffer (does not persist). */
  setContent: (next: string) => void;
  /**
   * Persist content to disk via `/api/fs/write`. Pass `next` to save a specific
   * value, otherwise the current buffer is saved. Resolves once written.
   */
  save: (next?: string) => Promise<void>;
  /** Re-read the file from disk, discarding unsaved edits. */
  reload: () => Promise<void>;
};

/** Normalize an unknown thrown value into an `Error` with a useful message. */
const toError = (cause: unknown, fallbackMessage: string): Error => {
  if (isBackendHttpError(cause)) {
    return new Error(cause.backendMessage || cause.message, { cause });
  }
  if (cause instanceof Error) {
    return cause;
  }
  return new Error(fallbackMessage, { cause });
};

/**
 * Load + save a single file for the Universal Editor.
 *
 * The hook re-reads whenever `filePath`, `mode`, or `workspace` change and
 * guards against out-of-order responses (e.g. switching files quickly) by
 * tagging each load with a monotonically increasing request id.
 *
 * @param options - File path plus read mode and optional workspace.
 * @returns The content buffer, status flags, dirty tracking, and `save`/`reload`/`setContent`.
 */
export const useEditorFile = (options: UseEditorFileOptions): UseEditorFileResult => {
  const { filePath, mode = 'text', workspace, fsOverride } = options;

  const [content, setContentState] = useState<string>('');
  const [savedContent, setSavedContent] = useState<string>('');
  const [loading, setLoading] = useState<boolean>(true);
  const [saving, setSaving] = useState<boolean>(false);
  const [error, setError] = useState<Error | null>(null);

  // Tag each load so a slow earlier request can't overwrite a newer one.
  const loadIdRef = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const requestId = ++loadIdRef.current;
    // `none` mode: the adapter owns reading/editing by path (Office/PDF). Skip
    // the eager whole-file read so large files never load into memory or hit
    // aioncore's read-buffer size limit. Settle immediately with an empty buffer.
    if (mode === 'none') {
      setContentState('');
      setSavedContent('');
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const raw = fsOverride
        ? mode === 'binary'
          ? await fsOverride.readBase64(filePath)
          : await fsOverride.readText(filePath)
        : mode === 'binary'
          ? await ipcBridge.fs.readFileBuffer.invoke({ path: filePath, workspace })
          : await ipcBridge.fs.readFile.invoke({ path: filePath, workspace });
      if (requestId !== loadIdRef.current) return; // superseded by a newer load
      if (raw == null) {
        throw new Error(`File could not be read: ${filePath}`);
      }
      setContentState(raw);
      setSavedContent(raw);
    } catch (cause) {
      if (requestId !== loadIdRef.current) return;
      setError(toError(cause, `File could not be read: ${filePath}`));
    } finally {
      if (requestId === loadIdRef.current) {
        setLoading(false);
      }
    }
  }, [filePath, mode, workspace, fsOverride]);

  useEffect(() => {
    // Reset the buffer immediately so a stale value never flashes for the new file.
    setContentState('');
    setSavedContent('');
    void load();
    // `load` already closes over filePath/mode/workspace.
  }, [load]);

  const setContent = useCallback((next: string): void => {
    setContentState(next);
  }, []);

  const save = useCallback(
    async (next?: string): Promise<void> => {
      // `none` mode: the adapter persists by path itself (Office saves through
      // the Document Server callback; fallbacks write by path). Nothing to do.
      if (mode === 'none') return;
      const data = next ?? content;
      setSaving(true);
      setError(null);
      try {
        if (fsOverride) {
          const ok =
            mode === 'binary'
              ? await fsOverride.writeBase64(filePath, data)
              : await fsOverride.writeText(filePath, data);
          if (!ok) {
            throw new Error(`File could not be written: ${filePath}`);
          }
        } else if (mode === 'binary') {
          // `/api/fs/write` stores data as literal text (no base64 decode), which
          // would corrupt binary files. Write the decoded bytes via the Main
          // process binary-safe writer instead.
          await writeBinaryFile(filePath, data);
        } else {
          const ok = await ipcBridge.fs.writeFile.invoke({ path: filePath, data });
          if (!ok) {
            throw new Error(`File could not be written: ${filePath}`);
          }
        }
        setContentState(data);
        setSavedContent(data);
      } catch (cause) {
        const wrapped = toError(cause, `File could not be written: ${filePath}`);
        setError(wrapped);
        throw wrapped;
      } finally {
        setSaving(false);
      }
    },
    [content, filePath, mode, fsOverride]
  );

  const reload = useCallback(async (): Promise<void> => {
    await load();
  }, [load]);

  return {
    content,
    savedContent,
    loading,
    saving,
    error,
    dirty: content !== savedContent,
    setContent,
    save,
    reload,
  };
};

export default useEditorFile;

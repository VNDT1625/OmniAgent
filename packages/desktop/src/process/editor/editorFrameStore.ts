/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `editorFrameStore` — Main-process registry of the **editor frames** the Super
 * agent has opened inside a conversation.
 *
 * Mirrors how `browserViewManager` is the source of truth for browser tabs: this
 * is the source of truth for editor surfaces. The agent's `editor_*` tools
 * register / update / close frames here; the renderer polls {@link list} (via
 * the editor-control bridge) and renders one live {@link UniversalEditor} per
 * entry, reloading from disk whenever `version` bumps (i.e. the agent wrote).
 *
 * Unlike browser tabs (native `WebContentsView`s), editor frames are pure DOM —
 * the store only holds lightweight metadata (path, title, version), and the
 * renderer owns the actual editor component. So this module has no Electron
 * dependency and is trivially unit-testable.
 *
 * Process boundary: Main-process (Node.js) module. No DOM, no Electron.
 */

/** Serializable description of one open editor frame. */
export type EditorFrameInfo = {
  /** Absolute (or workspace-relative) path of the file the frame edits. */
  filePath: string;
  /** Short human title (the file name). */
  title: string;
  /**
   * Monotonic version, bumped every time the agent writes the file. The renderer
   * reloads the frame from disk whenever this changes, so it mirrors the agent's
   * edits in near-real-time.
   */
  version: number;
  /** Unix ms of the last open/update (newest frames sort last). */
  updatedAt: number;
};

/** Derive a short title (file name) from a path. */
const titleOf = (filePath: string): string => {
  const norm = filePath.replace(/\\/g, '/').replace(/\/+$/, '');
  const base = norm.slice(norm.lastIndexOf('/') + 1);
  return base || filePath;
};

/** Public contract of the editor frame store. */
export type IEditorFrameStore = {
  /** Register (or re-focus) a frame for `filePath`. Idempotent. */
  open: (filePath: string) => EditorFrameInfo;
  /** Bump a frame's version (call after a write) so the renderer reloads it. */
  touch: (filePath: string) => void;
  /** Remove a frame. No-op for unknown paths. */
  close: (filePath: string) => void;
  /** Remove every frame (e.g. when Super is turned off). */
  closeAll: () => void;
  /** List open frames, oldest-first (stable render order). */
  list: () => EditorFrameInfo[];
};

/** Create an {@link IEditorFrameStore} (DI-friendly; tests get a fresh one). */
export const createEditorFrameStore = (deps: { now?: () => number } = {}): IEditorFrameStore => {
  const now = deps.now ?? (() => Date.now());
  const frames = new Map<string, EditorFrameInfo>();

  return {
    open(filePath) {
      const existing = frames.get(filePath);
      if (existing) {
        existing.updatedAt = now();
        return { ...existing };
      }
      const info: EditorFrameInfo = { filePath, title: titleOf(filePath), version: 1, updatedAt: now() };
      frames.set(filePath, info);
      return { ...info };
    },
    touch(filePath) {
      const info = frames.get(filePath);
      if (!info) return;
      info.version += 1;
      info.updatedAt = now();
    },
    close(filePath) {
      frames.delete(filePath);
    },
    closeAll() {
      frames.clear();
    },
    list() {
      return [...frames.values()]
        .toSorted((a, b) => a.updatedAt - b.updatedAt)
        .map((f) => ({ filePath: f.filePath, title: f.title, version: f.version, updatedAt: f.updatedAt }));
    },
  };
};

/** Module-level singleton shared by the MCP tools + the renderer bridge. */
let shared: IEditorFrameStore | undefined;

/** Resolve the shared editor frame store (created on first use). */
export const getEditorFrameStore = (): IEditorFrameStore => {
  if (!shared) shared = createEditorFrameStore();
  return shared;
};

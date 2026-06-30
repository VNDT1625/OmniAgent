/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useIdeWorkspace` — the shared data spine for the unified IDE workspace.
 *
 * One picked folder feeds every IDE surface, so this hook owns it once and
 * exposes everything the tabs need:
 *
 *  - **Files**: a lazily-loaded file tree + the active file path the editor
 *    opens. Crucially, ALL filesystem access goes through the IDE's Node-`fs`
 *    bridge ({@link ideClient}: `ide.list-dir`/`ide.read-file`/…), NOT the
 *    aioncore `/api/fs/*` bridge — the latter is scoped to a conversation
 *    workspace and cannot see a folder the user opens from anywhere on disk.
 *    (This was why the tree showed empty and the AI saw empty files.)
 *  - **Stats**: the intra-repo import graph (via `ide.scan-repo`) — feeds the
 *    "N files · N deps" header line. The Understand mode owns its own deeper
 *    graph; the Chat mode is a `<ChatConversation>` embed (CLI agent).
 *
 * Picking a folder loads the root tree and kicks off the graph scan together.
 * Bridge failures surface as state rather than throwing.
 *
 * Renderer-only: talks to Main via {@link ideClient} + the `dialog` bridge.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ipcBridge } from '@/common';
import { getReadFileText, ideClient, type IdeDirEntry, type RepoGraph } from './ideClient';
import { teamEditClient } from './teamEdit/teamEditClient';
import type { EditorFsOverride } from '@renderer/pages/editor/UniversalEditor';

/** Status of the repo (import-graph) scan. */
export type ScanStatus = 'idle' | 'scanning' | 'ready' | 'error';

/** One node in the file tree, carrying the absolute path + leaf flag. */
export type TreeNode = {
  key: string;
  title: string;
  isLeaf: boolean;
  /** Directory children: `undefined` = not loaded yet (Arco shows the expander). */
  children?: TreeNode[];
};

/** Public shape returned by {@link useIdeWorkspace}. */
export type UseIdeWorkspace = {
  rootPath: string | null;
  /** File tree of the picked folder (directories first). */
  tree: TreeNode[];
  treeLoading: boolean;
  /** Lazy-load a directory's children when expanded; resolves when merged. */
  loadDir: (dir: string) => Promise<void>;
  /** Absolute path of the file open in the editor, or null. */
  activeFile: string | null;
  setActiveFile: (path: string | null) => void;
  /** Files with a kept-alive editor (the open tabs), restored across sessions. */
  openFiles: string[];
  /** Open (or focus) a file in the editor + remember it in the session. */
  openFile: (path: string) => void;
  /** Close a file's editor + drop its unsaved flag. */
  closeFile: (path: string) => void;
  /** Paths with unsaved edits (reported by their editors). */
  dirtyFiles: Set<string>;
  /** Whether any open file has unsaved edits. */
  hasUnsaved: boolean;
  /** Report a file's dirty (unsaved) state — called by its editor. */
  markDirty: (path: string, dirty: boolean) => void;
  /** Refresh the affected tree branch + graph after an IDE editor save. */
  refreshAfterSave: (path: string) => Promise<void>;
  /** Filesystem override for the editor (Node-fs plane, arbitrary folders). */
  editorFs: EditorFsOverride;
  /** Lightweight intra-repo import graph (used by the header stats line). */
  graph: RepoGraph | null;
  scanStatus: ScanStatus;
  scanError: string | null;
  /** Whether the IDE is restoring a previously-open folder on mount. */
  restoring: boolean;
  /** Prompt for a folder and switch to it, discarding the current session. */
  pickFolder: () => Promise<void>;
  /** Close the current folder: reset to the welcome screen + clear the session. */
  closeFolder: () => void;
  refreshTree: () => Promise<void>;
  rescan: () => Promise<void>;
};

/** localStorage key for the persisted IDE session (open folder + tabs). */
const SESSION_KEY = 'studio.ide.session';

/** Background tree refresh cadence. Filesystem noise must not reset this timer. */
export const IDE_TREE_REFRESH_INTERVAL_MS = 3 * 60 * 1000;

/** Debounce the burst of MTUI metadata writes produced by one accepted operation. */
const MTUI_REFRESH_DEBOUNCE_MS = 500;

/** The persisted IDE session: which folder was open and which files were in it. */
type IdeSession = {
  rootPath: string;
  openFiles: string[];
  activeFile: string | null;
};

/** Read the persisted IDE session (tolerant of corruption / absence). */
const readSession = (): IdeSession | null => {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const s = parsed as Partial<IdeSession>;
    if (typeof s.rootPath !== 'string' || s.rootPath.length === 0) return null;
    return {
      rootPath: s.rootPath,
      openFiles: Array.isArray(s.openFiles) ? s.openFiles.filter((p): p is string => typeof p === 'string') : [],
      activeFile: typeof s.activeFile === 'string' ? s.activeFile : null,
    };
  } catch {
    return null;
  }
};

/** Persist the IDE session, or clear it when `session` is null. */
const writeSession = (session: IdeSession | null): void => {
  try {
    if (session) localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    else localStorage.removeItem(SESSION_KEY);
  } catch {
    /* storage full or unavailable — non-fatal */
  }
};

/** Directory names hidden from the IDE tree (build/vendor noise). */
const HIDDEN_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'build', '.next', 'coverage', '.cache']);

/** Map raw dir entries to tree nodes (dirs get an empty children array → expandable). */
const toTreeNodes = (entries: IdeDirEntry[]): TreeNode[] =>
  entries
    .filter((e) => !(e.isDir && HIDDEN_DIRS.has(e.name)))
    .map(
      (entry): TreeNode =>
        Object.assign(
          { key: entry.fullPath, title: entry.name, isLeaf: !entry.isDir },
          entry.isDir ? { children: [] } : {}
        )
    );

/** Immutably merge `children` into the node whose key === `dirKey`. */
const mergeChildren = (nodes: TreeNode[], dirKey: string, children: TreeNode[]): TreeNode[] =>
  nodes.map((node): TreeNode => {
    if (node.key === dirKey) return { ...node, children };
    if (node.children && node.children.length > 0)
      return { ...node, children: mergeChildren(node.children, dirKey, children) };
    return node;
  });

const pathKey = (value: string): string => value.replace(/[/\\]+$/, '').replace(/\\/g, '/');

/** Only MTUI completion metadata should trigger an immediate watcher refresh. */
export const isMtuiRefreshEvent = (relativePath: string): boolean => {
  const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase();
  return normalized === '.mtui/mtui.db' || normalized.startsWith('.mtui/operations/');
};

const parentPath = (value: string): string => {
  const trimmed = value.replace(/[/\\]+$/, '');
  const index = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return index > 0 ? trimmed.slice(0, index) : trimmed;
};

const treeHasDir = (nodes: TreeNode[], dir: string): boolean => {
  const target = pathKey(dir);
  return nodes.some((node) => {
    if (!node.isLeaf && pathKey(node.key) === target) return true;
    return node.children ? treeHasDir(node.children, dir) : false;
  });
};

/** Collect loaded file-tree leaves as repo-relative, forward-slash paths. */
export const collectTreeFilePaths = (nodes: TreeNode[], rootPath: string | null): string[] => {
  if (!rootPath) return [];
  const root = rootPath.replace(/\\/g, '/').replace(/\/+$/, '');
  const files: string[] = [];

  const visit = (items: TreeNode[]): void => {
    for (const item of items) {
      if (item.isLeaf) {
        const normalized = item.key.replace(/\\/g, '/');
        const rel = normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
        if (rel && rel !== normalized) files.push(rel);
        continue;
      }
      if (item.children?.length) visit(item.children);
    }
  };

  visit(nodes);
  return files;
};

export const useIdeWorkspace = (): UseIdeWorkspace => {
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [tree, setTree] = useState<TreeNode[]>([]);
  const [treeLoading, setTreeLoading] = useState(false);
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [openFiles, setOpenFiles] = useState<string[]>([]);
  const [dirtyFiles, setDirtyFiles] = useState<Set<string>>(() => new Set());
  const [graph, setGraph] = useState<RepoGraph | null>(null);
  const [scanStatus, setScanStatus] = useState<ScanStatus>('idle');
  const [scanError, setScanError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(true);
  const treeRef = useRef<TreeNode[]>([]);
  const mtuiRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressMtuiRefreshUntilRef = useRef(0);
  const graphRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    treeRef.current = tree;
  }, [tree]);

  /** Editor filesystem on the IDE Node-fs plane (works for any folder on disk). */
  const editorFs = useMemo<EditorFsOverride>(
    () => ({
      readText: async (p): Promise<string | null> => {
        const r = await ideClient.readFile({ path: p, all: true, lineNumbers: false }).catch((): null => null);
        if (!r || !r.ok) return null;
        return getReadFileText(r.data);
      },
      readBase64: async (p): Promise<string | null> => {
        const r = await ideClient.readFileBase64(p).catch((): null => null);
        return r && r.ok ? r.data : null;
      },
      writeText: async (p, data): Promise<boolean> => {
        const r = await ideClient.writeFile(p, data).catch((): null => null);
        return Boolean(r && r.ok && r.data);
      },
      writeBase64: async (p, dataBase64): Promise<boolean> => {
        const r = await ideClient.writeFileBase64(p, dataBase64).catch((): null => null);
        return Boolean(r && r.ok && r.data);
      },
    }),
    []
  );

  const loadRootTree = useCallback(async (dir: string): Promise<void> => {
    setTreeLoading(true);
    try {
      const result = await ideClient.listDir(dir);
      setTree(result.ok ? toTreeNodes(result.data) : []);
    } catch {
      setTree([]);
    } finally {
      setTreeLoading(false);
    }
  }, []);

  const loadDir = useCallback(async (dir: string): Promise<void> => {
    const result = await ideClient.listDir(dir).catch((): null => null);
    const children = result && result.ok ? toTreeNodes(result.data) : [];
    setTree((prev) => mergeChildren(prev, dir, children));
  }, []);

  const scan = useCallback(async (root: string): Promise<void> => {
    setScanStatus('scanning');
    setScanError(null);
    try {
      const result = await ideClient.scanRepo(root);
      if (result.ok) {
        setGraph(result.data);
        setScanStatus('ready');
      } else {
        setScanError((result as { ok: false; error: string }).error);
        setScanStatus('error');
      }
    } catch (error) {
      setScanError(error instanceof Error ? error.message : String(error));
      setScanStatus('error');
    }
  }, []);

  /** Load a root's tree + scan together. Shared by pickFolder and restore. */
  const openRoot = useCallback(
    async (root: string): Promise<void> => {
      setRootPath(root);
      setGraph(null);
      await Promise.all([loadRootTree(root), scan(root)]);
    },
    [loadRootTree, scan]
  );

  // Restore the previously-open folder + tabs on mount, so re-entering the IDE
  // resumes exactly where the user left off instead of reloading from scratch.
  // Guarded so it runs once even under StrictMode's double-invoke.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
    const session = readSession();
    if (!session) {
      setRestoring(false);
      return;
    }
    setOpenFiles(session.openFiles);
    setActiveFile(session.activeFile);
    void openRoot(session.rootPath).finally(() => setRestoring(false));
  }, [openRoot]);

  // Persist the session whenever the folder or its open tabs change, so the next
  // visit can restore it. Skipped while restoring (don't clobber the saved set)
  // and when no folder is open.
  useEffect(() => {
    if (restoring) return;
    if (rootPath) writeSession({ rootPath, openFiles, activeFile });
    else writeSession(null);
  }, [restoring, rootPath, openFiles, activeFile]);

  const openFile = useCallback((path: string): void => {
    setOpenFiles((prev) => (prev.includes(path) ? prev : [...prev, path]));
    setActiveFile(path);
  }, []);

  const closeFile = useCallback(
    (path: string): void => {
      setOpenFiles((prev) => prev.filter((p) => p !== path));
      setDirtyFiles((prev) => {
        if (!prev.has(path)) return prev;
        const next = new Set(prev);
        next.delete(path);
        return next;
      });
      setActiveFile((current) => {
        if (current !== path) return current;
        const remaining = openFiles.filter((p) => p !== path);
        return remaining[remaining.length - 1] ?? null;
      });
    },
    [openFiles]
  );

  const markDirty = useCallback((path: string, dirty: boolean): void => {
    setDirtyFiles((prev) => {
      const has = prev.has(path);
      if (dirty === has) return prev;
      const next = new Set(prev);
      if (dirty) next.add(path);
      else next.delete(path);
      return next;
    });
  }, []);

  const pickFolder = useCallback(async (): Promise<void> => {
    const picked = await ipcBridge.dialog.showOpen.invoke({ properties: ['openDirectory'] });
    if (!picked || picked.length === 0) return;
    const root = picked[0];
    // Switching folders discards the current session's editors: reset tabs +
    // unsaved flags before opening the new root. (The caller is responsible for
    // warning about unsaved changes BEFORE invoking this.)
    setOpenFiles([]);
    setDirtyFiles(new Set());
    setActiveFile(null);
    await openRoot(root);
  }, [openRoot]);

  const closeFolder = useCallback((): void => {
    // Drop the whole session: editors, tabs, tree, graph — back to welcome.
    // (Callers warn about unsaved changes BEFORE invoking this.)
    // Also drop this workspace's team-edit coordinator (leases + presence +
    // activity) in Main so a re-open / next project never sees stale state.
    // Best-effort: a failed reset must never block closing the folder.
    if (rootPath) void teamEditClient.reset(rootPath).catch((): undefined => undefined);
    setOpenFiles([]);
    setDirtyFiles(new Set());
    setActiveFile(null);
    setTree([]);
    setGraph(null);
    setScanStatus('idle');
    setScanError(null);
    setRootPath(null);
    writeSession(null);
  }, [rootPath]);

  const refreshTree = useCallback(async (): Promise<void> => {
    if (rootPath) await loadRootTree(rootPath);
  }, [rootPath, loadRootTree]);

  const refreshTreeForChange = useCallback(
    async (changedPath: string): Promise<void> => {
      if (!rootPath) return;
      const changedDir = parentPath(changedPath);
      if (pathKey(changedDir) === pathKey(rootPath)) {
        await loadRootTree(rootPath);
        return;
      }
      if (treeHasDir(treeRef.current, changedDir)) {
        await loadDir(changedDir);
        return;
      }
      await loadRootTree(rootPath);
    },
    [rootPath, loadDir, loadRootTree]
  );

  const rescan = useCallback(async (): Promise<void> => {
    if (rootPath) await scan(rootPath);
  }, [rootPath, scan]);

  // Silent structural rescan: refresh the import graph WITHOUT flipping the
  // scan status (so the header doesn't flash a spinner on every save). Cheap +
  // deterministic (regex import parse, no model) so the relations the editor
  // shows stay accurate as the single user edits. Debounced per burst.
  const scheduleGraphRefresh = useCallback((root: string): void => {
    if (graphRefreshTimerRef.current !== null) return;
    graphRefreshTimerRef.current = setTimeout(() => {
      graphRefreshTimerRef.current = null;
      void ideClient
        .scanRepo(root)
        .then((result) => {
          if (result.ok) setGraph(result.data);
        })
        .catch((): undefined => undefined);
    }, 1500);
  }, []);

  const refreshAfterSave = useCallback(
    async (path: string): Promise<void> => {
      suppressMtuiRefreshUntilRef.current = Date.now() + 1000;
      if (mtuiRefreshTimerRef.current !== null) {
        clearTimeout(mtuiRefreshTimerRef.current);
        mtuiRefreshTimerRef.current = null;
      }
      await refreshTreeForChange(path);
      if (rootPath) scheduleGraphRefresh(rootPath);
    },
    [refreshTreeForChange, rootPath, scheduleGraphRefresh]
  );

  // Keep a low-frequency safety refresh. Ordinary build/log changes cannot
  // continuously reset or trigger this timer.
  useEffect(() => {
    if (!rootPath) return;
    const interval = setInterval(() => {
      void loadRootTree(rootPath);
    }, IDE_TREE_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [rootPath, loadRootTree]);

  // Keep the watcher only for completed MTUI operations. User editor saves
  // refresh explicitly through `refreshAfterSave`; build output is ignored.
  useEffect(() => {
    if (!rootPath) return;
    let disposed = false;
    const unsubscribe = ideClient.onFileChanged((event) => {
      if (pathKey(event.rootPath) !== pathKey(rootPath)) return;
      if (!isMtuiRefreshEvent(event.relativePath)) return;
      if (Date.now() < suppressMtuiRefreshUntilRef.current) return;
      if (mtuiRefreshTimerRef.current !== null) clearTimeout(mtuiRefreshTimerRef.current);
      mtuiRefreshTimerRef.current = setTimeout(() => {
        mtuiRefreshTimerRef.current = null;
        void loadRootTree(rootPath);
        scheduleGraphRefresh(rootPath);
      }, MTUI_REFRESH_DEBOUNCE_MS);
    });
    void ideClient
      .fileWatchStart(rootPath)
      .then((result) => {
        if (!result.ok) {
          const failure = result as { ok: false; error: string };
          console.warn('[useIdeWorkspace] file watch failed:', failure.error);
        }
        if (disposed && result.ok) void ideClient.fileWatchStop(rootPath).catch((): undefined => undefined);
      })
      .catch((error: unknown) => console.warn('[useIdeWorkspace] file watch failed:', error));
    return () => {
      disposed = true;
      unsubscribe();
      if (mtuiRefreshTimerRef.current !== null) {
        clearTimeout(mtuiRefreshTimerRef.current);
        mtuiRefreshTimerRef.current = null;
      }
      if (graphRefreshTimerRef.current !== null) {
        clearTimeout(graphRefreshTimerRef.current);
        graphRefreshTimerRef.current = null;
      }
      void ideClient.fileWatchStop(rootPath).catch((): undefined => undefined);
    };
  }, [rootPath, loadRootTree, scheduleGraphRefresh]);

  return {
    rootPath,
    tree,
    treeLoading,
    loadDir,
    activeFile,
    setActiveFile,
    openFiles,
    openFile,
    closeFile,
    dirtyFiles,
    hasUnsaved: dirtyFiles.size > 0,
    markDirty,
    refreshAfterSave,
    editorFs,
    graph,
    scanStatus,
    scanError,
    restoring,
    pickFolder,
    closeFolder,
    refreshTree,
    rescan,
  };
};

export default useIdeWorkspace;

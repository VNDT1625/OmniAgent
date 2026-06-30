/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * DOM tests for {@link useIdeWorkspace} — the IDE workspace data spine, focused
 * on the session-persistence + unsaved-tracking behaviour added so the IDE
 * resumes the last folder and warns before discarding edits:
 *
 *  - the open folder + tabs persist to `localStorage` and restore on mount, so
 *    re-entering the IDE resumes where the user left off (no reload from scratch);
 *  - `openFile`/`closeFile` manage the tab set + active file;
 *  - `markDirty` tracks which files have unsaved edits (drives the warning);
 *  - `pickFolder` resets the previous session's tabs + dirty flags.
 *
 * `./ideClient` (Node-fs IPC) and the global `ipcBridge` (dialog) are mocked so
 * no IPC runs. `localStorage` is reset between tests.
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fileWatchStartMock, fileWatchStopMock, listDirMock, onFileChangedMock, scanRepoMock, showOpenMock } =
  vi.hoisted(() => ({
    fileWatchStartMock: vi.fn(),
    fileWatchStopMock: vi.fn(),
    listDirMock: vi.fn(),
    onFileChangedMock: vi.fn(),
    scanRepoMock: vi.fn(),
    showOpenMock: vi.fn(),
  }));

vi.mock('@renderer/pages/studio/ide/ideClient', () => ({
  ideClient: {
    listDir: listDirMock,
    scanRepo: scanRepoMock,
    fileWatchStart: fileWatchStartMock,
    fileWatchStop: fileWatchStopMock,
    onFileChanged: onFileChangedMock,
    readFile: vi.fn(),
    readFileBase64: vi.fn(),
    writeFile: vi.fn(),
    writeFileBase64: vi.fn(),
  },
}));

vi.mock('@/common', () => ({
  ipcBridge: { dialog: { showOpen: { invoke: showOpenMock } } },
}));

import { collectTreeFilePaths, useIdeWorkspace, type TreeNode } from '@renderer/pages/studio/ide/useIdeWorkspace';

const SESSION_KEY = 'studio.ide.session';
const ROOT = '/repo';
const FILE_A = '/repo/src/a.ts';
const FILE_B = '/repo/src/b.ts';
type FileChangedListener = (event: { rootPath: string; relativePath: string; path: string }) => void;

const okDir = { ok: true as const, data: [] };
const okScan = { ok: true as const, data: { rootPath: ROOT, nodes: [], edges: [], truncated: false, fileCount: 0 } };
const okBool = { ok: true as const, data: true };

describe('useIdeWorkspace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    listDirMock.mockResolvedValue(okDir);
    scanRepoMock.mockResolvedValue(okScan);
    fileWatchStartMock.mockResolvedValue(okBool);
    fileWatchStopMock.mockResolvedValue(okBool);
    onFileChangedMock.mockReturnValue(vi.fn());
    showOpenMock.mockResolvedValue([ROOT]);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts with no folder and finishes restoring when no session is stored', async () => {
    const { result } = renderHook(() => useIdeWorkspace());
    await waitFor(() => expect(result.current.restoring).toBe(false));
    expect(result.current.rootPath).toBeNull();
    expect(result.current.openFiles).toEqual([]);
    expect(result.current.hasUnsaved).toBe(false);
  });

  it('collects loaded tree files for chat mentions when the graph is empty', () => {
    const tree: TreeNode[] = [
      { key: '/repo/design.md', title: 'design.md', isLeaf: true },
      {
        key: '/repo/specs',
        title: 'specs',
        isLeaf: false,
        children: [{ key: '/repo/specs/required.md', title: 'required.md', isLeaf: true }],
      },
    ];

    expect(collectTreeFilePaths(tree, ROOT)).toEqual(['design.md', 'specs/required.md']);
  });

  it('restores the persisted folder + tabs on mount', async () => {
    localStorage.setItem(
      SESSION_KEY,
      JSON.stringify({ rootPath: ROOT, openFiles: [FILE_A, FILE_B], activeFile: FILE_B })
    );
    const { result } = renderHook(() => useIdeWorkspace());
    await waitFor(() => expect(result.current.rootPath).toBe(ROOT));
    await waitFor(() => expect(result.current.restoring).toBe(false));
    expect(result.current.openFiles).toEqual([FILE_A, FILE_B]);
    expect(result.current.activeFile).toBe(FILE_B);
    expect(listDirMock).toHaveBeenCalledWith(ROOT);
    expect(scanRepoMock).toHaveBeenCalledWith(ROOT);
  });

  it('pickFolder opens a folder and persists the session', async () => {
    const { result } = renderHook(() => useIdeWorkspace());
    await waitFor(() => expect(result.current.restoring).toBe(false));

    await act(async () => {
      await result.current.pickFolder();
    });

    expect(result.current.rootPath).toBe(ROOT);
    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(SESSION_KEY) ?? '{}');
      expect(saved.rootPath).toBe(ROOT);
    });
  });

  it('openFile adds a tab + activates it, and persists open files', async () => {
    showOpenMock.mockResolvedValue([ROOT]);
    const { result } = renderHook(() => useIdeWorkspace());
    await waitFor(() => expect(result.current.restoring).toBe(false));
    await act(async () => {
      await result.current.pickFolder();
    });

    act(() => result.current.openFile(FILE_A));
    expect(result.current.openFiles).toEqual([FILE_A]);
    expect(result.current.activeFile).toBe(FILE_A);

    await waitFor(() => {
      const saved = JSON.parse(localStorage.getItem(SESSION_KEY) ?? '{}');
      expect(saved.openFiles).toEqual([FILE_A]);
    });
  });

  it('markDirty + closeFile track unsaved state and drop it on close', async () => {
    const { result } = renderHook(() => useIdeWorkspace());
    await waitFor(() => expect(result.current.restoring).toBe(false));
    await act(async () => {
      await result.current.pickFolder();
    });
    act(() => result.current.openFile(FILE_A));

    act(() => result.current.markDirty(FILE_A, true));
    expect(result.current.hasUnsaved).toBe(true);
    expect(result.current.dirtyFiles.has(FILE_A)).toBe(true);

    act(() => result.current.closeFile(FILE_A));
    expect(result.current.openFiles).toEqual([]);
    expect(result.current.hasUnsaved).toBe(false);
  });

  it('pickFolder resets the previous session tabs + unsaved flags', async () => {
    const { result } = renderHook(() => useIdeWorkspace());
    await waitFor(() => expect(result.current.restoring).toBe(false));
    await act(async () => {
      await result.current.pickFolder();
    });
    act(() => result.current.openFile(FILE_A));
    act(() => result.current.markDirty(FILE_A, true));
    expect(result.current.hasUnsaved).toBe(true);

    await act(async () => {
      await result.current.pickFolder();
    });

    expect(result.current.openFiles).toEqual([]);
    expect(result.current.hasUnsaved).toBe(false);
    expect(result.current.activeFile).toBeNull();
  });

  it('ignores ordinary watcher noise and refreshes after MTUI metadata changes', async () => {
    let listener: FileChangedListener | null = null;
    onFileChangedMock.mockImplementation((handler: FileChangedListener) => {
      listener = handler;
      return vi.fn();
    });
    const { result } = renderHook(() => useIdeWorkspace());
    await waitFor(() => expect(result.current.restoring).toBe(false));

    await act(async () => {
      await result.current.pickFolder();
    });
    await waitFor(() => expect(fileWatchStartMock).toHaveBeenCalledWith(ROOT));

    expect(listDirMock).toHaveBeenCalledTimes(1);
    vi.useFakeTimers();
    await act(async () => {
      listener?.({ rootPath: ROOT, relativePath: 'dist/bundle.js', path: '/repo/dist/bundle.js' });
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(listDirMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      listener?.({ rootPath: ROOT, relativePath: '.mtui/mtui.db', path: '/repo/.mtui/mtui.db' });
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(listDirMock).toHaveBeenCalledTimes(2);
  });

  it('schedules one background tree refresh every 3 minutes', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const { result } = renderHook(() => useIdeWorkspace());
    await waitFor(() => expect(result.current.restoring).toBe(false));

    await act(async () => {
      await result.current.pickFolder();
    });

    const refreshCall = setIntervalSpy.mock.calls.find(([, delay]) => delay === 180_000);
    expect(refreshCall).toBeDefined();
    if (!refreshCall) throw new Error('IDE refresh interval was not scheduled');
    expect(listDirMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      (refreshCall[0] as () => void)();
    });
    expect(listDirMock).toHaveBeenCalledTimes(2);
  });

  it('refreshes once after an editor save and suppresses its matching MTUI metadata event', async () => {
    let listener: FileChangedListener | null = null;
    onFileChangedMock.mockImplementation((handler: FileChangedListener) => {
      listener = handler;
      return vi.fn();
    });
    const { result } = renderHook(() => useIdeWorkspace());
    await waitFor(() => expect(result.current.restoring).toBe(false));
    await act(async () => {
      await result.current.pickFolder();
    });

    await act(async () => {
      await result.current.refreshAfterSave(FILE_A);
    });
    expect(listDirMock).toHaveBeenCalledTimes(2);

    vi.useFakeTimers();
    await act(async () => {
      listener?.({ rootPath: ROOT, relativePath: '.mtui/mtui.db', path: '/repo/.mtui/mtui.db' });
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(listDirMock).toHaveBeenCalledTimes(2);
  });
});

/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useStudioFiles` — state + actions for the Studio dashboard.
 *
 * Owns the recent/starred lists (persisted via {@link studioStorage}) and the
 * "open a file" flow: it asks Main for a file via the existing `dialog.showOpen`
 * bridge (no new backend), records the pick as recent, and hands the chosen path
 * up so the page can mount the Universal Editor on it. Renderer-only.
 */

import { ipcBridge } from '@/common';
import { useCallback, useState } from 'react';
import {
  addRecentFile,
  getRecentFiles,
  getStarredFiles,
  removeRecentFile,
  toggleStarred,
  type StudioFileEntry,
} from '../studioStorage';

/** The value returned by {@link useStudioFiles}. */
export type UseStudioFilesResult = {
  /** Recent files, newest first. */
  recent: StudioFileEntry[];
  /** Starred files. */
  starred: StudioFileEntry[];
  /** Open the native file picker; resolves to the chosen path or `null`. */
  pickFile: () => Promise<string | null>;
  /** Mark a path as opened (updates the recent list) and return it. */
  markOpened: (filePath: string) => void;
  /** Remove a path from recents. */
  forget: (filePath: string) => void;
  /** Toggle a path's starred state. */
  star: (filePath: string) => void;
  /** Re-read both lists from storage (after external mutation). */
  refresh: () => void;
};

/**
 * Manage the Studio file lists and the open-file dialog.
 */
export const useStudioFiles = (): UseStudioFilesResult => {
  const [recent, setRecent] = useState<StudioFileEntry[]>(() => getRecentFiles());
  const [starred, setStarred] = useState<StudioFileEntry[]>(() => getStarredFiles());

  const refresh = useCallback((): void => {
    setRecent(getRecentFiles());
    setStarred(getStarredFiles());
  }, []);

  const pickFile = useCallback(async (): Promise<string | null> => {
    const picked = await ipcBridge.dialog.showOpen.invoke({ properties: ['openFile'] });
    if (!picked || picked.length === 0) return null;
    return picked[0];
  }, []);

  const markOpened = useCallback((filePath: string): void => {
    setRecent(addRecentFile(filePath));
  }, []);

  const forget = useCallback((filePath: string): void => {
    setRecent(removeRecentFile(filePath));
  }, []);

  const star = useCallback((filePath: string): void => {
    setStarred(toggleStarred(filePath));
  }, []);

  return { recent, starred, pickFile, markOpened, forget, star, refresh };
};

export default useStudioFiles;

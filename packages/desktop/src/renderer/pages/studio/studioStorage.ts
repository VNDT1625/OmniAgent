/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `studioStorage` — local persistence for the Studio app (the WPS-like file hub).
 *
 * Studio keeps a small list of recently opened files and a set of starred files
 * in `localStorage` (renderer-only, no backend table needed). It is intentionally
 * tiny and dependency-free so the dashboard can read/write synchronously.
 */

/** A single entry in the Studio "recent files" / "starred" lists. */
export type StudioFileEntry = {
  /** Absolute path of the file on disk. */
  path: string;
  /** Basename shown in the list (derived once, kept for display). */
  name: string;
  /** Epoch ms of the last time the file was opened in Studio. */
  openedAt: number;
};

const RECENT_KEY = 'studio.recentFiles';
const STARRED_KEY = 'studio.starredFiles';
const RECENT_LIMIT = 50;

/** Read + parse a JSON array from localStorage, tolerating corruption. */
const readList = (key: string): StudioFileEntry[] => {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is StudioFileEntry =>
        typeof item === 'object' && item !== null && typeof (item as StudioFileEntry).path === 'string'
    );
  } catch {
    return [];
  }
};

/** Persist a list, silently ignoring quota/serialization errors. */
const writeList = (key: string, list: StudioFileEntry[]): void => {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    /* storage full or unavailable — non-fatal for a recents list */
  }
};

/** Extract the basename of a path (handles both `/` and `\` separators). */
export const baseName = (filePath: string): string => {
  const lastSlash = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
  return lastSlash === -1 ? filePath : filePath.slice(lastSlash + 1);
};

/** Return the recent-files list, newest first. */
export const getRecentFiles = (): StudioFileEntry[] => readList(RECENT_KEY);

/** Return the starred-files list. */
export const getStarredFiles = (): StudioFileEntry[] => readList(STARRED_KEY);

/**
 * Record a freshly opened file as the most recent. De-duplicates by path,
 * moves an existing entry to the front, and caps the list at {@link RECENT_LIMIT}.
 *
 * @returns the updated recent list (newest first).
 */
export const addRecentFile = (filePath: string): StudioFileEntry[] => {
  const entry: StudioFileEntry = { path: filePath, name: baseName(filePath), openedAt: Date.now() };
  const next = [entry, ...getRecentFiles().filter((item) => item.path !== filePath)].slice(0, RECENT_LIMIT);
  writeList(RECENT_KEY, next);
  return next;
};

/** Remove a file from the recent list. */
export const removeRecentFile = (filePath: string): StudioFileEntry[] => {
  const next = getRecentFiles().filter((item) => item.path !== filePath);
  writeList(RECENT_KEY, next);
  return next;
};

/** Clear the entire recent list. */
export const clearRecentFiles = (): void => writeList(RECENT_KEY, []);

/** Whether a path is currently starred. */
export const isStarred = (filePath: string): boolean => getStarredFiles().some((item) => item.path === filePath);

/**
 * Toggle the starred state of a file.
 *
 * @returns the updated starred list.
 */
export const toggleStarred = (filePath: string): StudioFileEntry[] => {
  const current = getStarredFiles();
  const exists = current.some((item) => item.path === filePath);
  const next = exists
    ? current.filter((item) => item.path !== filePath)
    : [{ path: filePath, name: baseName(filePath), openedAt: Date.now() }, ...current];
  writeList(STARRED_KEY, next);
  return next;
};

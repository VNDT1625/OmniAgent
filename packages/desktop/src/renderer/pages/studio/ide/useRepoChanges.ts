/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useRepoChanges` — tracks the working-tree changes of the IDE's open folder so
 * the Files mode can show a diff-review banner ("N files changed") after a CLI
 * agent edits files on disk.
 *
 * Since the embedded CLI agent writes straight to disk (no in-app edit event to
 * subscribe to), this hook polls `ide.git-status` on an interval while the IDE
 * is mounted, plus exposes a `refresh()` for an explicit re-check (e.g. when the
 * user opens the review panel). A short poll is fine: `git status` is cheap and
 * the call is timeout-guarded + always-resolving, so a non-git folder simply
 * reports zero changes without error spam.
 *
 * Renderer-only: talks to Main via {@link ideClient}.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ideClient, type GitChange } from './ideClient';

/** Poll cadence (ms) for `git status` while the IDE is open. */
const POLL_INTERVAL_MS = 5000;

/** Public shape returned by {@link useRepoChanges}. */
export type UseRepoChanges = {
  /** The current working-tree changes (empty when clean / not a git repo). */
  changes: GitChange[];
  /** True when the open folder is not a git repository (status failed). */
  notGit: boolean;
  /** Force an immediate re-check of `git status`. */
  refresh: () => Promise<void>;
};

export const useRepoChanges = (rootPath: string | null): UseRepoChanges => {
  const [changes, setChanges] = useState<GitChange[]>([]);
  const [notGit, setNotGit] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    if (!rootPath) {
      setChanges([]);
      setNotGit(false);
      return;
    }
    const result = await ideClient.gitStatus(rootPath).catch((): null => null);
    if (!mountedRef.current) return;
    if (result && result.ok) {
      setChanges(result.data);
      setNotGit(false);
    } else {
      // status failed → almost always "not a git repo" (or git missing).
      setChanges([]);
      setNotGit(true);
    }
  }, [rootPath]);

  // Poll while a folder is open. Resets immediately on a rootPath change.
  useEffect(() => {
    if (!rootPath) {
      setChanges([]);
      setNotGit(false);
      return undefined;
    }
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [rootPath, refresh]);

  return { changes, notGit, refresh };
};

export default useRepoChanges;

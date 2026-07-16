/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useIdeHooks` — renderer state + dispatch for IDE Agent Hooks of one
 * workspace folder.
 *
 * Responsibilities:
 *  - Load + CRUD the workspace's hook list through {@link ideHookClient}.
 *  - While the workspace is open, ask the Main process to WATCH it so file
 *    events fire hooks; subscribe to `ide-hook.fired` and DISPATCH each firing:
 *      - `runCommand` → run the command in a terminal session (terminalClient);
 *      - `askAgent`   → emit `ide.hook.askAgent` so the IDE Chat surface sends
 *        the prompt to an agent tab.
 *
 * Dispatch lives in the renderer because the agent/terminal surfaces do. The
 * Main process only decides which hook fires for which file.
 *
 * Renderer-only. No Node APIs.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Message } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { terminalClient } from '@/renderer/pages/terminal/terminalBridgeClient';
import { ideHookClient, type IdeHook, type IdeHookFireRequest } from './ideHookClient';

/** Options for {@link useIdeHooks}. */
export type UseIdeHooksOptions = {
  /**
   * Whether this instance OWNS firing: starts the watcher and dispatches fired
   * hooks. Exactly one instance per workspace should set this (the workspace
   * shell), so file events fire regardless of which IDE mode is open and the
   * action is dispatched once. Presentational consumers omit it.
   */
  dispatch?: boolean;
  /**
   * Called when an `askAgent` hook fires. The owner routes this to the IDE Chat
   * surface (switch to Chat mode + drop the prompt into the composer). When
   * omitted, an info toast is shown instead.
   */
  onAskAgent?: (prompt: string, hookName: string) => void;
};

/** Public shape returned by {@link useIdeHooks}. */
export type UseIdeHooks = {
  hooks: IdeHook[];
  loading: boolean;
  /** Whether the bridge is unavailable (channel not registered). */
  unavailable: boolean;
  /** Create/update a hook. */
  save: (hook: Partial<IdeHook> & { name: string }) => Promise<boolean>;
  /** Delete a hook by id. */
  remove: (id: string) => Promise<void>;
  /** Manually trigger a hook now. */
  runNow: (id: string) => Promise<void>;
  /** Re-load the list from disk. */
  refresh: () => Promise<void>;
};

/** Run a fired hook's command in a fresh terminal session at the workspace root. */
const dispatchRunCommand = async (firing: IdeHookFireRequest): Promise<void> => {
  const command = firing.hook.command?.trim();
  if (!command) return;
  const res = await terminalClient.create({ options: { cwd: firing.rootPath } }).catch((): null => null);
  if (!res || !res.ok) return;
  // Send the command followed by a newline so the shell executes it.
  void terminalClient.write({ id: res.data.id, data: `${command}\r` }).catch(() => {});
};

/** Build the prompt text for an askAgent firing (with the triggering file note). */
const askAgentPrompt = (firing: IdeHookFireRequest): string => {
  const prompt = firing.hook.prompt?.trim() ?? '';
  return firing.relPath ? `${prompt}\n\n(Triggered by change to: ${firing.relPath})` : prompt;
};

/**
 * Manage + (optionally) run a workspace's IDE hooks.
 *
 * @param rootPath Absolute folder the IDE has open, or null (everything no-ops).
 * @param options  Set `dispatch: true` on the single owning instance.
 */
export const useIdeHooks = (rootPath: string | null, options: UseIdeHooksOptions = {}): UseIdeHooks => {
  const { dispatch = false, onAskAgent } = options;
  const { t } = useTranslation();
  const [hooks, setHooks] = useState<IdeHook[]>([]);
  const [loading, setLoading] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const aliveRef = useRef(true);
  // Keep the latest onAskAgent without resubscribing the fired listener.
  const onAskAgentRef = useRef(onAskAgent);
  onAskAgentRef.current = onAskAgent;

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  const dispatchFiring = useCallback(
    (firing: IdeHookFireRequest): void => {
      if (firing.hook.action === 'runCommand') {
        void dispatchRunCommand(firing);
        Message.info(t('ide.hooks.firedCommand', { name: firing.hook.name }));
      } else {
        const prompt = askAgentPrompt(firing);
        if (onAskAgentRef.current) onAskAgentRef.current(prompt, firing.hook.name);
        Message.info(t('ide.hooks.firedAgent', { name: firing.hook.name }));
      }
    },
    [t]
  );

  const refresh = useCallback(async (): Promise<void> => {
    if (!rootPath) {
      setHooks([]);
      return;
    }
    setLoading(true);
    try {
      const res = await ideHookClient.list(rootPath);
      if (!aliveRef.current) return;
      if (res.ok) {
        setHooks(res.data);
        setUnavailable(false);
      } else {
        setUnavailable(true);
      }
    } catch {
      if (aliveRef.current) setUnavailable(true);
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [rootPath]);

  // Load hooks on workspace change.
  useEffect(() => {
    void refresh();
  }, [rootPath, refresh]);

  // Only the OWNING instance starts the watcher + dispatches fired hooks, so a
  // file event fires regardless of which IDE mode is visible, exactly once.
  useEffect(() => {
    if (!dispatch || !rootPath) return;
    void ideHookClient.watchStart(rootPath).catch(() => {});
    const off = ideHookClient.onFired((firing) => {
      if (firing.rootPath !== rootPath) return;
      dispatchFiring(firing);
    });
    return () => {
      off();
      void ideHookClient.watchStop(rootPath).catch(() => {});
    };
  }, [dispatch, rootPath, dispatchFiring]);

  const save = useCallback(
    async (hook: Partial<IdeHook> & { name: string }): Promise<boolean> => {
      if (!rootPath) return false;
      const res = await ideHookClient.save(rootPath, hook).catch((): null => null);
      if (res && res.ok) {
        await refresh();
        return true;
      }
      Message.error(t('ide.hooks.saveError'));
      return false;
    },
    [rootPath, refresh, t]
  );

  const remove = useCallback(
    async (id: string): Promise<void> => {
      if (!rootPath) return;
      const res = await ideHookClient.remove(rootPath, id).catch((): null => null);
      if (res && res.ok) setHooks(res.data);
    },
    [rootPath]
  );

  const runNow = useCallback(
    async (id: string): Promise<void> => {
      if (!rootPath) return;
      const res = await ideHookClient.run(rootPath, id).catch((): null => null);
      if (res && res.ok && res.data) dispatchFiring(res.data);
    },
    [rootPath, dispatchFiring]
  );

  return { hooks, loading, unavailable, save, remove, runNow, refresh };
};

export default useIdeHooks;

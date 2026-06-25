/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * State hook for the News page.
 *
 * Loads the full {@link NewsData} document from the Main-process bridge on
 * mount, subscribes to live `dataChanged` pushes, and exposes typed actions
 * that delegate to the bridge client. All bridge calls are wrapped in
 * try/catch so a transient IPC failure never crashes the page.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { newsClient } from './newsBridgeClient';
import type { NewsCategoryId, NewsData, NewsFeed, NewsSettings } from '@process/news/newsTypes';
import type { NewFeedInput } from '@process/news/newsStore';

export type NewsPageStatus = 'loading' | 'ready' | 'error' | 'unavailable';

export type UseNewsStateReturn = {
  status: NewsPageStatus;
  data: NewsData | null;
  errorMessage: string;
  refreshing: boolean;
  // Actions
  addFeed: (input: NewFeedInput) => Promise<boolean>;
  updateFeed: (id: string, patch: Partial<Omit<NewsFeed, 'id' | 'createdAt'>>) => Promise<boolean>;
  removeFeed: (id: string) => Promise<boolean>;
  refreshFeed: (id: string) => Promise<boolean>;
  refreshAll: () => Promise<void>;
  markRead: (id: string, read: boolean) => Promise<void>;
  markAllRead: () => Promise<void>;
  clearItems: (feedId?: string) => Promise<void>;
  updateSettings: (patch: Partial<NewsSettings>) => Promise<boolean>;
  validateFeed: (url: string) => Promise<import('@process/news/newsBridge').ValidateFeedResult>;
};

export const useNewsState = (): UseNewsStateReturn => {
  const [status, setStatus] = useState<NewsPageStatus>('loading');
  const [data, setData] = useState<NewsData | null>(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);

  // Load initial data and subscribe to live updates.
  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      try {
        const result = await newsClient.getData();
        if (cancelled) return;
        if (result.ok) {
          setData(result.data);
          setStatus('ready');
        } else {
          // Without strictNullChecks the `else` branch does not narrow the union
          // to its failure member, so name it explicitly before reading `error`.
          setErrorMessage((result as { ok: false; error: string }).error);
          setStatus('error');
        }
      } catch (error) {
        if (cancelled) return;
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('bridge may not be wired')) {
          setStatus('unavailable');
        } else {
          setErrorMessage(msg);
          setStatus('error');
        }
      }
    };

    void load();

    // Subscribe to live pushes from Main process.
    unsubRef.current = newsClient.onDataChanged((updated) => {
      if (!cancelled) setData(updated);
    });

    return () => {
      cancelled = true;
      unsubRef.current?.();
      unsubRef.current = null;
    };
  }, []);

  /** Wrap a bridge call: update local data on success, return ok/fail. */
  const call = useCallback(
    async (action: () => Promise<{ ok: true; data: NewsData } | { ok: false; error: string }>): Promise<boolean> => {
      try {
        const result = await action();
        if (result.ok) {
          setData(result.data);
          return true;
        }
        console.error('[useNewsState] bridge error:', (result as { ok: false; error: string }).error);
        return false;
      } catch (error) {
        console.error('[useNewsState] bridge call failed:', error);
        return false;
      }
    },
    []
  );

  const addFeed = useCallback((input: NewFeedInput) => call(() => newsClient.addFeed({ input })), [call]);

  const updateFeed = useCallback(
    (id: string, patch: Partial<Omit<NewsFeed, 'id' | 'createdAt'>>) =>
      call(() => newsClient.updateFeed({ id, patch })),
    [call]
  );

  const removeFeed = useCallback((id: string) => call(() => newsClient.removeFeed({ id })), [call]);

  const refreshFeed = useCallback((id: string) => call(() => newsClient.refreshFeed({ id })), [call]);

  const refreshAll = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await newsClient.refreshAll();
      if (result.ok) setData(result.data);
    } catch (error) {
      console.error('[useNewsState] refreshAll failed:', error);
    } finally {
      setRefreshing(false);
    }
  }, []);

  const markRead = useCallback(async (id: string, read: boolean) => {
    try {
      const result = await newsClient.markRead({ id, read });
      if (result.ok) setData(result.data);
    } catch {
      /* silent */
    }
  }, []);

  const markAllRead = useCallback(async () => {
    try {
      const result = await newsClient.markAllRead();
      if (result.ok) setData(result.data);
    } catch {
      /* silent */
    }
  }, []);

  const clearItems = useCallback(async (feedId?: string) => {
    try {
      const result = await newsClient.clearItems({ feedId });
      if (result.ok) setData(result.data);
    } catch {
      /* silent */
    }
  }, []);

  const updateSettings = useCallback(
    (patch: Partial<NewsSettings>) => call(() => newsClient.updateSettings({ patch })),
    [call]
  );

  const validateFeed = useCallback((url: string) => newsClient.validateFeed({ url }), []);

  return {
    status,
    data,
    errorMessage,
    refreshing,
    addFeed,
    updateFeed,
    removeFeed,
    refreshFeed,
    refreshAll,
    markRead,
    markAllRead,
    clearItems,
    updateSettings,
    validateFeed,
  };
};

// Re-export for convenience in child components.
export type { NewsCategoryId, NewsData, NewsFeed, NewsSettings };

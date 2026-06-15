/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRealtimeConnector, type RealtimeSocket } from '@process/news/realtimeConnector';
import type { INewsStore, IngestItemInput } from '@process/news/newsStore';
import type { NewsData, NewsFeed, NewsSettings } from '@process/news/newsTypes';

const FLUSH_MS = 8_000;

/** Minimal in-memory store stub exposing only what the connector touches. */
const makeStore = (settingsOver: Partial<NewsSettings> = {}) => {
  const feeds: NewsFeed[] = [];
  const ingested: IngestItemInput[] = [];
  const listeners = new Set<(d: NewsData) => void>();
  const settings: NewsSettings = {
    refreshIntervalMinutes: 15,
    maxItemsPerFeed: 100,
    keywordRules: [],
    translateEnabled: false,
    translateTargetLang: null,
    realtimeEnabled: true,
    ...settingsOver,
  };
  const data = (): NewsData => ({ version: 1, feeds, items: [], settings });
  const store = {
    load: vi.fn(async () => data()),
    getData: () => data(),
    addFeed: vi.fn(async (input: { url: string; title?: string; kind?: NewsFeed['kind'] }) => {
      const feed: NewsFeed = {
        id: 'realtime-1',
        kind: input.kind ?? 'rss',
        url: input.url,
        title: input.title ?? input.url,
        category: null,
        enabled: true,
        createdAt: 0,
        lastFetchedAt: null,
        lastError: null,
      };
      feeds.push(feed);
      return feed;
    }),
    ingestItems: vi.fn(async (_feedId: string, items: IngestItemInput[]) => {
      ingested.push(...items);
      return data();
    }),
    onChange: (listener: (d: NewsData) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const emitChange = () => listeners.forEach((l) => l(data()));
  return { store: store as unknown as INewsStore, raw: store, ingested, settings, emitChange };
};

const makeSocket = (): RealtimeSocket => ({
  close: vi.fn(),
  onopen: null,
  onmessage: null,
  onclose: null,
  onerror: null,
});

const postEvent = (text: string, did = 'did:plc:abc', rkey = 'r1') =>
  JSON.stringify({
    kind: 'commit',
    did,
    time_us: 1_700_000_000_000_000,
    commit: { operation: 'create', collection: 'app.bsky.feed.post', rkey, record: { text } },
  });

/** Full-firehose mode (curated disabled) is the default for most tests. */
const FULL = { curatedHandles: [] as string[] };

describe('realtimeConnector — Bluesky firehose (full mode)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('creates a synthetic bluesky feed on start', async () => {
    const { store, raw } = makeStore();
    const socket = makeSocket();
    const connector = createRealtimeConnector({ store, wsFactory: () => socket, ...FULL });
    await connector.start();
    expect(raw.addFeed).toHaveBeenCalledWith(expect.objectContaining({ kind: 'bluesky' }));
    connector.stop();
  });

  it('ingests keyword-matching posts after a flush', async () => {
    const { store, ingested } = makeStore();
    const socket = makeSocket();
    const connector = createRealtimeConnector({ store, wsFactory: () => socket, keywords: ['ai'], ...FULL });
    await connector.start();
    await vi.advanceTimersByTimeAsync(1);
    socket.onopen?.({});
    socket.onmessage?.({ data: postEvent('New AI model launched today') });
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(ingested).toHaveLength(1);
    expect(ingested[0].link).toContain('bsky.app/profile/did:plc:abc/post/r1');
    connector.stop();
  });

  it('ignores posts that match no keyword', async () => {
    const { store, ingested } = makeStore();
    const socket = makeSocket();
    const connector = createRealtimeConnector({ store, wsFactory: () => socket, keywords: ['quantum'], ...FULL });
    await connector.start();
    await vi.advanceTimersByTimeAsync(1);
    socket.onmessage?.({ data: postEvent('just having lunch') });
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(ingested).toHaveLength(0);
    connector.stop();
  });

  it('does not connect when realtime is disabled in settings', async () => {
    const { store } = makeStore({ realtimeEnabled: false });
    const wsFactory = vi.fn(() => makeSocket());
    const connector = createRealtimeConnector({ store, wsFactory, ...FULL });
    await connector.start();
    expect(wsFactory).not.toHaveBeenCalled();
    connector.stop();
  });

  it('connects when the setting flips on at runtime', async () => {
    const ctx = makeStore({ realtimeEnabled: false });
    const wsFactory = vi.fn(() => makeSocket());
    const connector = createRealtimeConnector({ store: ctx.store, wsFactory, ...FULL });
    await connector.start();
    expect(wsFactory).not.toHaveBeenCalled();
    ctx.settings.realtimeEnabled = true;
    ctx.emitChange();
    await vi.advanceTimersByTimeAsync(1);
    expect(wsFactory).toHaveBeenCalledTimes(1);
    connector.stop();
  });

  it('stops permanently when the runtime has no WebSocket', async () => {
    const { store } = makeStore();
    const wsFactory = vi.fn(() => {
      throw new Error('no WebSocket');
    });
    const connector = createRealtimeConnector({ store, wsFactory, ...FULL });
    await connector.start();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(wsFactory).toHaveBeenCalledTimes(1);
    expect(connector.isConnected()).toBe(false);
    connector.stop();
  });

  it('force-reconnects when the firehose goes stale (watchdog)', async () => {
    const { store } = makeStore();
    const socket = makeSocket();
    const connector = createRealtimeConnector({ store, wsFactory: () => socket, keywords: ['ai'], ...FULL });
    await connector.start();
    await vi.advanceTimersByTimeAsync(1);
    socket.onopen?.({});
    expect(connector.isConnected()).toBe(true);
    await vi.advanceTimersByTimeAsync(90_000);
    expect(socket.close).toHaveBeenCalled();
    connector.stop();
  });
});

describe('realtimeConnector — curated-DID mode', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('resolves handles to DIDs, subscribes with wantedDids, and ingests without keyword gating', async () => {
    const { store, ingested } = makeStore();
    const socket = makeSocket();
    let capturedUrl = '';
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ did: 'did:plc:xyz' }), { status: 200 }));
    const connector = createRealtimeConnector({
      store,
      wsFactory: (u) => {
        capturedUrl = u;
        return socket;
      },
      fetch: fetchMock as unknown as typeof fetch,
      curatedHandles: ['news.example.com'],
      keywords: ['zzzznomatch'],
    });
    await connector.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(capturedUrl).toContain('wantedDids=did%3Aplc%3Axyz');
    socket.onopen?.({});
    // Text matches no keyword, but curated mode ingests all curated-account posts.
    socket.onmessage?.({ data: postEvent('a lunch photo with no keywords', 'did:plc:xyz') });
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(ingested).toHaveLength(1);
    connector.stop();
  });

  it('falls back to full firehose + keyword filter when no handle resolves', async () => {
    const { store, ingested } = makeStore();
    const socket = makeSocket();
    let capturedUrl = '';
    const fetchMock = vi.fn(async () => new Response('not found', { status: 404 }));
    const connector = createRealtimeConnector({
      store,
      wsFactory: (u) => {
        capturedUrl = u;
        return socket;
      },
      fetch: fetchMock as unknown as typeof fetch,
      curatedHandles: ['bad.example.com'],
      keywords: ['ai'],
    });
    await connector.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(capturedUrl).not.toContain('wantedDids');
    socket.onmessage?.({ data: postEvent('lunch photo') }); // no keyword → dropped
    socket.onmessage?.({ data: postEvent('new AI breakthrough', 'did:plc:abc', 'r2') });
    await vi.advanceTimersByTimeAsync(FLUSH_MS);
    expect(ingested).toHaveLength(1);
    connector.stop();
  });
});

/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Realtime social connector — Bluesky Jetstream firehose.
 *
 * This is the "true realtime" leg of the News feature. Unlike RSS (pull-based,
 * minutes of latency) it holds a persistent WebSocket to Bluesky's public
 * **Jetstream** endpoint (`wss://jetstream*.bsky.network/subscribe`), a JSON
 * firehose of every new post on the network — free, no auth, no key. Posts are
 * filtered client-side against a keyword set (topics + the major countries the
 * user cares about), classified with the existing rule-based classifier (no
 * AI), buffered, and ingested into the shared {@link INewsStore} under a single
 * synthetic `bluesky` feed. The store's `onChange` push then updates the
 * renderer live.
 *
 * Volume control: the firehose is huge, so we (a) keep only keyword matches,
 * (b) cap matches per flush, and (c) flush on a short timer. Reconnects use
 * exponential backoff. Everything is best-effort — a dropped socket never
 * crashes the Main process.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs. Uses the global
 * `WebSocket` (Electron ≥ 28 / Node ≥ 21); injectable for tests.
 */

import { buildKeywordIndex, classifyItem } from './newsClassifier';
import type { INewsStore, IngestItemInput } from './newsStore';

/** Jetstream base (query appended per-mode). */
const JETSTREAM_BASE = 'wss://jetstream2.us-east.bsky.network/subscribe';

/** Public AT Proto handle→DID resolver (keyless). */
const RESOLVE_HANDLE_URL = 'https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle';
const RESOLVE_TIMEOUT_MS = 8_000;

/** Stable identifier for the synthetic realtime feed. */
const BLUESKY_FEED_URL = 'jetstream://bluesky';
const BLUESKY_FEED_TITLE = 'Bluesky (realtime)';

/** Flush cadence + caps so the firehose can't overwhelm the store. */
const FLUSH_INTERVAL_MS = 8_000;
const FLUSH_MAX_ITEMS = 20;
const MAX_BUFFER = 60;

/** Reconnect backoff bounds. */
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;

/**
 * Stale-connection watchdog: Jetstream can go silent without emitting a close
 * event (proxy/NAT idle timeouts). If no message arrives for {@link STALE_MS}
 * while we believe we are connected, force a reconnect. Checked every
 * {@link WATCHDOG_INTERVAL_MS}.
 */
const WATCHDOG_INTERVAL_MS = 15_000;
const STALE_MS = 75_000;

/** Minimal WebSocket surface we rely on (matches the global/undici WebSocket). */
export type RealtimeSocket = {
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
};

export type RealtimeSocketFactory = (url: string) => RealtimeSocket;

export type RealtimeConnectorDeps = {
  store: INewsStore;
  /** Keyword set used in full-firehose mode. Lower-cased substring match on post text. */
  keywords?: string[];
  /**
   * Curated Bluesky handles to follow. When non-empty (the default), the
   * connector resolves them to DIDs and subscribes with `wantedDids`, so the
   * firehose only delivers those accounts' posts — cutting inbound bandwidth by
   * ~99% and skipping keyword filtering (every curated post is wanted). If
   * resolution yields nothing (offline/blocked), it falls back to the full
   * firehose + keyword filter. Pass `[]` to force full-firehose mode.
   */
  curatedHandles?: string[];
  /** Jetstream URL override (forces full mode, bypasses DID resolution). */
  url?: string;
  /** WebSocket factory. Defaults to the global `WebSocket`. */
  wsFactory?: RealtimeSocketFactory;
  /** HTTP fetch for handle→DID resolution. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Schedule a timer. Defaults to `setTimeout`/`setInterval` wrappers. */
  setTimer?: (handler: () => void, ms: number) => { clear: () => void };
};

export type IRealtimeConnector = {
  /** Open the firehose and begin ingesting matches. Idempotent. */
  start(): Promise<void>;
  /** Close the socket + timers. */
  stop(): void;
  /** Whether the socket is currently open. */
  isConnected(): boolean;
};

/**
 * Default keyword set: the topic + country coverage the user asked for. Kept
 * deliberately broad-but-curated so the firehose match rate stays useful, not
 * noisy. Lower-cased; matched as whole-ish substrings against post text.
 */
export const DEFAULT_REALTIME_KEYWORDS: string[] = [
  // Tech / AI
  'ai',
  'artificial intelligence',
  'llm',
  'openai',
  'anthropic',
  'gpt',
  'gemini',
  'claude',
  'hugging face',
  'huggingface',
  'machine learning',
  'startup',
  'github',
  'opensource',
  // Politics / world
  'election',
  'politics',
  'parliament',
  'sanctions',
  // Major countries
  'usa',
  'america',
  'china',
  'india',
  'korea',
  'vietnam',
  'japan',
  'russia',
];

/**
 * Default curated Bluesky accounts (news + tech orgs known to publish there).
 * Handles that don't resolve are silently skipped, so the list can be generous.
 */
export const DEFAULT_CURATED_HANDLES: string[] = [
  'bsky.app',
  'theverge.com',
  'arstechnica.com',
  'wired.com',
  'techcrunch.com',
  'nytimes.com',
  'npr.org',
  'apnews.com',
  'reuters.com',
  'bbc.com',
  'nature.com',
  'theguardian.com',
];

type JetstreamEvent = {
  kind?: string;
  did?: string;
  time_us?: number;
  commit?: {
    operation?: string;
    collection?: string;
    rkey?: string;
    record?: { text?: unknown; createdAt?: unknown; langs?: unknown };
  };
};

const isString = (v: unknown): v is string => typeof v === 'string';

const defaultTimer = (handler: () => void, ms: number): { clear: () => void } => {
  const id = setTimeout(handler, ms);
  return { clear: () => clearTimeout(id) };
};

const defaultWsFactory: RealtimeSocketFactory = (url) => {
  const Ctor = (globalThis as { WebSocket?: new (u: string) => RealtimeSocket }).WebSocket;
  if (!Ctor) throw new Error('Global WebSocket is not available in this runtime');
  return new Ctor(url);
};

/** Build a short title from post text (first sentence-ish, ≤ 120 chars). */
const titleFromText = (text: string): string => {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= 120) return flat;
  return `${flat.slice(0, 119)}…`;
};

/**
 * Create the Bluesky realtime connector. Call {@link IRealtimeConnector.start}
 * once during Main-process bootstrap (after the store is wired).
 */
export const createRealtimeConnector = (deps: RealtimeConnectorDeps): IRealtimeConnector => {
  const now = deps.now ?? Date.now;
  const wsFactory = deps.wsFactory ?? defaultWsFactory;
  const httpFetch = deps.fetch ?? fetch;
  const scheduleTimer = deps.setTimer ?? defaultTimer;
  const keywords = (deps.keywords ?? DEFAULT_REALTIME_KEYWORDS).map((k) => k.toLowerCase());
  const curatedHandles = deps.curatedHandles ?? DEFAULT_CURATED_HANDLES;

  let socket: RealtimeSocket | null = null;
  let started = false;
  let connected = false;
  let reconnectDelay = RECONNECT_MIN_MS;
  let reconnectTimer: { clear: () => void } | null = null;
  let flushTimer: { clear: () => void } | null = null;
  let watchdogTimer: { clear: () => void } | null = null;
  let unsubscribe: (() => void) | null = null;
  /** Set once if the runtime has no WebSocket — we then stop trying forever. */
  let wsUnavailable = false;
  /** Epoch ms of the last frame received (for the stale watchdog). */
  let lastMessageAt = 0;
  let feedId: string | null = null;
  /** Resolved curated DIDs (null = not resolved yet). Stable, so resolved once. */
  let resolvedDids: string[] | null = null;
  /** True when subscribed to a curated DID set (skips keyword filtering). */
  let curatedMode = false;
  const buffer = new Map<string, IngestItemInput>();

  /** Desired on/off state from settings (default on when unset). */
  const isEnabledBySettings = (): boolean => deps.store.getData().settings.realtimeEnabled !== false;

  /** Resolve one Bluesky handle to its DID (best-effort). */
  const resolveHandle = async (handle: string): Promise<string | null> => {
    const u = `${RESOLVE_HANDLE_URL}?handle=${encodeURIComponent(handle)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);
    try {
      const res = await httpFetch(u, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) return null;
      const json = (await res.json()) as { did?: unknown };
      return isString(json.did) ? json.did : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };

  /** Resolve all curated handles to DIDs once; cached for the connector's life. */
  const resolveDids = async (): Promise<string[]> => {
    if (resolvedDids) return resolvedDids;
    if (deps.url || curatedHandles.length === 0) {
      resolvedDids = [];
      return resolvedDids;
    }
    const dids = (await Promise.all(curatedHandles.map(resolveHandle))).filter((d): d is string => !!d);
    resolvedDids = dids;
    if (dids.length > 0) console.log(`[RealtimeConnector] curated mode: following ${dids.length} accounts.`);
    return dids;
  };

  /** Build the subscribe URL: explicit override, or curated DIDs, or full firehose. */
  const buildSubscribeUrl = (dids: string[]): string => {
    if (deps.url) return deps.url;
    let u = `${JETSTREAM_BASE}?wantedCollections=app.bsky.feed.post`;
    for (const did of dids) u += `&wantedDids=${encodeURIComponent(did)}`;
    return u;
  };

  /** Find or create the synthetic realtime feed; cache its id. */
  const ensureFeed = async (): Promise<string> => {
    if (feedId) return feedId;
    await deps.store.load();
    const existing = deps.store.getData().feeds.find((f) => f.kind === 'bluesky' || f.url === BLUESKY_FEED_URL);
    if (existing) {
      feedId = existing.id;
      return feedId;
    }
    const feed = await deps.store.addFeed({
      url: BLUESKY_FEED_URL,
      title: BLUESKY_FEED_TITLE,
      kind: 'bluesky',
      lang: 'en',
      category: null,
    });
    feedId = feed.id;
    return feedId;
  };

  const matchesKeyword = (text: string): boolean => {
    const lc = text.toLowerCase();
    return keywords.some((k) => lc.includes(k));
  };

  const flush = async (): Promise<void> => {
    if (buffer.size === 0) return;
    // The synthetic feed may have been deleted by the user — re-create it so
    // ingested items aren't orphaned.
    if (!feedId || !deps.store.getData().feeds.some((f) => f.id === feedId)) {
      feedId = null;
      await ensureFeed();
    }
    if (!feedId) return;
    const batch = [...buffer.values()].slice(0, FLUSH_MAX_ITEMS);
    buffer.clear();
    try {
      await deps.store.ingestItems(feedId, batch);
    } catch (error) {
      console.error('[RealtimeConnector] ingest failed:', error);
    }
  };

  const handleEvent = (raw: string): void => {
    let event: JetstreamEvent;
    try {
      event = JSON.parse(raw) as JetstreamEvent;
    } catch {
      return;
    }
    const commit = event.commit;
    if (event.kind !== 'commit' || !commit || commit.operation !== 'create') return;
    if (commit.collection !== 'app.bsky.feed.post') return;
    const text = commit.record?.text;
    if (!isString(text) || text.trim().length === 0) return;
    // Curated mode: every post is from a wanted account, so skip keyword gating.
    if (!curatedMode && !matchesKeyword(text)) return;
    if (!isString(event.did) || !isString(commit.rkey)) return;

    const guid = `${event.did}/${commit.rkey}`;
    const publishedAt = isString(commit.record?.createdAt)
      ? Date.parse(commit.record.createdAt) || (event.time_us ? Math.round(event.time_us / 1000) : now())
      : event.time_us
        ? Math.round(event.time_us / 1000)
        : now();
    const summary = text.replace(/\s+/g, ' ').trim();
    const index = buildKeywordIndex(deps.store.getData().settings.keywordRules);
    const { category, source } = classifyItem({ feedCategory: null, title: summary, summary, tags: [] }, index);

    const item: IngestItemInput = {
      guid,
      title: titleFromText(text),
      link: `https://bsky.app/profile/${event.did}/post/${commit.rkey}`,
      summary,
      author: `@${event.did.slice(0, 24)}`,
      imageUrl: null,
      publishedAt,
      category,
      categorySource: source,
      rawTags: [],
    };
    buffer.set(guid, item);
    if (buffer.size > MAX_BUFFER) {
      // Drop oldest to bound memory between flushes.
      const firstKey = buffer.keys().next().value;
      if (firstKey !== undefined) buffer.delete(firstKey);
    }
  };

  const scheduleReconnect = (): void => {
    if (!started || !isEnabledBySettings() || wsUnavailable) return;
    reconnectTimer?.clear();
    // Full jitter: random delay in [0, reconnectDelay] avoids thundering-herd
    // reconnects when many clients drop together.
    const delay = Math.floor(Math.random() * reconnectDelay);
    reconnectTimer = scheduleTimer(() => {
      void connect();
    }, delay);
    reconnectDelay = Math.min(RECONNECT_MAX_MS, reconnectDelay * 2);
  };

  const connect = async (): Promise<void> => {
    if (!started || !isEnabledBySettings() || wsUnavailable || socket) return;
    await ensureFeed();
    const dids = await resolveDids();
    if (!started || !isEnabledBySettings() || socket) return;
    curatedMode = dids.length > 0;
    const subscribeUrl = buildSubscribeUrl(dids);
    let ws: RealtimeSocket;
    try {
      ws = wsFactory(subscribeUrl);
    } catch (error) {
      // No WebSocket in this runtime — stop trying permanently (no reconnect spin).
      wsUnavailable = true;
      console.error('[RealtimeConnector] WebSocket unavailable; realtime disabled:', error);
      return;
    }
    socket = ws;
    lastMessageAt = now();
    ws.onopen = () => {
      connected = true;
      lastMessageAt = now();
      reconnectDelay = RECONNECT_MIN_MS;
      console.log('[RealtimeConnector] Bluesky firehose connected.');
    };
    ws.onmessage = (ev) => {
      lastMessageAt = now();
      if (isString(ev.data)) handleEvent(ev.data);
    };
    ws.onclose = () => {
      connected = false;
      socket = null;
      scheduleReconnect();
    };
    ws.onerror = () => {
      // `onclose` follows an error and drives the reconnect; just note it.
      connected = false;
    };
  };

  /** Tear down the live socket without stopping the connector (settings off). */
  const disconnect = (): void => {
    reconnectTimer?.clear();
    reconnectTimer = null;
    connected = false;
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
    socket = null;
    buffer.clear();
  };

  /** Reconcile the live socket with the desired (settings) state. */
  const applyDesired = (): void => {
    if (!started) return;
    if (isEnabledBySettings()) {
      if (!socket && !wsUnavailable) void connect();
    } else if (socket || reconnectTimer) {
      disconnect();
    }
  };

  /** Watchdog: force a reconnect if the socket went silent for too long. */
  const checkStale = (): void => {
    if (!started || !connected || !socket) return;
    if (now() - lastMessageAt > STALE_MS) {
      console.warn('[RealtimeConnector] firehose stale; forcing reconnect.');
      try {
        socket.close();
      } catch {
        /* ignore */
      }
      // If the platform never fires onclose, drive the reconnect ourselves.
      if (socket) {
        socket = null;
        connected = false;
        scheduleReconnect();
      }
    }
  };

  return {
    async start() {
      if (started) return;
      started = true;
      lastMessageAt = now();
      flushTimer = ((): { clear: () => void } => {
        const id = setInterval(() => {
          void flush();
        }, FLUSH_INTERVAL_MS);
        return { clear: () => clearInterval(id) };
      })();
      watchdogTimer = ((): { clear: () => void } => {
        const id = setInterval(() => checkStale(), WATCHDOG_INTERVAL_MS);
        return { clear: () => clearInterval(id) };
      })();
      // React to the realtime on/off setting changing at runtime.
      unsubscribe = deps.store.onChange(() => applyDesired());
      await ensureFeed();
      applyDesired();
    },

    stop() {
      started = false;
      connected = false;
      unsubscribe?.();
      unsubscribe = null;
      reconnectTimer?.clear();
      reconnectTimer = null;
      flushTimer?.clear();
      flushTimer = null;
      watchdogTimer?.clear();
      watchdogTimer = null;
      try {
        socket?.close();
      } catch {
        /* ignore */
      }
      socket = null;
      buffer.clear();
    },

    isConnected: () => connected,
  };
};

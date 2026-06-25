/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Minimal backend WebSocket listener for the **Main process**.
 *
 * The shared `httpBridge` WebSocket singleton (`ensureWs`) deliberately no-ops
 * when there is no `window` (i.e. in the Main process), so Main-process code
 * cannot observe `turn.completed` / `message.stream` events through it. The
 * CLI-agent conversation driver needs the authoritative `turn.completed` signal
 * to know when a CLI agent finished a turn, so this module opens its OWN tiny
 * WebSocket to aioncore (`ws://127.0.0.1:<port>/ws`) using the Node global
 * `WebSocket` (available in Node 22+, which Electron 37 bundles).
 *
 * It is intentionally tiny and best-effort:
 *  - If the global `WebSocket` is unavailable, {@link subscribeBackendEvent}
 *    returns a no-op unsubscribe and never fires — callers MUST have a polling
 *    fallback (the driver does).
 *  - It auto-reconnects with backoff and never throws into callers.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

type WsEventHandler = (payload: unknown) => void;

/** Resolve the backend WS URL from the port the Main process stored at boot. */
const getMainWsUrl = (): string | null => {
  const port = (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
  if (!port || port <= 0) return null;
  return `ws://127.0.0.1:${port}/ws`;
};

/** Whether a global `WebSocket` constructor exists in this runtime. */
const hasGlobalWebSocket = (): boolean => typeof (globalThis as { WebSocket?: unknown }).WebSocket === 'function';

const listeners = new Map<string, Set<WsEventHandler>>();
let socket: { close: () => void; readyState: number } | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
let connecting = false;

const OPEN = 1;
const CONNECTING = 0;

/** Lazily (re)connect the Main-process backend socket. Best-effort; never throws. */
const ensureSocket = (): void => {
  if (!hasGlobalWebSocket()) return;
  if (socket && (socket.readyState === OPEN || socket.readyState === CONNECTING)) return;

  const url = getMainWsUrl();
  if (!url) {
    scheduleReconnect();
    return;
  }

  if (connecting) return;
  connecting = true;

  try {
    const Ctor = (globalThis as { WebSocket: new (url: string) => WebSocketLike }).WebSocket;
    const ws = new Ctor(url);
    socket = ws;

    ws.addEventListener('open', () => {
      connecting = false;
      reconnectAttempt = 0;
    });

    ws.addEventListener('close', () => {
      connecting = false;
      if (socket === ws) socket = null;
      scheduleReconnect();
    });

    ws.addEventListener('error', () => {
      // `close` follows and handles reconnect; swallow to avoid unhandled errors.
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });

    ws.addEventListener('message', (event: { data: unknown }) => {
      try {
        const raw = typeof event.data === 'string' ? event.data : String(event.data);
        const msg = JSON.parse(raw) as { name?: string; event?: string; data?: unknown; payload?: unknown };
        const eventName = msg.name ?? msg.event;
        const payload = msg.data ?? msg.payload;
        if (!eventName) return;
        const handlers = listeners.get(eventName);
        if (!handlers) return;
        for (const handler of handlers) {
          try {
            handler(payload);
          } catch {
            /* never let one listener break the loop */
          }
        }
      } catch {
        /* ignore non-JSON frames */
      }
    });
  } catch {
    connecting = false;
    socket = null;
    scheduleReconnect();
  }
};

/** Schedule a reconnect with capped exponential backoff. */
const scheduleReconnect = (): void => {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * Math.pow(2, reconnectAttempt), 30000);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    ensureSocket();
  }, delay);
};

/** Structural subset of the `WebSocket` interface this module relies on. */
type WebSocketLike = {
  readyState: number;
  close: () => void;
  addEventListener: (type: string, listener: (event: never) => void) => void;
};

/**
 * Subscribe to a named backend event (e.g. `turn.completed`). Returns an
 * unsubscribe function. When the runtime has no global `WebSocket`, this is a
 * no-op that never fires — callers must provide their own fallback.
 */
export const subscribeBackendEvent = (eventName: string, handler: WsEventHandler): (() => void) => {
  if (!hasGlobalWebSocket()) return () => {};
  ensureSocket();
  let set = listeners.get(eventName);
  if (!set) {
    set = new Set();
    listeners.set(eventName, set);
  }
  set.add(handler);
  return () => {
    listeners.get(eventName)?.delete(handler);
  };
};

/** Whether this runtime can observe backend WS events at all. */
export const canObserveBackendEvents = (): boolean => hasGlobalWebSocket();

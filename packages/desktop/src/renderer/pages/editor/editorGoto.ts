/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A tiny pub/sub for "reveal this file at line:col" requests, used to make
 * terminal `file:line:col` links jump to the right position in the editor.
 *
 * Wiring goto through the editor tab system as props is awkward because editors
 * are kept mounted per file path. Instead, the source (e.g. the terminal panel)
 * opens the file the normal way and then emits a goto request here; the Monaco
 * adapter already mounted for that path listens and reveals the position. A
 * short-lived buffer holds the last request so an editor that mounts *just
 * after* the request (first open) can still pick it up.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

/** A request to reveal a position in a file. */
export type EditorGotoRequest = {
  /** Absolute file path (matched against the adapter's `filePath`). */
  path: string;
  /** 1-based line to reveal, if known. */
  line?: number;
  /** 1-based column to place the cursor at, if known. */
  column?: number;
  /** Timestamp (ms) of the request — used to expire stale pending requests. */
  at: number;
};

type Listener = (req: EditorGotoRequest) => void;

const listeners = new Set<Listener>();

/** The most recent request, kept briefly so a freshly-mounted editor can consume it. */
let pending: EditorGotoRequest | null = null;

/** How long a pending request stays consumable by a late-mounting editor. */
const PENDING_TTL_MS = 4000;

/** Emit a goto request to all current listeners and buffer it for late mounts. */
export const emitEditorGoto = (path: string, line?: number, column?: number): void => {
  const req: EditorGotoRequest = { path, line, column, at: Date.now() };
  pending = req;
  for (const fn of listeners) {
    try {
      fn(req);
    } catch (error) {
      console.error('[editorGoto] listener threw:', error);
    }
  }
};

/**
 * Subscribe to goto requests. Returns an unsubscribe fn. On subscribe, if a
 * fresh pending request exists it is delivered immediately (covers the
 * open-then-goto race for a file's first open).
 */
export const onEditorGoto = (listener: Listener): (() => void) => {
  listeners.add(listener);
  if (pending && Date.now() - pending.at < PENDING_TTL_MS) {
    const snapshot = pending;
    // Deliver async so the subscriber finishes mounting first.
    queueMicrotask(() => listener(snapshot));
  }
  return () => listeners.delete(listener);
};

/** Clear the buffered request (e.g. once consumed by the matching editor). */
export const consumeEditorGoto = (path: string): void => {
  if (pending && pending.path === path) pending = null;
};

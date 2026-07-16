/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared constants and pure helpers for the Browser UI (Requirement 1 —
 * embedded browser + web agent, criteria 1.1, 1.2, 1.6).
 *
 * Renderer-only module: no Node.js APIs.
 */

/**
 * How long the renderer waits for a browser IPC reply before treating the
 * Main-process bridge as "not wired yet" (Task 15.1). The platform bridge
 * leaves `invoke` pending forever when no provider is registered, so without a
 * timeout the UI would hang on a missing backend. A few seconds is generous for
 * a local IPC round-trip while still feeling responsive when the bridge is
 * absent.
 */
export const BRIDGE_TIMEOUT_MS = 4000;

/**
 * Shorter timeout for the high-frequency `setBounds` channel. Bounds are
 * re-pushed on every resize, so a long wait per call would pile up; a missed
 * bounds update is harmless and self-corrects on the next push.
 */
export const BRIDGE_BOUNDS_TIMEOUT_MS = 1500;

/**
 * `localStorage` key under which the renderer remembers the AI model the user
 * last picked to drive the web agent (criterion 1.2). The bridge only tracks a
 * per-tab on/off flag, so the *which model* choice is a renderer-side concern
 * persisted here.
 */
export const AGENT_MODEL_STORAGE_KEY = 'aionui.browser.agentModel';

/** `localStorage` key remembering which side the agent chat dock sits on. */
export const CHAT_SIDE_STORAGE_KEY = 'aionui.browser.chatSide';

/** Which side of the viewport the agent chat panel docks to. */
export type ChatSide = 'left' | 'right';

/** Discrete zoom levels offered by the toolbar (fit-to-frame, criterion 1.1). */
export const ZOOM_LEVELS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2] as const;

/** Default zoom factor for a freshly opened tab (100%). */
export const DEFAULT_ZOOM = 1;

/** Clamp a zoom factor to the supported range. */
export const clampZoom = (factor: number): number => Math.min(2, Math.max(0.5, factor));

/** Step the zoom to the next/previous discrete level (for the −/+ buttons). */
export const stepZoom = (current: number, direction: 'in' | 'out'): number => {
  const levels = ZOOM_LEVELS;
  const idx = levels.reduce(
    (best, level, i) => (Math.abs(level - current) < Math.abs(levels[best] - current) ? i : best),
    0
  );
  const nextIdx = direction === 'in' ? Math.min(levels.length - 1, idx + 1) : Math.max(0, idx - 1);
  return levels[nextIdx];
};

/** Read the remembered chat dock side (defaults to `'right'`). */
export const loadChatSide = (): ChatSide => {
  if (typeof window === 'undefined') return 'right';
  try {
    return window.localStorage.getItem(CHAT_SIDE_STORAGE_KEY) === 'left' ? 'left' : 'right';
  } catch {
    return 'right';
  }
};

/** Persist the chat dock side (best-effort). */
export const saveChatSide = (side: ChatSide): void => {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(CHAT_SIDE_STORAGE_KEY, side);
  } catch {
    // Ignore storage failures — placement is non-critical.
  }
};

/** A single Vietnamese subtitle cue rendered by the overlay (criterion 1.6). */
export type SubtitleCue = {
  /** Stable key for React lists. */
  id: string;
  /** The translated caption text to display. */
  text: string;
  /** Optional source timestamp (ms) the cue belongs to. */
  startMs?: number;
};

/** Matches an explicit URL scheme such as `https://` or `file://`. */
const HAS_SCHEME = /^[a-z][a-z\d+.-]*:\/\//i;

/** Rough heuristic for "looks like a bare domain / host" (no spaces, has a dot). */
const LOOKS_LIKE_HOST = /^[^\s]+\.[^\s]{2,}$/;

/**
 * Normalize free-text from the address bar into a navigable URL (criterion
 * 1.1):
 *
 * - already has a scheme → used as-is;
 * - looks like a bare host (`example.com`, `localhost:3000/x`) → prefixed with
 *   `https://`;
 * - anything else → treated as a web search query.
 *
 * Returns an empty string for blank input so callers can skip navigation.
 */
export const normalizeUrl = (input: string): string => {
  const trimmed = input.trim();
  if (trimmed.length === 0) return '';
  if (HAS_SCHEME.test(trimmed)) return trimmed;
  if (trimmed.startsWith('localhost') || LOOKS_LIKE_HOST.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
};

/**
 * Tab the Browser page should activate the next time it mounts.
 *
 * Set by the Quick Active dock (which lives on other pages) right before it
 * navigates to `/settings/browser`, then consumed once by {@link useBrowserState}
 * on mount. Tabs are ephemeral, Main-process-owned views, so this is a plain
 * in-memory hand-off rather than persisted storage.
 */
let requestedActiveTabId: string | null = null;

/** Ask the Browser page to focus `id` the next time it mounts. */
export const requestActiveTab = (id: string): void => {
  requestedActiveTabId = id;
};

/** Read and clear the pending active-tab request (returns `null` when none). */
export const consumeRequestedActiveTab = (): string | null => {
  const id = requestedActiveTabId;
  requestedActiveTabId = null;
  return id;
};

/**
 * Whether the Browser page should open its AI chat dock on the next mount.
 *
 * Set when a URL is opened from OUTSIDE the app (deep link / default-browser
 * hand-off) so the web page lands with the AI panel ready — that surface has no
 * other obvious entry point to ask the AI. Consumed once by `BrowserPage`.
 */
let requestedChatOpen = false;

/** Ask the Browser page to open the AI chat dock the next time it mounts. */
export const requestChatOpen = (): void => {
  requestedChatOpen = true;
};

/** Read and clear the pending chat-open request (returns `false` when none). */
export const consumeRequestedChatOpen = (): boolean => {
  const value = requestedChatOpen;
  requestedChatOpen = false;
  return value;
};

/** Read the remembered web-agent model from `localStorage` (best-effort). */
export const loadAgentModel = (): string | null => {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(AGENT_MODEL_STORAGE_KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
};

/** Persist (or clear) the remembered web-agent model (best-effort). */
export const saveAgentModel = (model: string | null): void => {
  if (typeof window === 'undefined') return;
  try {
    if (model && model.length > 0) {
      window.localStorage.setItem(AGENT_MODEL_STORAGE_KEY, model);
    } else {
      window.localStorage.removeItem(AGENT_MODEL_STORAGE_KEY);
    }
  } catch {
    // Ignore storage failures (private mode / quota) — the choice is non-critical.
  }
};

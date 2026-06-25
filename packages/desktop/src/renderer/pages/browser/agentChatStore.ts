/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Module-level web-agent chat store (Requirement 1, criterion 1.2 — run
 * survives leaving the Browser page).
 *
 * ## Why this exists
 *
 * The web-agent runner lives in the **Main process** and keeps running a turn
 * even when the renderer leaves the Browser page. Previously the transcript and
 * the "is a turn running" flag lived inside the `useAgentChat` React hook, so
 * navigating away (which unmounts the Browser page) tore down the
 * `onAgentEvent` subscription and dropped every transcript — the agent kept
 * working in the background but its narration/answers were lost and the chat
 * looked empty on return. The user's complaint: "the browser app only lives in
 * its own tab; switching tabs makes it stop working."
 *
 * The fix mirrors the Company "run survival" pattern: keep the transcripts and
 * the run state in a singleton that lives **outside** React, subscribe to the
 * Main → renderer `agentEvent` stream **once, always-on** (so events are
 * captured even while the Browser page is unmounted), and mirror a snapshot to
 * `sessionStorage` so a hard reload can restore the transcript too. React
 * components subscribe to the store and re-render on change.
 *
 * Renderer-only module: talks to the Main process exclusively via the typed
 * {@link browserClient}; no Node.js APIs.
 */

import { browserClient, type AgentEvent } from './browserBridgeClient';

/** A rendered chat entry in the agent panel transcript. */
export type ChatMessage =
  | { id: string; kind: 'user'; text: string }
  | { id: string; kind: 'assistant'; text: string }
  | { id: string; kind: 'step'; tool: string; summary: string; status: 'running' | 'ok' | 'fail' }
  | { id: string; kind: 'error'; text: string };

/** Per-tab transcripts plus the id of the tab whose turn is currently running. */
export type AgentChatState = {
  /** Transcript per tab id. */
  transcripts: Record<string, ChatMessage[]>;
  /** The tab whose agent turn is in flight, or null when idle. */
  runningTabId: string | null;
};

/** `sessionStorage` key under which the transcript snapshot is mirrored. */
const SESSION_KEY = 'aionui.browser.agentChat';

/** Generate a short unique id for a message. */
let counter = 0;
const nextId = (): string => `m${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Read the persisted transcript snapshot (best-effort; empty on any failure). */
const loadSnapshot = (): Record<string, ChatMessage[]> => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.sessionStorage.getItem(SESSION_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, ChatMessage[]>) : {};
  } catch {
    return {};
  }
};

/**
 * The web-agent chat store: a singleton that owns the transcripts and run state
 * outside React, captures the live agent-event stream always-on, and notifies
 * subscribed components on change.
 */
class AgentChatStore {
  // Transcripts restored from the last session so a reload keeps the history.
  // The running flag is intentionally NOT restored: a renderer-driven run does
  // not resume after a hard reload, so we start idle.
  private state: AgentChatState = { transcripts: loadSnapshot(), runningTabId: null };
  private readonly listeners = new Set<() => void>();
  private unsubscribeEvents: (() => void) | null = null;

  /** Subscribe a React component; returns an unsubscribe fn. Lazily wires the event stream. */
  subscribe = (listener: () => void): (() => void) => {
    this.ensureEventStream();
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Current immutable snapshot for `useSyncExternalStore`. */
  getState = (): AgentChatState => this.state;

  /**
   * Subscribe to the Main → renderer agent-event stream exactly once, for the
   * whole app lifetime. Because this is NOT tied to a React effect it keeps
   * capturing steps/answers while the Browser page is unmounted, so a turn
   * started before navigating away still lands in the transcript on return.
   */
  private ensureEventStream(): void {
    if (this.unsubscribeEvents) return;
    this.unsubscribeEvents = browserClient.onAgentEvent((event: AgentEvent) => this.applyEvent(event));
  }

  /** Route one streamed agent event into the matching tab's transcript. */
  private applyEvent(event: AgentEvent): void {
    const tabId = event.tabId;
    if (event.type === 'action') {
      this.append(tabId, { id: nextId(), kind: 'step', tool: event.tool, summary: event.summary, status: 'running' });
    } else if (event.type === 'observation') {
      this.finishLatestStep(tabId, event.ok, event.summary);
    } else if (event.type === 'final') {
      this.append(tabId, { id: nextId(), kind: 'assistant', text: event.text });
    } else if (event.type === 'error') {
      this.append(tabId, { id: nextId(), kind: 'error', text: event.message });
      if (this.state.runningTabId === tabId) this.setRunning(null);
    } else if (event.type === 'stopped') {
      if (this.state.runningTabId === tabId) this.setRunning(null);
    }
  }

  /** Mark the most recent running step for a tab as finished (ok/fail). */
  private finishLatestStep(tabId: string, ok: boolean, summary: string): void {
    const list = this.state.transcripts[tabId] ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if (m.kind === 'step' && m.status === 'running') {
        const updated = [...list];
        updated[i] = { ...m, status: ok ? 'ok' : 'fail', summary: summary || m.summary };
        this.commit({ ...this.state, transcripts: { ...this.state.transcripts, [tabId]: updated } });
        return;
      }
    }
  }

  /** Append a message to a tab's transcript and notify subscribers. */
  private append(tabId: string, message: ChatMessage): void {
    const list = this.state.transcripts[tabId] ?? [];
    this.commit({
      ...this.state,
      transcripts: { ...this.state.transcripts, [tabId]: [...list, message] },
    });
  }

  /** Set the running tab id (or null) and notify subscribers. */
  private setRunning(tabId: string | null): void {
    if (this.state.runningTabId === tabId) return;
    this.commit({ ...this.state, runningTabId: tabId });
  }

  /** Replace the state, mirror the transcript to sessionStorage, and notify. */
  private commit(next: AgentChatState): void {
    this.state = next;
    this.persist();
    for (const listener of this.listeners) listener();
  }

  /** Mirror the transcript snapshot to sessionStorage (best-effort). */
  private persist(): void {
    if (typeof window === 'undefined') return;
    try {
      window.sessionStorage.setItem(SESSION_KEY, JSON.stringify(this.state.transcripts));
    } catch {
      // Non-critical: a missing snapshot only means a reload starts empty.
    }
  }

  // -------------------------------------------------------------------------
  // Public actions (called by the useAgentChat hook)
  // -------------------------------------------------------------------------

  /**
   * Record a user instruction, mark the tab as running, and drive one agent
   * turn through the bridge. Resolves when the run ends (done/stopped/error).
   * The transcript is updated live by the always-on event stream; this only
   * seeds the user message and clears the running flag on completion.
   */
  async send(tabId: string, model: string, instruction: string, interactive: boolean): Promise<void> {
    const trimmed = instruction.trim();
    if (trimmed.length === 0) return;

    // Make sure the always-on event stream is wired before the turn starts, so
    // the live narration lands in the transcript even if no component is
    // currently subscribed (e.g. the run was kicked off then the page left).
    this.ensureEventStream();

    // Build model history from prior user/assistant turns (steps are UI-only).
    const prior = (this.state.transcripts[tabId] ?? [])
      .filter(
        (m): m is Extract<ChatMessage, { kind: 'user' | 'assistant' }> => m.kind === 'user' || m.kind === 'assistant'
      )
      .map((m) => ({ role: m.kind, content: m.text }));

    this.append(tabId, { id: nextId(), kind: 'user', text: trimmed });
    this.setRunning(tabId);
    try {
      await browserClient.runAgent({ id: tabId, model, instruction: trimmed, history: prior, interactive });
    } catch (error) {
      this.append(tabId, { id: nextId(), kind: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      if (this.state.runningTabId === tabId) this.setRunning(null);
    }
  }

  /** Cancel the in-flight turn for a tab (best-effort, cooperative). */
  stop(tabId: string): void {
    void browserClient.cancelAgent({ id: tabId }).catch(() => {});
  }

  /** Clear a tab's transcript. */
  clear(tabId: string): void {
    if (!this.state.transcripts[tabId]) return;
    const next = { ...this.state.transcripts };
    delete next[tabId];
    this.commit({ ...this.state, transcripts: next });
  }
}

/** The app-wide web-agent chat store singleton. */
export const agentChatStore = new AgentChatStore();

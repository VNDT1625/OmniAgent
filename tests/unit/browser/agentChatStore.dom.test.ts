/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for the module-level web-agent chat store (Requirement 1, criterion
 * 1.2 — a running web-agent turn survives leaving the Browser page).
 *
 * The store is the fix for "the browser app only lives in its own tab": it
 * subscribes to the Main → renderer agent-event stream ONCE, always-on, so a
 * turn started before the user navigates away keeps landing in the transcript,
 * and mirrors the transcript to sessionStorage so a reload restores it.
 *
 * `browserBridgeClient` is mocked so the store runs without IPC; the test
 * captures the registered `onAgentEvent` listener and drives events through it
 * to simulate the Main-process runner working while no React component is
 * mounted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@/renderer/pages/browser/browserBridgeClient';

// Capture the always-on agent-event listener the store registers on first use.
let eventListener: ((event: AgentEvent) => void) | null = null;
const runAgent = vi.fn();
const cancelAgent = vi.fn();

vi.mock('@/renderer/pages/browser/browserBridgeClient', () => ({
  browserClient: {
    onAgentEvent: (listener: (event: AgentEvent) => void) => {
      eventListener = listener;
      return () => {
        eventListener = null;
      };
    },
    runAgent: (req: unknown) => runAgent(req),
    cancelAgent: (req: unknown) => cancelAgent(req),
  },
}));

import { agentChatStore } from '@/renderer/pages/browser/agentChatStore';

/** Push an event through the captured always-on listener. */
const emit = (event: AgentEvent): void => {
  expect(eventListener).toBeTruthy();
  eventListener?.(event);
};

const TAB = 'tab-1';

describe('agentChatStore — run survives leaving the Browser page', () => {
  beforeEach(() => {
    runAgent.mockReset();
    cancelAgent.mockReset();
    window.sessionStorage.clear();
    // Wire the event stream (mirrors what useAgentChat's useSyncExternalStore does).
    agentChatStore.subscribe(() => {});
    agentChatStore.clear(TAB);
  });

  afterEach(() => {
    agentChatStore.clear(TAB);
  });

  it('captures agent events even when no React component is subscribed', () => {
    // Simulate the page being unmounted: a turn started, then the user left.
    // Events still arrive from the Main process and must update the store.
    emit({ type: 'action', tabId: TAB, tool: 'navigate', summary: 'navigate(facebook.com)' });
    emit({ type: 'observation', tabId: TAB, tool: 'navigate', ok: true, summary: 'loaded' });
    emit({ type: 'final', tabId: TAB, text: 'Done — you have 2 unread messages.' });

    const messages = agentChatStore.getState().transcripts[TAB] ?? [];
    expect(messages).toHaveLength(2); // one step + one assistant answer
    expect(messages[0]).toMatchObject({ kind: 'step', status: 'ok' });
    expect(messages[1]).toMatchObject({ kind: 'assistant', text: 'Done — you have 2 unread messages.' });
  });

  it('seeds the user message and marks the tab running while a turn is in flight', async () => {
    let resolveRun: () => void = () => {};
    runAgent.mockImplementation(() => new Promise<void>((resolve) => (resolveRun = () => resolve())));

    const pending = agentChatStore.send(TAB, 'kr/claude', 'open facebook', false);
    // Synchronously after send(): user message recorded + tab marked running.
    expect(agentChatStore.getState().runningTabId).toBe(TAB);
    const seeded = agentChatStore.getState().transcripts[TAB] ?? [];
    expect(seeded[0]).toMatchObject({ kind: 'user', text: 'open facebook' });
    expect(runAgent).toHaveBeenCalledWith(expect.objectContaining({ id: TAB, model: 'kr/claude', interactive: false }));

    resolveRun();
    await pending;
    expect(agentChatStore.getState().runningTabId).toBeNull();
  });

  it('clears the running flag when an error or stopped event arrives', () => {
    runAgent.mockImplementation(() => new Promise<void>(() => {})); // never resolves
    void agentChatStore.send(TAB, 'kr/claude', 'do something', true);
    expect(agentChatStore.getState().runningTabId).toBe(TAB);

    emit({ type: 'stopped', tabId: TAB });
    expect(agentChatStore.getState().runningTabId).toBeNull();
  });

  it('mirrors the transcript to sessionStorage so a reload can restore it', () => {
    emit({ type: 'final', tabId: TAB, text: 'persisted answer' });
    const raw = window.sessionStorage.getItem('aionui.browser.agentChat');
    expect(raw).toBeTruthy();
    const parsed = JSON.parse(raw as string) as Record<string, unknown[]>;
    expect(parsed[TAB]).toHaveLength(1);
  });
});

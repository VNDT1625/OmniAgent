/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit + property tests for process/manager/managerAi.
 *
 * Covers:
 * - parseTasks / parseSchedule / parseScheduleImage parse the model's JSON and
 *   apply the right default lock kind (image → fixed, prompt → flexible).
 * - parseScheduleImage sends a multimodal user turn (text + image_url).
 * - Property 1: optimizeSchedule never moves a FIXED event; only flexible ones.
 * - Property 4: AI helpers return proposals and never call store mutators (they
 *   have no store reference — verified structurally by the lease/chat mocks).
 * - Property 6: each heavy call takes exactly one lease and releases it (even on
 *   error).
 */

import { describe, expect, it, vi } from 'vitest';
import type { AgentChat, ChatMessageInput } from '@/process/browser/webAgentRunner';
import type { IResourceCoordinator } from '@/process/resource/resourceCoordinator';
import type { Lease } from '@/process/resource/leaseTypes';
import { createManagerAi, extractJson } from '@/process/manager/managerAi';
import type { CalendarEvent } from '@/process/manager/managerTypes';

/** A coordinator stub that records lease request/release calls. */
const createLeaseSpy = () => {
  let granted = 0;
  let released = 0;
  const coordinator = {
    requestLease: vi.fn(async (): Promise<Lease> => {
      granted += 1;
      return { id: `lease-${granted}`, kind: 'agent', grantedAt: 0, estCostMB: 64 };
    }),
    releaseLease: vi.fn((_id: string) => {
      released += 1;
    }),
  } as unknown as IResourceCoordinator;
  return {
    coordinator,
    get granted() {
      return granted;
    },
    get released() {
      return released;
    },
  };
};

/** Build a chat stub that returns the given reply, capturing the last messages. */
const chatReturning = (reply: string) => {
  const calls: ChatMessageInput[][] = [];
  const chat: AgentChat = async ({ messages }) => {
    calls.push(messages);
    return reply;
  };
  return { chat, calls };
};

const NOW = 1_700_000_000_000;

describe('extractJson', () => {
  it('parses a bare JSON array', () => {
    expect(extractJson<number[]>('[1,2,3]')).toEqual([1, 2, 3]);
  });
  it('parses a fenced json block with surrounding prose', () => {
    const reply = 'Here you go:\n```json\n[{"title":"A"}]\n```\nHope that helps!';
    expect(extractJson<Array<{ title: string }>>(reply)).toEqual([{ title: 'A' }]);
  });
  it('throws on non-JSON', () => {
    expect(() => extractJson('no json here')).toThrow();
  });
});

describe('managerAi.parseTasks', () => {
  it('parses task proposals and drops empty titles', async () => {
    const spy = createLeaseSpy();
    const { chat } = chatReturning('[{"title":"Write report","priority":"high"},{"title":"  "}]');
    const ai = createManagerAi({ chat, model: 'm', coordinator: spy.coordinator, now: () => NOW });

    const tasks = await ai.parseTasks('I need to write the report');
    expect(tasks).toHaveLength(1);
    expect(tasks[0].title).toBe('Write report');
    // Property 6: one lease taken + released.
    expect(spy.granted).toBe(1);
    expect(spy.released).toBe(1);
  });

  it('releases the lease even when the model returns bad JSON (Property 6)', async () => {
    const spy = createLeaseSpy();
    const { chat } = chatReturning('totally not json');
    const ai = createManagerAi({ chat, model: 'm', coordinator: spy.coordinator, now: () => NOW });

    await expect(ai.parseTasks('x')).rejects.toThrow();
    expect(spy.granted).toBe(1);
    expect(spy.released).toBe(1);
  });
});

describe('managerAi.parseSchedule / parseScheduleImage', () => {
  it('defaults prompt events to flexible', async () => {
    const spy = createLeaseSpy();
    const { chat } = chatReturning('[{"title":"Gym","startAt":1,"endAt":2}]');
    const ai = createManagerAi({ chat, model: 'm', coordinator: spy.coordinator, now: () => NOW });

    const events = await ai.parseSchedule('gym tomorrow');
    expect(events[0].lockKind).toBe('flexible');
  });

  it('defaults image events to fixed and sends a multimodal turn', async () => {
    const spy = createLeaseSpy();
    const { chat, calls } = chatReturning('[{"title":"Math","startAt":1,"endAt":2}]');
    const ai = createManagerAi({ chat, model: 'm', coordinator: spy.coordinator, now: () => NOW });

    const events = await ai.parseScheduleImage('data:image/png;base64,AAAA');
    expect(events[0].lockKind).toBe('fixed');

    // The user turn carries an image_url part (multimodal).
    const userTurn = calls[0].find((m) => m.role === 'user');
    expect(Array.isArray(userTurn?.content)).toBe(true);
    const parts = userTurn?.content as Array<{ type: string }>;
    expect(parts.some((p) => p.type === 'image_url')).toBe(true);
  });
});

describe('managerAi.optimizeSchedule — Property 1 (fixed events immutable)', () => {
  const mkEvent = (over: Partial<CalendarEvent>): CalendarEvent => ({
    id: 'e',
    title: 't',
    startAt: 0,
    endAt: 1000,
    lockKind: 'flexible',
    source: 'manual',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  });

  it('keeps fixed events byte-for-byte even if the model tries to move them', async () => {
    const spy = createLeaseSpy();
    const fixed = mkEvent({ id: 'fixed-1', lockKind: 'fixed', startAt: 9 * 3600_000, endAt: 10 * 3600_000 });
    const flex = mkEvent({ id: 'flex-1', lockKind: 'flexible', startAt: 11 * 3600_000, endAt: 12 * 3600_000 });

    // Malicious model: tries to move BOTH events.
    const reply = JSON.stringify({
      proposed: [
        { id: 'fixed-1', startAt: 0, endAt: 1 },
        { id: 'flex-1', startAt: 14 * 3600_000, endAt: 15 * 3600_000 },
      ],
      rationale: ['moved things'],
    });
    const { chat } = chatReturning(reply);
    const ai = createManagerAi({ chat, model: 'm', coordinator: spy.coordinator, now: () => NOW });

    const result = await ai.optimizeSchedule({ events: [fixed, flex], tasks: [] });

    const outFixed = result.proposed.find((e) => e.id === 'fixed-1')!;
    const outFlex = result.proposed.find((e) => e.id === 'flex-1')!;
    // Fixed unchanged.
    expect(outFixed.startAt).toBe(9 * 3600_000);
    expect(outFixed.endAt).toBe(10 * 3600_000);
    // Flexible took the model's new time.
    expect(outFlex.startAt).toBe(14 * 3600_000);
    expect(outFlex.source).toBe('optimizer');
    expect(spy.released).toBe(1);
  });

  it('falls back to the original flexible event when the model output is invalid', async () => {
    const spy = createLeaseSpy();
    const flex = mkEvent({ id: 'flex-1', startAt: 100, endAt: 200 });
    // endAt <= startAt → invalid, keep original.
    const { chat } = chatReturning(
      JSON.stringify({ proposed: [{ id: 'flex-1', startAt: 500, endAt: 400 }], rationale: [] })
    );
    const ai = createManagerAi({ chat, model: 'm', coordinator: spy.coordinator, now: () => NOW });

    const result = await ai.optimizeSchedule({ events: [flex], tasks: [] });
    const out = result.proposed.find((e) => e.id === 'flex-1')!;
    expect(out.startAt).toBe(100);
    expect(out.endAt).toBe(200);
  });

  it('notes when weather was not used', async () => {
    const spy = createLeaseSpy();
    const { chat } = chatReturning(JSON.stringify({ proposed: [], rationale: [] }));
    const ai = createManagerAi({ chat, model: 'm', coordinator: spy.coordinator, now: () => NOW });
    const result = await ai.optimizeSchedule({ events: [], tasks: [], weather: null });
    expect(result.weatherUsed).toBe(false);
    expect(result.rationale.join(' ')).toMatch(/weather/i);
  });
});

describe('managerAi.researchTopic (Learn web research)', () => {
  it('uses injected web search + synthesizes a note with sources', async () => {
    const spy = createLeaseSpy();
    const { chat } = chatReturning(
      JSON.stringify({
        title: 'Spaced repetition',
        body: '# Summary\n- point',
        tags: ['study'],
        sources: [{ title: 'Wiki', url: 'https://en.wikipedia.org/x' }],
      })
    );
    const search = vi.fn(async () => [{ title: 'Wiki', url: 'https://en.wikipedia.org/x', snippet: 'about SR' }]);
    const ai = createManagerAi({ chat, model: 'm', coordinator: spy.coordinator, now: () => NOW, search });

    const res = await ai.researchTopic('spaced repetition');
    expect(search).toHaveBeenCalledWith('spaced repetition');
    expect(res.webUsed).toBe(true);
    expect(res.title).toBe('Spaced repetition');
    expect(res.sources[0].url).toBe('https://en.wikipedia.org/x');
    expect(spy.released).toBe(1);
  });

  it('degrades to model-only (webUsed false) and falls back to raw sources', async () => {
    const spy = createLeaseSpy();
    // Model omits sources → falls back to the (empty) search sources.
    const { chat } = chatReturning(JSON.stringify({ title: 'T', body: 'b', tags: [] }));
    const search = vi.fn(async () => []);
    const ai = createManagerAi({ chat, model: 'm', coordinator: spy.coordinator, now: () => NOW, search });

    const res = await ai.researchTopic('obscure topic');
    expect(res.webUsed).toBe(false);
    expect(res.sources).toEqual([]);
  });
});

describe('managerAi.summarizeDocument (Data smart management)', () => {
  it('returns a summary + tags', async () => {
    const spy = createLeaseSpy();
    const { chat } = chatReturning(JSON.stringify({ summary: 'A short summary', tags: ['pdf', 'math'] }));
    const ai = createManagerAi({ chat, model: 'm', coordinator: spy.coordinator, now: () => NOW });
    const res = await ai.summarizeDocument({ title: 'Calculus notes', url: 'https://x/y.pdf' });
    expect(res.summary).toBe('A short summary');
    expect(res.tags).toContain('math');
    expect(spy.released).toBe(1);
  });
});

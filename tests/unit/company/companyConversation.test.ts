/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/company/companyConversation — the in-process boss ↔
 * employee dialogue engine (Requirement 3 "Phần 2").
 *
 * Covers: the President delegates one directive per direct report and collects
 * their replies; the status board streams per-participant activity; an employee
 * `request_permission` pauses its branch until the boss resolves it (boss
 * authority); approval vs denial drive different follow-ups; cancellation winds
 * the run down without hanging; and every heavy turn goes through the injected
 * lease coordinator (one release per request).
 */

import { describe, expect, it } from 'vitest';
import type { CompanyStructure, RoleNode } from '@/process/company/companyOrchestrator';
import {
  createCompanyConversation,
  type CompanyChat,
  type ConversationEvent,
  type ConversationLease,
} from '@/process/company/companyConversation';

// --- Builders --------------------------------------------------------------

/** Build a 1-president + N-report structure. */
const makeStructure = (reportNames: string[]): CompanyStructure => {
  const children: RoleNode[] = reportNames.map((name, i) => ({
    id: `co:head:${i}`,
    role: 'division-head',
    name,
    divisionId: `d${i}`,
    responsibilities: `Lead ${name}`,
    children: [],
  }));
  return {
    companyId: 'co',
    root: { id: 'co:president', role: 'president', name: 'President', children },
  };
};

/** A scripted chat: maps by call index, with a default fallback. */
const scriptedChat = (replies: string[], fallback = 'ok'): { chat: CompanyChat; calls: () => number } => {
  let n = 0;
  const chat: CompanyChat = async () => {
    const reply = replies[n] ?? fallback;
    n += 1;
    return reply;
  };
  return { chat, calls: () => n };
};

/** A lease coordinator that counts requests/releases. */
const countingLease = (): ConversationLease & { requested: () => number; released: () => number } => {
  let requested = 0;
  let released = 0;
  let id = 0;
  return {
    requestLease: async () => {
      requested += 1;
      return { id: `lease-${++id}` };
    },
    releaseLease: () => {
      released += 1;
    },
    requested: () => requested,
    released: () => released,
  };
};

/** Collect every streamed event. */
const collector = (): { sink: (e: ConversationEvent) => void; events: ConversationEvent[] } => {
  const events: ConversationEvent[] = [];
  return { sink: (e) => events.push(e), events };
};

const runRequest = (structure: CompanyStructure, goal = 'Ship the thing') => ({
  structure,
  companyName: 'co',
  rules: ['Always review plans'],
  goal,
});

// --- Tests -----------------------------------------------------------------

describe('companyConversation — delegation + transcript', () => {
  it('delegates one directive per report and collects replies, then summarises', async () => {
    const { chat } = scriptedChat([
      'Alice: build UI\nBob: build API', // president directives
      'I will build the UI.', // Alice reply
      'I will build the API.', // Bob reply
      'The team will deliver UI + API.', // president summary
    ]);
    const engine = createCompanyConversation({ chat });
    const { sink, events } = collector();

    await engine.run(runRequest(makeStructure(['Alice', 'Bob'])), sink);

    const directives = events.filter((e) => e.type === 'message' && e.message.kind === 'directive');
    const reports = events.filter((e) => e.type === 'message' && e.message.kind === 'report');
    expect(directives).toHaveLength(2);
    expect(reports).toHaveLength(2);

    const finished = events.find((e) => e.type === 'run-finished');
    expect(finished && finished.type === 'run-finished' && finished.status).toBe('done');
    expect(finished && finished.type === 'run-finished' && finished.summary).toContain('UI + API');
  });

  it('streams a run-started roster and per-participant status updates (the board)', async () => {
    const { chat } = scriptedChat(['Alice: do it', 'done', 'summary']);
    const engine = createCompanyConversation({ chat });
    const { sink, events } = collector();

    await engine.run(runRequest(makeStructure(['Alice'])), sink);

    const started = events.find((e) => e.type === 'run-started');
    expect(started && started.type === 'run-started' && started.participants.map((p) => p.id)).toEqual([
      'co:president',
      'co:head:0',
    ]);

    // Every participant ends in a terminal 'done' status on the board.
    const lastStatus = new Map<string, string>();
    for (const e of events) if (e.type === 'status') lastStatus.set(e.status.id, e.status.activity);
    expect(lastStatus.get('co:president')).toBe('done');
    expect(lastStatus.get('co:head:0')).toBe('done');
  });

  it('answers the goal directly when the company has no reports', async () => {
    const { chat } = scriptedChat(['Here is the answer.']);
    const engine = createCompanyConversation({ chat });
    const { sink, events } = collector();

    await engine.run(runRequest(makeStructure([])), sink);

    const finished = events.find((e) => e.type === 'run-finished');
    expect(finished && finished.type === 'run-finished' && finished.summary).toBe('Here is the answer.');
  });
});

describe('companyConversation — permission gate (boss authority)', () => {
  it('pauses the branch on request_permission and resumes only after the boss approves', async () => {
    const { chat } = scriptedChat([
      'Alice: deploy', // directive
      '```json\n{"action":"request_permission","what":"deploy to prod","reason":"release"}\n```', // Alice asks
      'Deployed successfully.', // Alice follow-up after approval
      'All done.', // summary
    ]);
    const engine = createCompanyConversation({ chat });
    const { sink, events } = collector();

    const runPromise = engine.run(runRequest(makeStructure(['Alice'])), sink);

    // Wait for the permission event to appear (the branch is now paused).
    await viFlush();
    const permEvent = events.find((e) => e.type === 'permission');
    expect(permEvent && permEvent.type === 'permission').toBe(true);
    if (permEvent && permEvent.type === 'permission') {
      expect(permEvent.request.action).toBe('deploy to prod');
      const resolved = engine.resolvePermission({ requestId: permEvent.request.id, approved: true });
      expect(resolved).toBe(true);
    }

    await runPromise;

    const resolvedEvent = events.find((e) => e.type === 'permission-resolved');
    expect(resolvedEvent && resolvedEvent.type === 'permission-resolved' && resolvedEvent.decision.approved).toBe(true);
    const reports = events.filter((e) => e.type === 'message' && e.message.kind === 'report');
    expect(reports.some((r) => r.type === 'message' && r.message.content.includes('Deployed'))).toBe(true);
  });

  it('records a denial without running the sensitive follow-up', async () => {
    const { chat } = scriptedChat([
      'Alice: deploy',
      '```json\n{"action":"request_permission","what":"wipe the database"}\n```',
      'summary',
    ]);
    const engine = createCompanyConversation({ chat });
    const { sink, events } = collector();

    const runPromise = engine.run(runRequest(makeStructure(['Alice'])), sink);
    await viFlush();
    const permEvent = events.find((e) => e.type === 'permission');
    if (permEvent && permEvent.type === 'permission') {
      engine.resolvePermission({ requestId: permEvent.request.id, approved: false, note: 'too risky' });
    }
    await runPromise;

    const reports = events.filter((e) => e.type === 'message' && e.message.kind === 'report');
    expect(reports.some((r) => r.type === 'message' && /denied/i.test(r.message.content))).toBe(true);
  });

  it('resolvePermission returns false for an unknown request id', () => {
    const { chat } = scriptedChat([]);
    const engine = createCompanyConversation({ chat });
    expect(engine.resolvePermission({ requestId: 'nope', approved: true })).toBe(false);
  });
});

describe('companyConversation — leasing + cancellation', () => {
  it('leases every model turn and releases each one (balance)', async () => {
    const { chat } = scriptedChat(['Alice: go', 'done', 'summary']);
    const lease = countingLease();
    const engine = createCompanyConversation({ chat, coordinator: lease });
    const { sink } = collector();

    await engine.run(runRequest(makeStructure(['Alice'])), sink);

    expect(lease.requested()).toBeGreaterThan(0);
    expect(lease.released()).toBe(lease.requested());
  });

  it('cancel() unblocks a pending permission and ends the run as stopped', async () => {
    const { chat } = scriptedChat([
      'Alice: deploy',
      '```json\n{"action":"request_permission","what":"deploy"}\n```',
      'summary',
    ]);
    const engine = createCompanyConversation({ chat });
    const { sink, events } = collector();

    const runPromise = engine.run(runRequest(makeStructure(['Alice'])), sink);
    await viFlush();
    const started = events.find((e) => e.type === 'run-started');
    const runId = started && started.type === 'run-started' ? started.runId : '';
    engine.cancel(runId);
    await runPromise;

    const finished = events.find((e) => e.type === 'run-finished');
    expect(finished && finished.type === 'run-finished' && finished.status).toBe('stopped');
  });
});

/** Flush microtasks/timers so streamed events settle before assertions. */
const viFlush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

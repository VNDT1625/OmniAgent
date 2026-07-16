/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the Automation `action.company` connector. All company
 * collaborators are stubbed so the three modes (create / goal / tasks) are
 * exercised without Electron, the network, or a live model.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  createCompanyAction,
  type CompanyActionDeps,
  type CompanyRunEvent,
} from '@/process/automation/connectors/companyAction';

/** A structure with a President and two named reports. */
const fakeStructure = {
  root: {
    id: 'c1:president',
    name: 'President',
    children: [
      { id: 'c1:head:eng', name: 'Engineering Lead', children: [] },
      { id: 'c1:head:mkt', name: 'Marketing Lead', children: [] },
    ],
  },
};

/** Build deps with a conversation engine that finishes with `summary`. */
const makeDeps = (overrides: Partial<CompanyActionDeps> = {}): CompanyActionDeps => ({
  createCompany: vi.fn().mockResolvedValue('c-new'),
  loadCompany: vi.fn().mockResolvedValue({ companyId: 'c1', rules: ['be concise'] }),
  buildStructure: vi.fn().mockReturnValue(fakeStructure),
  getRules: vi.fn().mockResolvedValue(['be concise']),
  conversation: {
    run: vi.fn(async (_req, onEvent: (e: CompanyRunEvent) => void) => {
      onEvent({ type: 'run-finished', runId: 'r1', summary: 'All done.', status: 'done' });
      return 'r1';
    }),
    resolvePermission: vi.fn().mockReturnValue(true),
  },
  ...overrides,
});

describe('company action — create', () => {
  it('designs a company from the description and returns its id', async () => {
    const deps = makeDeps();
    const action = createCompanyAction(deps);
    const result = await action.run(
      { mode: 'create', description: 'A studio that makes {{input}} videos' },
      'cat',
      'Create'
    );
    expect(deps.createCompany).toHaveBeenCalledWith('A studio that makes cat videos', undefined);
    expect(result).toEqual({ mode: 'create', companyId: 'c-new', output: 'c-new' });
  });

  it('throws when no description is given', async () => {
    const action = createCompanyAction(makeDeps());
    await expect(action.run({ mode: 'create', description: '' }, null, 'Create')).rejects.toThrow(/description/i);
  });
});

describe('company action — goal', () => {
  it('runs the President toward a goal and returns the summary', async () => {
    const deps = makeDeps();
    const action = createCompanyAction(deps);
    const result = await action.run({ mode: 'goal', companyId: 'c1', goal: 'Launch {{input}}' }, 'the app', 'Goal');
    const runArgs = (deps.conversation.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(runArgs.goal).toBe('Launch the app');
    expect(runArgs.companyName).toBe('c1');
    expect(result).toEqual({ mode: 'goal', companyId: 'c1', output: 'All done.' });
  });

  it('throws when the company id is missing', async () => {
    const action = createCompanyAction(makeDeps());
    await expect(action.run({ mode: 'goal', companyId: '', goal: 'x' }, null, 'Goal')).rejects.toThrow(/company id/i);
  });

  it('auto-approves permission requests during the run', async () => {
    const deps = makeDeps({
      conversation: {
        run: vi.fn(async (_req, onEvent: (e: CompanyRunEvent) => void) => {
          onEvent({ type: 'permission', runId: 'r1', request: { id: 'perm-1' } });
          onEvent({ type: 'run-finished', runId: 'r1', summary: 'ok', status: 'done' });
          return 'r1';
        }),
        resolvePermission: vi.fn().mockReturnValue(true),
      },
    });
    const action = createCompanyAction(deps);
    await action.run({ mode: 'goal', companyId: 'c1', goal: 'do it', autoApprove: true }, null, 'Goal');
    expect(deps.conversation.resolvePermission).toHaveBeenCalledWith(
      expect.objectContaining({ requestId: 'perm-1', approved: true })
    );
  });

  it('surfaces a run-error as a thrown error', async () => {
    const deps = makeDeps({
      conversation: {
        run: vi.fn(async (_req, onEvent: (e: CompanyRunEvent) => void) => {
          onEvent({ type: 'run-error', runId: 'r1', message: 'model down' });
          return 'r1';
        }),
        resolvePermission: vi.fn().mockReturnValue(true),
      },
    });
    const action = createCompanyAction(deps);
    await expect(action.run({ mode: 'goal', companyId: 'c1', goal: 'x' }, null, 'Goal')).rejects.toThrow(/model down/);
  });
});

describe('company action — tasks', () => {
  it('routes the task to the chosen role by name', async () => {
    const deps = makeDeps();
    const action = createCompanyAction(deps);
    const result = await action.run(
      { mode: 'tasks', companyId: 'c1', roleId: 'c1:head:mkt', task: 'Write a launch post' },
      null,
      'Tasks'
    );
    const runArgs = (deps.conversation.run as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(runArgs.goal).toContain('Marketing Lead');
    expect(runArgs.goal).toContain('c1:head:mkt');
    expect(runArgs.goal).toContain('Write a launch post');
    expect(result.mode).toBe('tasks');
    expect(result.output).toBe('All done.');
  });

  it('throws when no role is chosen', async () => {
    const action = createCompanyAction(makeDeps());
    await expect(action.run({ mode: 'tasks', companyId: 'c1', roleId: '', task: 'x' }, null, 'Tasks')).rejects.toThrow(
      /role/i
    );
  });
});

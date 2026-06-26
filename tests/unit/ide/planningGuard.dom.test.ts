/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildPlanningGuard } from '@/renderer/pages/studio/ide/planningGuard';
import { ideClient } from '@/renderer/pages/studio/ide/ideClient';

vi.mock('@/renderer/pages/studio/ide/ideClient', () => ({
  ideClient: {
    specStatus: vi.fn(),
    specTaskList: vi.fn(),
    specTaskClaim: vi.fn(),
    gitStatus: vi.fn(),
    mtuiPolicyCheck: vi.fn(),
  },
}));

const mockedSpecStatus = vi.mocked(ideClient.specStatus);
const mockedSpecTaskList = vi.mocked(ideClient.specTaskList);
const mockedSpecTaskClaim = vi.mocked(ideClient.specTaskClaim);
const mockedGitStatus = vi.mocked(ideClient.gitStatus);
const mockedMtuiPolicyCheck = vi.mocked(ideClient.mtuiPolicyCheck);

describe('buildPlanningGuard', () => {
  beforeEach(() => {
    localStorage.clear();
    mockedSpecStatus.mockReset();
    mockedSpecTaskList.mockReset();
    mockedSpecTaskClaim.mockReset();
    mockedGitStatus.mockReset();
    mockedMtuiPolicyCheck.mockReset();
    // Default: spec status resolves to a non-existent spec so the /execute
    // lifecycle gate is a no-op unless a test overrides it.
    mockedSpecStatus.mockResolvedValue({ ok: false, error: 'no spec' });
    mockedGitStatus.mockResolvedValue({ ok: true, data: [] });
    mockedMtuiPolicyCheck.mockResolvedValue({
      ok: true,
      data: {
        strict: true,
        clean: true,
        changedCount: 0,
        baselineCount: 0,
        sessionBaselineCount: 0,
        autoSessionCreated: false,
        violationCount: 0,
        violationsTruncated: false,
        violations: [],
      },
    });
    mockedSpecTaskClaim.mockResolvedValue({
      ok: true,
      data: {
        rootPath: '/repo',
        slug: 'fix-login',
        specDir: '/repo/.aionui/specs/fix-login',
        activeTaskId: 't003-implement',
        nextTaskId: null,
        updatedAt: 11,
        counts: { total: 1, done: 0, pending: 0, inProgress: 1, blocked: 0 },
        tasks: [
          {
            id: 't003-implement',
            title: 'Implement',
            status: 'in_progress',
            sourceLine: 3,
            indent: 0,
            claimedBy: 'chat-agent',
            updatedAt: 11,
            note: null,
          },
        ],
      },
    });
  });

  it('bypasses planning and MTUI preflight for ordinary chat and sends the message untouched', async () => {
    const message = await buildPlanningGuard('/repo', 'fix login');
    expect(message).toBe('fix login');
    // The tool-preference rule is seeded into session memory once on tab open,
    // NOT appended to every message anymore.
    expect(message).not.toContain('prefer the provided mtui/IDE tools');
    expect(message).not.toContain('## Tool Guard');
    expect(message).not.toContain('## Plan Guard');
    expect(mockedSpecStatus).not.toHaveBeenCalled();
    expect(mockedSpecTaskList).not.toHaveBeenCalled();
    expect(mockedGitStatus).not.toHaveBeenCalled();
    expect(mockedMtuiPolicyCheck).not.toHaveBeenCalled();
  });

  it('blocks sending when changed files lack MTUI history', async () => {
    mockedGitStatus.mockResolvedValue({
      ok: true,
      data: [{ path: 'src/a.ts', status: 'M', staged: false }],
    });
    mockedMtuiPolicyCheck.mockResolvedValue({
      ok: true,
      data: {
        strict: true,
        clean: false,
        changedCount: 1,
        baselineCount: 0,
        sessionBaselineCount: 0,
        autoSessionCreated: false,
        violationCount: 1,
        violationsTruncated: false,
        violations: [{ path: 'src/a.ts', reason: 'Changed file has no recent MTUI write operation.' }],
      },
    });

    await expect(buildPlanningGuard('/repo', '/execute @.aionui/specs/fix-login/')).rejects.toThrow(
      'Strict MTUI Mode blocked this send'
    );
    expect(mockedMtuiPolicyCheck).toHaveBeenCalledWith('/repo', ['src/a.ts']);
  });

  it('reports total MTUI violations when policy output is truncated', async () => {
    mockedGitStatus.mockResolvedValue({
      ok: true,
      data: [
        { path: 'src/a.ts', status: 'M', staged: false },
        { path: 'src/b.ts', status: 'M', staged: false },
        { path: 'src/c.ts', status: 'M', staged: false },
      ],
    });
    mockedMtuiPolicyCheck.mockResolvedValue({
      ok: true,
      data: {
        strict: true,
        clean: false,
        changedCount: 10,
        baselineCount: 0,
        sessionBaselineCount: 0,
        autoSessionCreated: false,
        violationCount: 10,
        violationsTruncated: true,
        violations: [{ path: 'src/a.ts', reason: 'Changed file has no recent MTUI write operation.' }],
      },
    });

    await expect(buildPlanningGuard('/repo', '/execute @.aionui/specs/fix-login/')).rejects.toThrow(
      '10 unowned changed file(s): src/a.ts, and 9 more'
    );
  });

  it('checks spec lifecycle state without injecting plan prompt when Planning Mode is on', async () => {
    localStorage.setItem('studio.ide.planning./repo', '1');
    mockedSpecStatus.mockResolvedValue({
      ok: true,
      data: {
        rootPath: '/repo',
        exists: true,
        slug: 'fix-login',
        specDir: '/repo/.aionui/specs/fix-login',
        files: {
          'requirements.md': true,
          'design.md': true,
          'tasks.md': true,
          'verification.md': false,
        },
        taskCounts: {
          total: 3,
          done: 1,
          pending: 1,
          inProgress: 1,
          blocked: 0,
        },
        updatedAt: 10,
      },
    });
    mockedSpecTaskList.mockResolvedValue({
      ok: true,
      data: {
        rootPath: '/repo',
        slug: 'fix-login',
        specDir: '/repo/.aionui/specs/fix-login',
        activeTaskId: 't003-implement',
        nextTaskId: 't004-verify',
        updatedAt: 11,
        counts: {
          total: 4,
          done: 1,
          pending: 2,
          inProgress: 1,
          blocked: 0,
        },
        tasks: [
          {
            id: 't003-implement',
            title: 'Implement',
            status: 'in_progress',
            sourceLine: 3,
            indent: 0,
            claimedBy: 'agent',
            updatedAt: 11,
            note: null,
          },
          {
            id: 't004-verify',
            title: 'Verify',
            status: 'pending',
            sourceLine: 4,
            indent: 0,
            claimedBy: null,
            updatedAt: null,
            note: null,
          },
        ],
      },
    });

    const message = await buildPlanningGuard('/repo', 'fix login');
    expect(message).toBe('fix login');
    expect(message).not.toContain('prefer the provided mtui/IDE tools');
    expect(message).not.toContain('## Plan Guard');
    expect(mockedSpecStatus).not.toHaveBeenCalled();
    expect(mockedSpecTaskList).not.toHaveBeenCalled();
  });

  it('claims a backend task for /execute @<spec-folder> before sending to the agent', async () => {
    mockedSpecStatus.mockResolvedValue({
      ok: true,
      data: {
        rootPath: '/repo',
        exists: true,
        hasAnySpec: true,
        slug: 'fix-login',
        specDir: '/repo/.aionui/specs/fix-login',
        phase: 'execution',
        approvals: { requirements: true, design: true, tasks: true },
        files: {
          'requirements.md': true,
          'design.md': true,
          'tasks.md': true,
          'verification.md': false,
        },
        taskCounts: { total: 1, done: 0, pending: 0, inProgress: 1, blocked: 0 },
        updatedAt: 11,
      },
    });
    mockedSpecTaskClaim.mockResolvedValue({
      ok: true,
      data: {
        rootPath: '/repo',
        slug: 'fix-login',
        specDir: '/repo/.aionui/specs/fix-login',
        activeTaskId: 't003-implement',
        nextTaskId: null,
        updatedAt: 11,
        counts: {
          total: 1,
          done: 0,
          pending: 0,
          inProgress: 1,
          blocked: 0,
        },
        tasks: [
          {
            id: 't003-implement',
            title: 'Implement',
            status: 'in_progress',
            sourceLine: 3,
            indent: 0,
            claimedBy: 'chat-agent',
            updatedAt: 11,
            note: null,
          },
        ],
      },
    });

    const message = await buildPlanningGuard('/repo', '/execute @.aionui/specs/fix-login/ 1.1 focus UI');
    expect(mockedSpecTaskClaim).toHaveBeenCalledWith('/repo', 'fix-login', '1.1', 'chat-agent');
    expect(message).toBe('/execute @.aionui/specs/fix-login/ 1.1 focus UI');
    expect(message).not.toContain('prefer the provided mtui/IDE tools');
  });

  it('blocks /execute until lifecycle approvals reach execution', async () => {
    mockedSpecStatus.mockResolvedValue({
      ok: true,
      data: {
        rootPath: '/repo',
        exists: true,
        hasAnySpec: true,
        slug: 'fix-login',
        specDir: '/repo/.aionui/specs/fix-login',
        phase: 'tasks',
        approvals: { requirements: true, design: true, tasks: false },
        files: {
          'requirements.md': true,
          'design.md': true,
          'tasks.md': true,
          'verification.md': false,
        },
        taskCounts: { total: 1, done: 0, pending: 1, inProgress: 0, blocked: 0 },
        updatedAt: 11,
      },
    });

    await expect(buildPlanningGuard('/repo', '/execute @.aionui/specs/fix-login/')).rejects.toThrow(
      'Approve the requirements, design, and tasks gates before running /execute.'
    );
    expect(mockedSpecTaskClaim).not.toHaveBeenCalled();
  });
});

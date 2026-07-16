/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildSpecStatus,
  buildSpecTaskRunbook,
  buildSpecAnalysis,
  claimSpecTask,
  initSpecDirectory,
  listSpecDirectories,
  updateSpecTask,
  setActiveSpec,
} from '@/process/ide/specLifecycleBridge';

let rootPath = '';

beforeEach(async () => {
  rootPath = await mkdtemp(join(tmpdir(), 'aionui-spec-'));
});

afterEach(async () => {
  await rm(rootPath, { recursive: true, force: true });
});

describe('spec lifecycle bridge helpers', () => {
  it('reports no active spec when the specs directory is absent', async () => {
    const status = await buildSpecStatus(rootPath);
    expect(status.exists).toBe(false);
    expect(status.slug).toBeNull();
    expect(status.taskCounts.total).toBe(0);
  });

  it('initializes a Kiro-style spec directory with required files', async () => {
    const status = await initSpecDirectory(rootPath, 'Harness Planning Mode');
    expect(status.exists).toBe(true);
    expect(status.slug).toBe('harness-planning-mode');
    expect(status.files).toEqual({
      'requirements.md': true,
      'design.md': true,
      'tasks.md': true,
      'verification.md': true,
    });
    const temporaryStat = await stat(join(rootPath, '.omni', 'specs', status.slug as string, 'plan', 'temporary'));
    expect(temporaryStat.isDirectory()).toBe(true);
    expect(status.taskCounts.total).toBe(3);
  });

  it('counts task states from tasks.md', async () => {
    const initial = await initSpecDirectory(rootPath, 'Task States');
    await writeFile(
      join(rootPath, '.omni', 'specs', initial.slug as string, 'tasks.md'),
      ['# Tasks', '', '- [x] Done', '- [~] Running', '- [!] Blocked', '- [ ] Pending'].join('\n'),
      'utf-8'
    );
    const status = await buildSpecStatus(rootPath, initial.slug ?? undefined);
    expect(status.taskCounts).toEqual({
      total: 4,
      done: 1,
      inProgress: 1,
      blocked: 1,
      pending: 1,
    });
  });

  it('builds an authoritative task runbook from tasks.md', async () => {
    const initial = await initSpecDirectory(rootPath, 'Task Backend');
    const runbook = await buildSpecTaskRunbook(rootPath, initial.slug ?? undefined);
    expect(runbook.slug).toBe('task-backend');
    expect(runbook.tasks.map((task) => task.title)).toEqual([
      'Clarify requirements',
      'Implement changes',
      'Verify behavior',
    ]);
    expect(runbook.nextTaskId).toBe(runbook.tasks[0]?.id);
    expect(runbook.counts.pending).toBe(3);

    const state = await readFile(join(rootPath, '.omni', 'specs', initial.slug as string, 'task-state.json'), 'utf-8');
    expect(state).toContain('Clarify requirements');
  });

  it('builds a full spec analysis from requirements, tasks and verification', async () => {
    const initial = await initSpecDirectory(rootPath, 'Analyze Me');
    const slug = initial.slug as string;
    const specDir = join(rootPath, '.omni', 'specs', slug);
    await writeFile(
      join(specDir, 'requirements.md'),
      ['# Analyze Me Requirements', '', '## R1 Capture', '- WHEN x, THEN the system SHALL store it.'].join('\n'),
      'utf-8'
    );
    await writeFile(
      join(specDir, 'tasks.md'),
      ['# Tasks', '', '## Phase 1 — Build', '- [x] T1 — Implement capture (Req: R1)'].join('\n'),
      'utf-8'
    );
    await writeFile(join(specDir, 'verification.md'), '# Verification\n- R1 verified by tests.', 'utf-8');

    const analysis = await buildSpecAnalysis(rootPath, slug);
    expect(analysis.slug).toBe(slug);
    expect(analysis.requirements.counts.total).toBe(1);
    expect(analysis.traceability.counts.coveredRequirements).toBe(1);
    expect(analysis.traceability.counts.verifiedRequirements).toBe(1);
    expect(analysis.score).toBeGreaterThan(0);
  });

  it('lists spec folders for execute-plan UI', async () => {
    await initSpecDirectory(rootPath, 'First Plan');
    await initSpecDirectory(rootPath, 'Second Plan');

    const specs = await listSpecDirectories(rootPath);
    expect(specs.map((spec) => spec.slug)).toContain('first-plan');
    expect(specs.map((spec) => spec.slug)).toContain('second-plan');
    expect(specs[0]?.taskCounts.total).toBeGreaterThan(0);
  });

  it('claims the next backend task and syncs tasks.md marker', async () => {
    const initial = await initSpecDirectory(rootPath, 'Claim Task');
    const runbook = await claimSpecTask(rootPath, initial.slug ?? undefined, undefined, 'agent-1');
    const active = runbook.tasks.find((task) => task.id === runbook.activeTaskId);
    expect(active?.status).toBe('in_progress');
    expect(active?.claimedBy).toBe('agent-1');

    const tasksText = await readFile(join(rootPath, '.omni', 'specs', initial.slug as string, 'tasks.md'), 'utf-8');
    expect(tasksText).toContain('- [~] Clarify requirements');
  });

  it('claims a task by human selector from the task title', async () => {
    const initial = await initSpecDirectory(rootPath, 'Selector Task');
    await writeFile(
      join(rootPath, '.omni', 'specs', initial.slug as string, 'tasks.md'),
      ['# Tasks', '', '- [ ] 1.1 Build planner action', '- [ ] 1.2 Verify planner action'].join('\n'),
      'utf-8'
    );

    const runbook = await claimSpecTask(rootPath, initial.slug ?? undefined, '1.2', 'agent-1');
    const active = runbook.tasks.find((task) => task.id === runbook.activeTaskId);
    expect(active?.title).toBe('1.2 Verify planner action');
  });

  it('updates backend task status and records verification', async () => {
    const initial = await initSpecDirectory(rootPath, 'Update Task');
    await mkdir(join(rootPath, '.omni', 'understand'), { recursive: true });
    await writeFile(
      join(rootPath, '.omni', 'understand', 'stale.json'),
      JSON.stringify({ paths: ['src/a.ts', 'src/b.ts', 'src/a.ts'] }),
      'utf-8'
    );
    const claimed = await claimSpecTask(rootPath, initial.slug ?? undefined, undefined, 'agent-1');
    const activeId = claimed.activeTaskId as string;
    const runbook = await updateSpecTask({
      rootPath,
      slug: initial.slug ?? undefined,
      taskId: activeId,
      status: 'done',
      agentId: 'agent-1',
      note: 'implemented',
      verification: 'bun run test passed',
    });

    expect(runbook.tasks.find((task) => task.id === activeId)?.status).toBe('done');
    const tasksText = await readFile(join(rootPath, '.omni', 'specs', initial.slug as string, 'tasks.md'), 'utf-8');
    expect(tasksText).toContain('- [x] Clarify requirements');
    const verificationText = await readFile(
      join(rootPath, '.omni', 'specs', initial.slug as string, 'verification.md'),
      'utf-8'
    );
    expect(verificationText).toContain('bun run test passed');
    const refreshText = await readFile(
      join(rootPath, '.omni', 'specs', initial.slug as string, 'plan', 'semantic-refresh.json'),
      'utf-8'
    );
    const refresh = JSON.parse(refreshText) as { entries: Array<{ taskId: string; changedPaths: string[] }> };
    expect(refresh.entries.at(-1)).toMatchObject({
      taskId: activeId,
      changedPaths: ['src/a.ts', 'src/b.ts'],
    });
  });

  it('sets and clears the active spec', async () => {
    const initial = await initSpecDirectory(rootPath, 'Active Lifecycle');
    const slug = initial.slug as string;

    // Initially active when created via initSpecDirectory
    let status = await buildSpecStatus(rootPath);
    expect(status.exists).toBe(true);
    expect(status.slug).toBe(slug);

    // Clear active spec
    const cleared = await setActiveSpec(rootPath, null);
    expect(cleared.exists).toBe(false);
    expect(cleared.slug).toBeNull();

    // Verify it persists via status reload
    status = await buildSpecStatus(rootPath);
    expect(status.exists).toBe(false);
    expect(status.slug).toBeNull();

    // Set active again
    const reactivated = await setActiveSpec(rootPath, slug);
    expect(reactivated.exists).toBe(true);
    expect(reactivated.slug).toBe(slug);
  });
});

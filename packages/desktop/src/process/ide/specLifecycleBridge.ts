/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * IDE spec-lifecycle bridge — manages Kiro-style planning directories under
 * `.aionui/specs/<slug>/` so Planning Mode has observable state instead of
 * being only prompt text.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import { bridge } from '@office-ai/platform';
import { promises as fsp } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import { analyzeSpec } from '@/common/spec';
import type { SpecAnalysis } from '@/common/spec';

export const SPEC_CHANNELS = {
  status: 'ide.spec-status',
  init: 'ide.spec-init',
  read: 'ide.spec-read',
  write: 'ide.spec-write',
  list: 'ide.spec-list',
  taskList: 'ide.spec-task-list',
  taskClaim: 'ide.spec-task-claim',
  taskUpdate: 'ide.spec-task-update',
  analyze: 'ide.spec-analyze',
} as const;

export type SpecFileName = 'requirements.md' | 'design.md' | 'tasks.md' | 'verification.md';
export type SpecTaskStatus = 'pending' | 'in_progress' | 'done' | 'blocked';

export type SpecTaskCounts = {
  total: number;
  pending: number;
  inProgress: number;
  done: number;
  blocked: number;
};

export type SpecLifecycleStatus = {
  rootPath: string;
  exists: boolean;
  slug: string | null;
  specDir: string | null;
  files: Record<SpecFileName, boolean>;
  taskCounts: SpecTaskCounts;
  updatedAt: number | null;
};

export type SpecListEntry = {
  slug: string;
  specDir: string;
  updatedAt: number;
  taskCounts: SpecTaskCounts;
};

export type SpecStatusRequest = {
  rootPath: string;
};

export type SpecInitRequest = {
  rootPath: string;
  title: string;
};

export type SpecReadRequest = {
  rootPath: string;
  slug: string;
  file: SpecFileName;
};

export type SpecWriteRequest = SpecReadRequest & {
  content: string;
};

export type SpecTaskRecord = {
  id: string;
  title: string;
  status: SpecTaskStatus;
  sourceLine: number;
  indent: number;
  claimedBy: string | null;
  updatedAt: number | null;
  note: string | null;
};

export type SpecTaskRunbook = {
  rootPath: string;
  slug: string;
  specDir: string;
  tasks: SpecTaskRecord[];
  counts: SpecTaskCounts;
  activeTaskId: string | null;
  nextTaskId: string | null;
  updatedAt: number;
};

export type SpecTaskListRequest = {
  rootPath: string;
  slug?: string;
};

export type SpecTaskClaimRequest = SpecTaskListRequest & {
  agentId?: string;
  taskId?: string;
};

export type SpecTaskUpdateRequest = SpecTaskListRequest & {
  taskId: string;
  status: SpecTaskStatus;
  agentId?: string;
  note?: string;
  verification?: string;
};

/** Request to run the full pure spec analysis (EARS + traceability + gates). */
export type SpecAnalyzeRequest = SpecTaskListRequest;

export type SpecResult<T> = { ok: true; data: T } | { ok: false; error: string };

export const specChannels = {
  status: bridge.buildProvider<SpecResult<SpecLifecycleStatus>, SpecStatusRequest>(SPEC_CHANNELS.status),
  init: bridge.buildProvider<SpecResult<SpecLifecycleStatus>, SpecInitRequest>(SPEC_CHANNELS.init),
  read: bridge.buildProvider<SpecResult<string>, SpecReadRequest>(SPEC_CHANNELS.read),
  write: bridge.buildProvider<SpecResult<SpecLifecycleStatus>, SpecWriteRequest>(SPEC_CHANNELS.write),
  list: bridge.buildProvider<SpecResult<SpecListEntry[]>, SpecStatusRequest>(SPEC_CHANNELS.list),
  taskList: bridge.buildProvider<SpecResult<SpecTaskRunbook>, SpecTaskListRequest>(SPEC_CHANNELS.taskList),
  taskClaim: bridge.buildProvider<SpecResult<SpecTaskRunbook>, SpecTaskClaimRequest>(SPEC_CHANNELS.taskClaim),
  taskUpdate: bridge.buildProvider<SpecResult<SpecTaskRunbook>, SpecTaskUpdateRequest>(SPEC_CHANNELS.taskUpdate),
  analyze: bridge.buildProvider<SpecResult<SpecAnalysis>, SpecAnalyzeRequest>(SPEC_CHANNELS.analyze),
};

const SPEC_FILES: SpecFileName[] = ['requirements.md', 'design.md', 'tasks.md', 'verification.md'];
const TASK_STATE_FILE = 'task-state.json';
const SPEC_TEMPORARY_DIR = path.join('plan', 'temporary');
const SEMANTIC_REFRESH_FILE = path.join('plan', 'semantic-refresh.json');

const emptyTaskCounts = (): SpecTaskCounts => ({
  total: 0,
  pending: 0,
  inProgress: 0,
  done: 0,
  blocked: 0,
});

const specsRoot = (rootPath: string): string => path.join(rootPath, '.aionui', 'specs');

const slugify = (title: string): string => {
  const slug = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return slug.length > 0 ? slug : `spec-${Date.now()}`;
};

const safeSpecPath = (rootPath: string, slug: string, file?: SpecFileName): string => {
  const base = specsRoot(rootPath);
  const target = file ? path.join(base, slug, file) : path.join(base, slug);
  const relative = path.relative(base, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Spec path escapes the specs directory.');
  }
  return target;
};

const safeSpecInternalPath = (rootPath: string, slug: string, file: string): string => {
  const dir = safeSpecPath(rootPath, slug);
  const target = path.join(dir, file);
  const relative = path.relative(dir, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Spec internal path escapes the spec directory.');
  }
  return target;
};

const readTextIfExists = async (filePath: string): Promise<string | null> => {
  try {
    return await fsp.readFile(filePath, 'utf-8');
  } catch {
    return null;
  }
};

const normalizeRepoPath = (value: string): string => value.replace(/\\/g, '/').replace(/^\/+/, '').trim();

const readUnderstandStalePaths = async (rootPath: string): Promise<string[]> => {
  const markerPath = path.join(rootPath, '.aionui', 'understand', 'stale.json');
  const text = await readTextIfExists(markerPath);
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { paths?: unknown };
    if (!Array.isArray(parsed.paths)) return [];
    return Array.from(
      new Set(
        parsed.paths
          .filter((item): item is string => typeof item === 'string')
          .map(normalizeRepoPath)
          .filter((item) => item.length > 0)
      )
    ).toSorted();
  } catch {
    return [];
  }
};

const parseSemanticRefreshEntries = (text: string | null): unknown[] => {
  if (!text) return [];
  try {
    const parsed = JSON.parse(text) as { entries?: unknown };
    return Array.isArray(parsed.entries) ? parsed.entries : [];
  } catch {
    return [];
  }
};

const newestSpecSlug = async (rootPath: string): Promise<string | null> => {
  const root = specsRoot(rootPath);
  let entries: Array<{ name: string; mtimeMs: number }> = [];
  try {
    const dirents = await fsp.readdir(root, { withFileTypes: true });
    entries = await Promise.all(
      dirents
        .filter((entry) => entry.isDirectory())
        .map(async (entry) => {
          const stat = await fsp.stat(path.join(root, entry.name)).catch((): null => null);
          return { name: entry.name, mtimeMs: stat?.mtimeMs ?? 0 };
        })
    );
  } catch {
    return null;
  }
  entries.sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
  return entries[0]?.name ?? null;
};

export const listSpecDirectories = async (rootPath: string): Promise<SpecListEntry[]> => {
  const root = specsRoot(rootPath);
  const dirents = await fsp.readdir(root, { withFileTypes: true }).catch((): Dirent[] => []);
  const entries = await Promise.all(
    dirents
      .filter((entry) => entry.isDirectory())
      .map(async (entry): Promise<SpecListEntry> => {
        const slug = entry.name;
        const dir = safeSpecPath(rootPath, slug);
        const stats = await Promise.all(
          SPEC_FILES.map((file) => fsp.stat(path.join(dir, file)).catch((): null => null))
        );
        const updatedAt =
          stats.reduce<number | null>((latest, stat) => {
            if (!stat) return latest;
            return latest === null ? stat.mtimeMs : Math.max(latest, stat.mtimeMs);
          }, null) ?? 0;
        const tasksText = await readTextIfExists(path.join(dir, 'tasks.md'));
        return {
          slug,
          specDir: dir,
          updatedAt,
          taskCounts: parseTaskCounts(tasksText),
        };
      })
  );
  return entries.toSorted((a, b) => b.updatedAt - a.updatedAt || a.slug.localeCompare(b.slug));
};

const statusFromMarker = (marker: string): SpecTaskStatus => {
  if (marker === 'x' || marker === 'X') return 'done';
  if (marker === '~') return 'in_progress';
  if (marker === '!' || marker === '/') return 'blocked';
  return 'pending';
};

const markerFromStatus = (status: SpecTaskStatus): string => {
  if (status === 'done') return 'x';
  if (status === 'in_progress') return '~';
  if (status === 'blocked') return '!';
  return ' ';
};

const addTaskCount = (counts: SpecTaskCounts, status: SpecTaskStatus): void => {
  counts.total += 1;
  if (status === 'done') counts.done += 1;
  else if (status === 'in_progress') counts.inProgress += 1;
  else if (status === 'blocked') counts.blocked += 1;
  else counts.pending += 1;
};

const countsFromTasks = (tasks: readonly Pick<SpecTaskRecord, 'status'>[]): SpecTaskCounts => {
  const counts = emptyTaskCounts();
  for (const task of tasks) {
    addTaskCount(counts, task.status);
  }
  return counts;
};

const parseTaskCounts = (tasksText: string | null): SpecTaskCounts => {
  const counts = emptyTaskCounts();
  if (!tasksText) {
    return counts;
  }
  for (const line of tasksText.split(/\r?\n/)) {
    const match = line.match(/^\s*[-*]\s+\[([ xX~!/-])\]/);
    if (!match) {
      continue;
    }
    addTaskCount(counts, statusFromMarker(match[1]));
  }
  return counts;
};

const taskIdFor = (sourceLine: number, title: string): string => {
  const slug = title
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 36);
  return `t${String(sourceLine).padStart(3, '0')}${slug ? `-${slug}` : ''}`;
};

const parseTasks = (tasksText: string | null): SpecTaskRecord[] => {
  if (!tasksText) return [];
  return tasksText
    .split(/\r?\n/)
    .map((line, index): SpecTaskRecord | null => {
      const match = line.match(/^(\s*)[-*]\s+\[([ xX~!/-])\]\s+(.+?)\s*$/);
      if (!match) return null;
      const sourceLine = index + 1;
      const title = match[3].trim();
      return {
        id: taskIdFor(sourceLine, title),
        title,
        status: statusFromMarker(match[2]),
        sourceLine,
        indent: match[1].length,
        claimedBy: null,
        updatedAt: null,
        note: null,
      };
    })
    .filter((task): task is SpecTaskRecord => task !== null);
};

const readTaskState = async (rootPath: string, slug: string): Promise<Record<string, Partial<SpecTaskRecord>>> => {
  const stateText = await readTextIfExists(safeSpecInternalPath(rootPath, slug, TASK_STATE_FILE));
  if (!stateText) return {};
  try {
    const parsed = JSON.parse(stateText) as { tasks?: Array<Partial<SpecTaskRecord> & { id?: string }> };
    return Object.fromEntries((parsed.tasks ?? []).filter((task) => task.id).map((task) => [task.id as string, task]));
  } catch {
    return {};
  }
};

const writeTaskState = async (rootPath: string, slug: string, tasks: readonly SpecTaskRecord[]): Promise<void> => {
  const target = safeSpecInternalPath(rootPath, slug, TASK_STATE_FILE);
  await fsp.writeFile(
    target,
    JSON.stringify(
      {
        version: 1,
        updatedAt: Date.now(),
        tasks,
      },
      null,
      2
    ),
    'utf-8'
  );
};

const syncTasksMarkdown = async (rootPath: string, slug: string, tasks: readonly SpecTaskRecord[]): Promise<void> => {
  const target = safeSpecPath(rootPath, slug, 'tasks.md');
  const text = await readTextIfExists(target);
  if (text === null) return;
  const byLine = new Map(tasks.map((task) => [task.sourceLine, task.status] as const));
  const lines = text.split(/\r?\n/);
  const next = lines.map((line, index) => {
    const status = byLine.get(index + 1);
    if (!status) return line;
    return line.replace(/^(\s*[-*]\s+\[)[ xX~!/-](\])/, `$1${markerFromStatus(status)}$2`);
  });
  await fsp.writeFile(target, next.join('\n'), 'utf-8');
};

export const buildSpecTaskRunbook = async (rootPath: string, requestedSlug?: string): Promise<SpecTaskRunbook> => {
  const slug = requestedSlug ?? (await newestSpecSlug(rootPath));
  if (!slug) {
    throw new Error('No spec directory exists.');
  }
  const specDir = safeSpecPath(rootPath, slug);
  const parsedTasks = parseTasks(await readTextIfExists(path.join(specDir, 'tasks.md')));
  const state = await readTaskState(rootPath, slug);
  const now = Date.now();
  const tasks = parsedTasks.map((task) => {
    const saved = state[task.id];
    return {
      ...task,
      status: saved?.status ?? task.status,
      claimedBy: saved?.claimedBy ?? null,
      updatedAt: saved?.updatedAt ?? null,
      note: saved?.note ?? null,
    };
  });
  const activeTask = tasks.find((task) => task.status === 'in_progress') ?? null;
  const nextTask = tasks.find((task) => task.status === 'pending') ?? null;
  await writeTaskState(rootPath, slug, tasks);
  return {
    rootPath,
    slug,
    specDir,
    tasks,
    counts: countsFromTasks(tasks),
    activeTaskId: activeTask?.id ?? null,
    nextTaskId: nextTask?.id ?? null,
    updatedAt: now,
  };
};

export const claimSpecTask = async (
  rootPath: string,
  requestedSlug?: string,
  taskId?: string,
  agentId = 'agent'
): Promise<SpecTaskRunbook> => {
  const runbook = await buildSpecTaskRunbook(rootPath, requestedSlug);
  const selector = taskId?.trim().toLowerCase();
  const target = taskId
    ? runbook.tasks.find(
        (task) =>
          task.id.toLowerCase() === selector ||
          task.title.toLowerCase().startsWith(`${selector} `) ||
          task.title.toLowerCase() === selector
      )
    : (runbook.tasks.find((task) => task.status === 'in_progress') ??
      runbook.tasks.find((task) => task.status === 'pending'));
  if (!target) return runbook;
  target.status = 'in_progress';
  target.claimedBy = agentId;
  target.updatedAt = Date.now();
  await writeTaskState(rootPath, runbook.slug, runbook.tasks);
  await syncTasksMarkdown(rootPath, runbook.slug, runbook.tasks);
  return buildSpecTaskRunbook(rootPath, runbook.slug);
};

export const updateSpecTask = async (req: SpecTaskUpdateRequest): Promise<SpecTaskRunbook> => {
  const runbook = await buildSpecTaskRunbook(req.rootPath, req.slug);
  const target = runbook.tasks.find((task) => task.id === req.taskId);
  if (!target) {
    throw new Error(`Task not found: ${req.taskId}`);
  }
  target.status = req.status;
  target.claimedBy = req.agentId ?? target.claimedBy ?? 'agent';
  target.updatedAt = Date.now();
  target.note = req.note ?? target.note;
  await writeTaskState(req.rootPath, runbook.slug, runbook.tasks);
  await syncTasksMarkdown(req.rootPath, runbook.slug, runbook.tasks);
  if (req.verification?.trim()) {
    const verificationPath = safeSpecPath(req.rootPath, runbook.slug, 'verification.md');
    await fsp.appendFile(
      verificationPath,
      `\n## Task ${target.id}\n\n- Status: ${req.status}\n- Note: ${req.note ?? ''}\n- Verification: ${req.verification.trim()}\n`,
      'utf-8'
    );
  }
  if (req.status === 'done') {
    const refreshPath = safeSpecInternalPath(req.rootPath, runbook.slug, SEMANTIC_REFRESH_FILE);
    await fsp.mkdir(path.dirname(refreshPath), { recursive: true });
    const previousText = await readTextIfExists(refreshPath);
    const entries = parseSemanticRefreshEntries(previousText);
    entries.push({
      taskId: target.id,
      taskTitle: target.title,
      agentId: target.claimedBy,
      note: target.note,
      verification: req.verification?.trim() || null,
      changedPaths: await readUnderstandStalePaths(req.rootPath),
      createdAt: Date.now(),
      status: 'pending_semantic_refresh',
    });
    await fsp.writeFile(
      refreshPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          purpose: 'Scoped Understand semantic refresh requests created when spec tasks finish.',
          entries: entries.slice(-50),
        },
        null,
        2
      )}\n`,
      'utf-8'
    );
  }
  return buildSpecTaskRunbook(req.rootPath, runbook.slug);
};

export const buildSpecStatus = async (rootPath: string, requestedSlug?: string): Promise<SpecLifecycleStatus> => {
  const slug = requestedSlug ?? (await newestSpecSlug(rootPath));
  if (!slug) {
    return {
      rootPath,
      exists: false,
      slug: null,
      specDir: null,
      files: {
        'requirements.md': false,
        'design.md': false,
        'tasks.md': false,
        'verification.md': false,
      },
      taskCounts: emptyTaskCounts(),
      updatedAt: null,
    };
  }

  const dir = safeSpecPath(rootPath, slug);
  const files = Object.fromEntries(
    await Promise.all(
      SPEC_FILES.map(async (file) => {
        const stat = await fsp.stat(path.join(dir, file)).catch((): null => null);
        return [file, Boolean(stat?.isFile())] as const;
      })
    )
  ) as Record<SpecFileName, boolean>;
  const tasksText = await readTextIfExists(path.join(dir, 'tasks.md'));
  const stats = await Promise.all(SPEC_FILES.map((file) => fsp.stat(path.join(dir, file)).catch((): null => null)));
  const updatedAt = stats.reduce<number | null>((latest, stat) => {
    if (!stat) return latest;
    return latest === null ? stat.mtimeMs : Math.max(latest, stat.mtimeMs);
  }, null);

  return {
    rootPath,
    exists: true,
    slug,
    specDir: dir,
    files,
    taskCounts: parseTaskCounts(tasksText),
    updatedAt,
  };
};

const templateFor = (file: SpecFileName, title: string): string => {
  if (file === 'requirements.md') {
    return [
      `# ${title} Requirements`,
      '',
      '## Goal',
      '',
      '## User Stories',
      '',
      '## Acceptance Criteria',
      '',
      '## Non-Goals',
      '',
      '## Constraints',
      '',
    ].join('\n');
  }
  if (file === 'design.md') {
    return [
      '# Design',
      '',
      '## Architecture',
      '',
      '## Affected Files',
      '',
      '## Data and Control Flow',
      '',
      '## Risks',
      '',
    ].join('\n');
  }
  if (file === 'tasks.md') {
    return ['# Tasks', '', '- [ ] Clarify requirements', '- [ ] Implement changes', '- [ ] Verify behavior', ''].join(
      '\n'
    );
  }
  return ['# Verification', '', '## Automated Checks', '', '## Manual Checks', '', '## Gaps', ''].join('\n');
};

export const initSpecDirectory = async (rootPath: string, title: string): Promise<SpecLifecycleStatus> => {
  const slug = slugify(title);
  const dir = safeSpecPath(rootPath, slug);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.mkdir(path.join(dir, SPEC_TEMPORARY_DIR), { recursive: true });
  for (const file of SPEC_FILES) {
    const target = path.join(dir, file);
    const existing = await readTextIfExists(target);
    if (existing === null) {
      await fsp.writeFile(target, templateFor(file, title), 'utf-8');
    }
  }
  return buildSpecStatus(rootPath, slug);
};

/**
 * Run the full, pure spec analysis (EARS validation + Req↔Task↔Test
 * traceability + phase-gate / Definition-of-Done readiness) for one spec.
 */
export const buildSpecAnalysis = async (rootPath: string, requestedSlug?: string): Promise<SpecAnalysis> => {
  const slug = requestedSlug ?? (await newestSpecSlug(rootPath));
  if (!slug) {
    throw new Error('No spec directory exists.');
  }
  const dir = safeSpecPath(rootPath, slug);
  const [requirementsMarkdown, tasksMarkdown, verificationMarkdown] = await Promise.all([
    readTextIfExists(path.join(dir, 'requirements.md')),
    readTextIfExists(path.join(dir, 'tasks.md')),
    readTextIfExists(path.join(dir, 'verification.md')),
  ]);
  return analyzeSpec({
    slug,
    requirementsMarkdown: requirementsMarkdown ?? '',
    tasksMarkdown: tasksMarkdown ?? '',
    verificationMarkdown: verificationMarkdown ?? '',
  });
};

export function registerSpecLifecycleBridge(): void {
  specChannels.status.provider(async (req): Promise<SpecResult<SpecLifecycleStatus>> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath) return { ok: false, error: 'A folder path is required.' };
    try {
      return { ok: true, data: await buildSpecStatus(rootPath) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  specChannels.init.provider(async (req): Promise<SpecResult<SpecLifecycleStatus>> => {
    const rootPath = req.rootPath?.trim();
    const title = req.title?.trim();
    if (!rootPath) return { ok: false, error: 'A folder path is required.' };
    if (!title) return { ok: false, error: 'A spec title is required.' };
    try {
      return { ok: true, data: await initSpecDirectory(rootPath, title) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  specChannels.read.provider(async (req): Promise<SpecResult<string>> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath) return { ok: false, error: 'A folder path is required.' };
    try {
      return { ok: true, data: await fsp.readFile(safeSpecPath(rootPath, req.slug, req.file), 'utf-8') };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  specChannels.write.provider(async (req): Promise<SpecResult<SpecLifecycleStatus>> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath) return { ok: false, error: 'A folder path is required.' };
    try {
      const target = safeSpecPath(rootPath, req.slug, req.file);
      await fsp.mkdir(path.dirname(target), { recursive: true });
      await fsp.writeFile(target, req.content, 'utf-8');
      return { ok: true, data: await buildSpecStatus(rootPath, req.slug) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  specChannels.list.provider(async (req): Promise<SpecResult<SpecListEntry[]>> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath) return { ok: false, error: 'A folder path is required.' };
    try {
      return { ok: true, data: await listSpecDirectories(rootPath) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  specChannels.taskList.provider(async (req): Promise<SpecResult<SpecTaskRunbook>> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath) return { ok: false, error: 'A folder path is required.' };
    try {
      return { ok: true, data: await buildSpecTaskRunbook(rootPath, req.slug) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  specChannels.taskClaim.provider(async (req): Promise<SpecResult<SpecTaskRunbook>> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath) return { ok: false, error: 'A folder path is required.' };
    try {
      return { ok: true, data: await claimSpecTask(rootPath, req.slug, req.taskId, req.agentId) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  specChannels.taskUpdate.provider(async (req): Promise<SpecResult<SpecTaskRunbook>> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath) return { ok: false, error: 'A folder path is required.' };
    try {
      return { ok: true, data: await updateSpecTask({ ...req, rootPath }) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  specChannels.analyze.provider(async (req): Promise<SpecResult<SpecAnalysis>> => {
    const rootPath = req.rootPath?.trim();
    if (!rootPath) return { ok: false, error: 'A folder path is required.' };
    try {
      return { ok: true, data: await buildSpecAnalysis(rootPath, req.slug) };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}

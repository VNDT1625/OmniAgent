/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Strict MTUI policy helpers. Controlled IDE writes already route through MTUI;
 * this module detects and blocks the obvious remaining bypasses.
 */

import { relative } from 'node:path';
import { promises as fsp } from 'node:fs';
import { join } from 'node:path';
import { runMtuiInRoot } from './mtuiBridge';

export type MtuiPolicyViolation = {
  path: string;
  reason: string;
};

export type MtuiPolicyCheck = {
  strict: boolean;
  clean: boolean;
  changedCount: number;
  baselineCount: number;
  sessionBaselineCount: number;
  autoSessionCreated: boolean;
  violationCount: number;
  violationsTruncated: boolean;
  violations: MtuiPolicyViolation[];
};

type MtuiOperation = {
  file_path?: string | null;
  changed?: boolean;
};

type MtuiPolicyStatusResponse = {
  ok?: boolean;
  strict?: boolean;
  clean?: boolean;
  changed_count?: number;
  baseline_count?: number;
  session_baseline_count?: number;
  auto_session_created?: boolean;
  violation_count?: number;
  violations_truncated?: boolean;
  violations?: unknown;
};

type MtuiPolicyBaseline = {
  paths?: unknown;
};

const DIRECT_WRITE_PATTERNS: RegExp[] = [
  /\bSet-Content\b/i,
  /\bOut-File\b/i,
  /\bAdd-Content\b/i,
  />\s*[^&|]+/,
  />>\s*[^&|]+/,
  /\bpython(?:3)?\b[\s\S]*\bopen\s*\([\s\S]*['"][wa]\b/i,
  /\bnode\b[\s\S]*\bwriteFile(?:Sync)?\s*\(/i,
  /\brm\b\s+.*(?:-r|-rf|--recursive)/i,
  /\bdel\b\s+/i,
  /\bRemove-Item\b/i,
];

const IGNORED_POLICY_PATHS = [
  '.git/',
  '.mtui/',
  '.omni/understand/',
  '.aionui/understand/',
  'node_modules/',
  'dist/',
  'build/',
  'target/',
  'coverage/',
];

const normalizeRel = (value: string): string => value.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');

const isIgnoredPolicyPath = (relPath: string): boolean => {
  const normalized = normalizeRel(relPath);
  if (normalized.startsWith('.aionui/specs/') && normalized.includes('/plan/temporary/')) {
    return true;
  }
  if (normalized.startsWith('.kiro/tmp-')) {
    return true;
  }
  return IGNORED_POLICY_PATHS.some((prefix) => normalized === prefix.slice(0, -1) || normalized.startsWith(prefix));
};

export const isDirectWriteCommand = (command: string): boolean => {
  const trimmed = command.trim();
  if (!trimmed || trimmed.toLowerCase().startsWith('mtui ')) {
    return false;
  }
  return DIRECT_WRITE_PATTERNS.some((pattern) => pattern.test(trimmed));
};

export const commandFromTerminalInput = (data: string): string | null => {
  if (!/[\r\n]/.test(data)) {
    return null;
  }
  const line = data
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find((part) => part.length > 0);
  return line ?? null;
};

const operationsFromResponse = (response: Record<string, unknown>): MtuiOperation[] => {
  const raw = response.operations;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.filter((item): item is MtuiOperation => typeof item === 'object' && item !== null);
};

const operationRelPath = (rootPath: string, operation: MtuiOperation): string | null => {
  if (!operation.file_path || operation.changed === false) {
    return null;
  }
  const rel = relative(rootPath, operation.file_path);
  return normalizeRel(rel || operation.file_path);
};

const readPolicyPathsFile = async (rootPath: string, fileName: string): Promise<Set<string>> => {
  try {
    const text = await fsp.readFile(join(rootPath, '.mtui', fileName), 'utf-8');
    const parsed = JSON.parse(text.trimStart()) as MtuiPolicyBaseline;
    if (!Array.isArray(parsed.paths)) {
      return new Set();
    }
    return new Set(parsed.paths.filter((item): item is string => typeof item === 'string').map(normalizeRel));
  } catch {
    return new Set();
  }
};

const readPolicyBaseline = async (rootPath: string): Promise<Set<string>> => {
  const permanentPaths = await readPolicyPathsFile(rootPath, 'policy-baseline.json');
  const sessionPaths = await readPolicyPathsFile(rootPath, 'policy-session-baseline.json');
  return new Set([...permanentPaths, ...sessionPaths]);
};

export const detectMtuiViolations = (
  rootPath: string,
  changedPaths: readonly string[],
  operations: readonly MtuiOperation[],
  baselinePaths: ReadonlySet<string> = new Set()
): MtuiPolicyViolation[] => {
  const mtuiFiles = new Set(
    operations
      .map((operation) => operationRelPath(rootPath, operation))
      .filter((value): value is string => Boolean(value))
  );
  const violations: MtuiPolicyViolation[] = [];
  for (const rawPath of changedPaths) {
    const relPath = normalizeRel(rawPath);
    if (!relPath || isIgnoredPolicyPath(relPath)) {
      continue;
    }
    if (baselinePaths.has(relPath)) {
      continue;
    }
    if (!mtuiFiles.has(relPath)) {
      violations.push({
        path: relPath,
        reason: 'Changed file has no recent MTUI write operation.',
      });
    }
  }
  return violations;
};

export const MTUI_POLICY_OPERATION_LIMIT = 10_000;

export const checkMtuiPolicy = async (rootPath: string, changedPaths: readonly string[]): Promise<MtuiPolicyCheck> => {
  const status = await runMtuiInRoot(
    [
      '--json',
      'policy',
      'status',
      '--limit',
      String(MTUI_POLICY_OPERATION_LIMIT),
      '--violation-limit',
      '25',
      '--auto-session',
      '--owner',
      'app',
      '--note',
      'Auto baseline for pre-existing dirty files at chat send.',
    ],
    rootPath
  ).catch((): null => null);
  if (status?.ok) {
    const response = status as MtuiPolicyStatusResponse;
    const violations = Array.isArray(response.violations)
      ? response.violations.filter(
          (item): item is MtuiPolicyViolation =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as MtuiPolicyViolation).path === 'string' &&
            typeof (item as MtuiPolicyViolation).reason === 'string'
        )
      : [];
    return {
      strict: response.strict !== false,
      clean: response.clean === true,
      changedCount: response.changed_count ?? changedPaths.length,
      baselineCount: response.baseline_count ?? 0,
      sessionBaselineCount: response.session_baseline_count ?? 0,
      autoSessionCreated: response.auto_session_created === true,
      violationCount: response.violation_count ?? violations.length,
      violationsTruncated: response.violations_truncated === true,
      violations,
    };
  }

  const response = await runMtuiInRoot(
    ['--json', 'history', 'operations', '--limit', String(MTUI_POLICY_OPERATION_LIMIT)],
    rootPath
  );
  const operations = response.ok ? operationsFromResponse(response) : [];
  const baselinePaths = await readPolicyBaseline(rootPath);
  const violations = detectMtuiViolations(rootPath, changedPaths, operations, baselinePaths);
  return {
    strict: true,
    clean: violations.length === 0,
    changedCount: changedPaths.length,
    baselineCount: baselinePaths.size,
    sessionBaselineCount: 0,
    autoSessionCreated: false,
    violationCount: violations.length,
    violationsTruncated: false,
    violations,
  };
};

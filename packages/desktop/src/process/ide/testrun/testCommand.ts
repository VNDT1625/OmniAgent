/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure "run test at cursor" command builder. No `fs`, no spawning — given a
 * file's content, the cursor line, the file path, and the project's
 * package.json text, it figures out the test runner and the nearest enclosing
 * test name, then builds the shell command to run JUST that test. The UI sends
 * the command to an existing terminal session (no new runner infra needed).
 *
 * Deliberately minimal + heuristic: it supports the common JS/TS runners
 * (vitest / jest) and Python pytest, and falls back to "run the whole file".
 */

/** A detected test runner. */
export type TestRunner = 'vitest' | 'jest' | 'pytest' | 'unknown';

/** Detect the runner from package.json text (JS/TS) or the file extension (py). */
export const detectRunner = (packageJson: string | null, filePath: string): TestRunner => {
  if (/\.py$/i.test(filePath)) return 'pytest';
  if (packageJson) {
    // Look in dependencies/devDependencies/scripts for a runner name.
    if (/"vitest"\s*:/.test(packageJson) || /\bvitest\b/.test(packageJson)) return 'vitest';
    if (/"jest"\s*:/.test(packageJson) || /\bjest\b/.test(packageJson)) return 'jest';
  }
  return 'unknown';
};

/**
 * Find the nearest test name at/above `line` (1-based). Scans upward for a
 * `it(...)`, `test(...)`, or `describe(...)` whose title is a string literal.
 * Returns the title (unescaped quotes left as-is) or null when none is found.
 */
export const nearestTestName = (content: string, line: number): string | null => {
  const lines = content.split('\n');
  const start = Math.min(Math.max(1, line), lines.length) - 1;
  // Matches it / test / it.only / test.skip / describe + a quoted title.
  const re = /\b(?:it|test|describe)(?:\.\w+)?\s*\(\s*(['"`])((?:\\.|(?!\1).)*)\1/;
  for (let i = start; i >= 0; i--) {
    const m = re.exec(lines[i]);
    if (m) return m[2];
  }
  return null;
};

/** Shell-quote a string for a double-quoted argument (escape `"` and `\`). */
const dq = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Options for {@link buildTestCommand}. */
export type BuildTestCommandInput = {
  /** Workspace-relative or absolute file path to run. */
  filePath: string;
  /** File content (to locate the nearest test name). */
  content: string;
  /** 1-based cursor line. */
  line: number;
  /** package.json text, or null when absent. */
  packageJson: string | null;
};

/** The built command + metadata for display. */
export type TestCommand = {
  /** The shell command to run, or null when no runner could be determined. */
  command: string | null;
  runner: TestRunner;
  /** The test title targeted, or null when running the whole file. */
  testName: string | null;
};

/**
 * Build the "run this test" shell command. When a test name is found it targets
 * just that test (`-t`/`--test-name-pattern`/`-k`); otherwise it runs the whole
 * file. Returns `command: null` for an unknown runner so the UI can explain.
 */
export const buildTestCommand = (input: BuildTestCommandInput): TestCommand => {
  const runner = detectRunner(input.packageJson, input.filePath);
  const testName = nearestTestName(input.content, input.line);
  const file = input.filePath.replace(/\\/g, '/');
  switch (runner) {
    case 'vitest':
      return {
        runner,
        testName,
        command: testName ? `bunx vitest run ${dq(file)} -t ${dq(testName)}` : `bunx vitest run ${dq(file)}`,
      };
    case 'jest':
      return {
        runner,
        testName,
        command: testName ? `bunx jest ${dq(file)} -t ${dq(testName)}` : `bunx jest ${dq(file)}`,
      };
    case 'pytest':
      return {
        runner,
        testName,
        command: testName ? `pytest ${dq(file)} -k ${dq(testName)}` : `pytest ${dq(file)}`,
      };
    default:
      return { runner, testName, command: null };
  }
};

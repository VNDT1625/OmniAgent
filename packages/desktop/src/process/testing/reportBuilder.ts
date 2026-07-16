/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `reportBuilder` — turns a finished {@link TestSession} into a Markdown report
 * (Yêu cầu 2b, criterion 2.5: "xuất báo cáo kiểm thử dạng .md — bước nào đạt/hỏng,
 * kèm ảnh và video") plus a structured object the UI renders IDE-style.
 *
 * Pure + deterministic (no IO): given a session it returns the markdown string
 * and a structured summary. Persisting the `.md` is the orchestrator's job. This
 * makes the builder trivially unit-testable (Task 12.8).
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import type { TestSession } from './testingTypes';

/** Structured per-step row for the UI to render. */
export type ReportStepRow = {
  /** Step index (1-based). */
  index: number;
  /** Step description. */
  description: string;
  /** Pass/fail. */
  passed: boolean;
  /** Optional detail. */
  detail?: string;
  /** Screenshot paths for the step. */
  screenshots: string[];
};

/** Structured report consumed by the Testing UI alongside the markdown. */
export type StructuredReport = {
  /** Session id. */
  sessionId: string;
  /** Scenario name. */
  scenarioName: string;
  /** Platform tested. */
  platform: string;
  /** Overall pass/fail (all steps passed and status not error). */
  passed: boolean;
  /** Lifecycle status: passed / failed / error (setup failed before steps ran). */
  status: string;
  /** Total step count. */
  total: number;
  /** Passed step count. */
  passedCount: number;
  /** Per-step rows. */
  steps: ReportStepRow[];
  /** Recorded video path, if any. */
  videoPath?: string;
  /** Setup/teardown error (e.g. the app failed to start) when `status === 'error'`. */
  error?: string;
};

/** The full output of {@link buildReport}: markdown + structured data. */
export type BuiltReport = {
  /** The Markdown document. */
  markdown: string;
  /** The structured summary for the UI. */
  structured: StructuredReport;
};

/** Escape a value for safe inclusion in a markdown table cell. */
const cell = (value: string): string => value.replace(/\|/g, '\\|').replace(/\n/g, ' ');

/**
 * Build a Markdown + structured report for a finished test session.
 *
 * @param session The session to report on.
 * @returns The markdown document and a structured summary.
 */
export const buildReport = (session: TestSession): BuiltReport => {
  const total = session.results.length;
  const passedCount = session.results.filter((r) => r.passed).length;
  const overallPassed = session.status !== 'error' && total > 0 && passedCount === total;

  const steps: ReportStepRow[] = session.results.map((r, i) => ({
    index: i + 1,
    description: r.step.description,
    passed: r.passed,
    detail: r.detail,
    screenshots: r.screenshots,
  }));

  const lines: string[] = [];
  lines.push(`# Test Report: ${session.scenario.name}`);
  lines.push('');
  lines.push(`- **Session:** ${session.id}`);
  lines.push(`- **Platform:** ${session.scenario.platform}`);
  lines.push(`- **Status:** ${overallPassed ? '✅ PASSED' : session.status === 'error' ? '⚠️ ERROR' : '❌ FAILED'}`);
  lines.push(`- **Steps passed:** ${passedCount} / ${total}`);
  if (session.videoPath) lines.push(`- **Video:** ${session.videoPath}`);
  if (session.error) lines.push(`- **Error:** ${cell(session.error)}`);
  lines.push('');
  lines.push('| # | Step | Result | Detail | Screenshots |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const row of steps) {
    const shots = row.screenshots.map((s) => `![](${s})`).join(' ') || '—';
    lines.push(
      `| ${row.index} | ${cell(row.description)} | ${row.passed ? '✅' : '❌'} | ${cell(row.detail ?? '')} | ${shots} |`
    );
  }
  lines.push('');

  return {
    markdown: lines.join('\n'),
    structured: {
      sessionId: session.id,
      scenarioName: session.scenario.name,
      platform: session.scenario.platform,
      passed: overallPassed,
      status: session.status,
      total,
      passedCount,
      steps,
      videoPath: session.videoPath,
      error: session.error,
    },
  };
};

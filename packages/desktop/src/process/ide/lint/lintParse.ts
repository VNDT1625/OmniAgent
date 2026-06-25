/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure parser for oxlint's `--format unix` output into structured diagnostics.
 * No `fs`, no spawning — just string parsing, so it is fully unit-testable. The
 * bridge runs oxlint and feeds its stdout here.
 *
 * The `unix` format emits one diagnostic per line:
 *   <path>:<line>:<col>: <message> [<rule>]
 * and a trailing summary line (e.g. "Found 3 warnings.") which is ignored.
 */

/** Severity of a diagnostic, mapped to Monaco marker severities by the renderer. */
export type LintSeverity = 'error' | 'warning' | 'info';

/** One parsed diagnostic for a single file. */
export type LintDiagnostic = {
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column: number;
  /** Human-readable message. */
  message: string;
  /** Lint rule id, when present (e.g. `eslint(no-unused-vars)`). */
  rule?: string;
  /** Severity — oxlint `unix` does not encode it per-line, so default `warning`. */
  severity: LintSeverity;
};

/** A `unix`-format diagnostic line: `path:line:col: message`. */
const UNIX_LINE = /^(.*?):(\d+):(\d+):\s*(.*)$/;
/** A trailing `[rule]` or `(rule)` suffix in the message. */
const RULE_SUFFIX = /\s*[[(]([\w/@.-]+)[\])]\s*$/;

/**
 * Parse oxlint `--format unix` stdout into diagnostics. `severityHint` lets the
 * caller bias all lines to `error` (when oxlint exited non-zero with only
 * errors) — by default everything is a `warning`, matching how the project
 * treats most oxlint output.
 */
export const parseUnixLint = (stdout: string, severityHint: LintSeverity = 'warning'): LintDiagnostic[] => {
  const out: LintDiagnostic[] = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.length === 0) continue;
    const m = UNIX_LINE.exec(line);
    if (!m) continue; // summary / unrelated line
    const lineNo = Number(m[2]);
    const colNo = Number(m[3]);
    if (!Number.isFinite(lineNo) || !Number.isFinite(colNo)) continue;
    let message = m[4].trim();
    let rule: string | undefined;
    const ruleMatch = RULE_SUFFIX.exec(message);
    if (ruleMatch) {
      rule = ruleMatch[1];
      message = message.slice(0, ruleMatch.index).trim();
    }
    if (message.length === 0) continue;
    // Heuristic: oxlint prefixes hard errors with "error" wording sometimes; the
    // hint covers the common case. Explicit "error"/"warning" words win.
    const lower = message.toLowerCase();
    const severity: LintSeverity = /\berror\b/.test(lower)
      ? 'error'
      : /\bwarn(ing)?\b/.test(lower)
        ? 'warning'
        : severityHint;
    out.push({ line: Math.max(1, lineNo), column: Math.max(1, colNo), message, rule, severity });
  }
  return out;
};

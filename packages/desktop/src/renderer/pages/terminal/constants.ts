/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-side constants + small pure helpers for the Terminal page.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

import type { TerminalSchedule } from '@process/terminal/terminalTypes';

/** Connection status of the terminal bridge as seen by the page. */
export type TerminalBridgeStatus = 'loading' | 'ready' | 'unavailable';

/** A draft schedule the editor form edits before saving. */
export type ScheduleDraft = {
  id?: string;
  name: string;
  shell: string;
  cwd: string;
  script: string;
  kind: TerminalSchedule['kind'];
  cron: string;
  enabled: boolean;
};

/** An empty draft for the "new schedule" form. */
export const emptyScheduleDraft = (): ScheduleDraft => ({
  name: '',
  shell: '',
  cwd: '',
  script: '',
  kind: 'cron',
  cron: '0 9 * * *',
  enabled: true,
});

/** Build a draft from an existing schedule for editing. */
export const draftFromSchedule = (schedule: TerminalSchedule): ScheduleDraft => ({
  id: schedule.id,
  name: schedule.name,
  shell: schedule.shell ?? '',
  cwd: schedule.cwd ?? '',
  script: schedule.script,
  kind: schedule.kind,
  cron: schedule.cron ?? '0 9 * * *',
  enabled: schedule.enabled,
});

/**
 * Strip terminal control sequences from a raw output chunk so the lightweight
 * renderer can display readable text without a full ANSI emulator.
 *
 * Removes CSI escape sequences (colors, cursor moves), OSC sequences (window
 * titles), and bare control chars except `\n`, `\r`, `\t`. This is intentionally
 * a *display* simplification, not a TTY — the raw bytes still reach the shell.
 */
export const stripAnsi = (input: string): string =>
  input
    // CSI sequences: ESC [ ... final-byte
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // OSC sequences: ESC ] ... BEL or ESC \
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g, '')
    // Remaining single-char escapes
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b[@-Z\\-_]/g, '')
    // Bare control chars except tab/newline/carriage-return
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/**
 * Apply carriage returns so progress bars / `\r`-overwrites collapse onto a
 * single line instead of stacking. Splits into lines, and within each line a
 * `\r` resets to column 0 (the last segment wins for full overwrites).
 */
export const normalizeOutput = (input: string): string =>
  stripAnsi(input)
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const segments = line.split('\r');
      return segments[segments.length - 1];
    })
    .join('\n');

export type MtuiStaleConfirmationNotice = {
  token: string;
  file?: string;
  status: string;
  diffExcerpt?: string;
  acceptCommand: string;
};

const balancedJsonObjects = (text: string): unknown[] => {
  const objects: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (start < 0) {
      if (char === '{') {
        start = index;
        depth = 1;
      }
      continue;
    }
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\' && inString) {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === '{') depth += 1;
    if (char === '}') depth -= 1;
    if (depth === 0) {
      const candidate = text.slice(start, index + 1);
      try {
        objects.push(JSON.parse(candidate) as unknown);
      } catch {
        // Ignore non-JSON braces from shell output.
      }
      start = -1;
      inString = false;
      escaped = false;
    }
  }
  return objects;
};

const objectRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const stringValue = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

export const findMtuiStaleConfirmation = (buffer: string): MtuiStaleConfirmationNotice | null => {
  const normalized = normalizeOutput(buffer);
  const objects = balancedJsonObjects(normalized);
  for (const parsed of [...objects].toReversed()) {
    const root = objectRecord(parsed);
    if (!root) continue;
    const details = objectRecord(root.details);
    const conflict = objectRecord(root.conflict) ?? details;
    if (!conflict) continue;
    const resolution = objectRecord(conflict.resolution);
    const status = stringValue(resolution?.status);
    if (status !== 'needs_confirmation') continue;
    const token =
      stringValue(resolution?.confirmation_token) ??
      stringValue(root.token) ??
      stringValue(objectRecord(root.data)?.token);
    if (!token) continue;
    const operations = Array.isArray(conflict.checked_operations) ? conflict.checked_operations : [];
    const firstOperation = objectRecord(operations[0]);
    return {
      token,
      file: stringValue(root.file) ?? stringValue(root.relative_file),
      status,
      diffExcerpt: stringValue(firstOperation?.diff_excerpt),
      acceptCommand: `mtui --json conflict accept ${token}`,
    };
  }
  return null;
};

// ---------------------------------------------------------------------------
// ANSI color rendering — parse SGR sequences into styled spans
// ---------------------------------------------------------------------------

/**
 * A styled text span produced by {@link parseAnsi}.
 * All style fields are optional; absent = inherit from parent.
 */
export type AnsiSpan = {
  text: string;
  color?: string;
  bgColor?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
};

/**
 * Standard 16-color ANSI palette mapped to Arco/CSS semantic tokens so the
 * terminal respects the app's light/dark theme. Foreground codes 30–37 and
 * bright 90–97; background codes 40–47 and bright 100–107.
 */
const FG_COLORS: Record<number, string> = {
  30: 'var(--color-text-3)',
  31: 'var(--color-danger-6)',
  32: 'var(--color-success-6)',
  33: 'var(--color-warning-6)',
  34: 'var(--color-primary-6)',
  35: '#a855f7',
  36: '#06b6d4',
  37: 'var(--color-text-1)',
  90: 'var(--color-text-3)',
  91: 'var(--color-danger-4)',
  92: 'var(--color-success-4)',
  93: 'var(--color-warning-4)',
  94: 'var(--color-primary-4)',
  95: '#c084fc',
  96: '#22d3ee',
  97: 'var(--color-text-1)',
};

const BG_COLORS: Record<number, string> = {
  40: 'rgba(0,0,0,0.6)',
  41: 'var(--color-danger-light-1)',
  42: 'var(--color-success-light-1)',
  43: 'var(--color-warning-light-1)',
  44: 'var(--color-primary-light-1)',
  45: 'rgba(168,85,247,0.15)',
  46: 'rgba(6,182,212,0.15)',
  47: 'rgba(255,255,255,0.1)',
  100: 'rgba(0,0,0,0.4)',
  101: 'var(--color-danger-light-2)',
  102: 'var(--color-success-light-2)',
  103: 'var(--color-warning-light-2)',
  104: 'var(--color-primary-light-2)',
  105: 'rgba(192,132,252,0.15)',
  106: 'rgba(34,211,238,0.15)',
  107: 'rgba(255,255,255,0.15)',
};

type AnsiState = {
  color?: string;
  bgColor?: string;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
};

const resetState = (): AnsiState => ({ bold: false, dim: false, italic: false, underline: false });

/**
 * Parse a raw terminal output string (after `\r` normalization) into an array
 * of {@link AnsiSpan} objects. Each span carries the text plus the active SGR
 * style at that point. Spans with empty text are omitted.
 *
 * Supports: SGR 0 (reset), 1 (bold), 2 (dim), 3 (italic), 4 (underline),
 * 22/23/24 (reset bold/italic/underline), 30–37/90–97 (fg), 39 (fg reset),
 * 40–47/100–107 (bg), 49 (bg reset). 256-color and true-color (38;5;n /
 * 38;2;r;g;b) are stripped gracefully (no crash, no color applied).
 */
export const parseAnsi = (input: string): AnsiSpan[] => {
  const spans: AnsiSpan[] = [];
  let state: AnsiState = resetState();
  // Split on CSI SGR sequences: ESC [ <params> m
  // eslint-disable-next-line no-control-regex
  const parts = input.split(/(\u001b\[[0-9;]*m)/);

  for (const part of parts) {
    // eslint-disable-next-line no-control-regex
    if (part.startsWith('\x1B[')) {
      // It's a CSI SGR sequence — parse the numeric params
      const inner = part.slice(2, -1); // strip ESC[ and m
      const codes = inner === '' ? [0] : inner.split(';').map(Number);
      let i = 0;
      while (i < codes.length) {
        const code = codes[i];
        if (code === 0) {
          state = resetState();
        } else if (code === 1) {
          state = { ...state, bold: true };
        } else if (code === 2) {
          state = { ...state, dim: true };
        } else if (code === 3) {
          state = { ...state, italic: true };
        } else if (code === 4) {
          state = { ...state, underline: true };
        } else if (code === 22) {
          state = { ...state, bold: false, dim: false };
        } else if (code === 23) {
          state = { ...state, italic: false };
        } else if (code === 24) {
          state = { ...state, underline: false };
        } else if (code === 39) {
          state = { ...state, color: undefined };
        } else if (code === 49) {
          state = { ...state, bgColor: undefined };
        } else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) {
          state = { ...state, color: FG_COLORS[code] };
        } else if ((code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
          state = { ...state, bgColor: BG_COLORS[code] };
        } else if (code === 38 || code === 48) {
          // 256-color: 38;5;n or true-color: 38;2;r;g;b — skip gracefully
          if (codes[i + 1] === 5) {
            i += 2; // skip 5 + n
          } else if (codes[i + 1] === 2) {
            i += 4; // skip 2 + r + g + b
          }
        }
        i++;
      }
    } else if (part.length > 0) {
      // Plain text — emit a span with the current style
      const span: AnsiSpan = { text: part };
      if (state.color) span.color = state.color;
      if (state.bgColor) span.bgColor = state.bgColor;
      if (state.bold) span.bold = true;
      if (state.dim) span.dim = true;
      if (state.italic) span.italic = true;
      if (state.underline) span.underline = true;
      spans.push(span);
    }
  }
  return spans;
};

/**
 * Like {@link normalizeOutput} but returns {@link AnsiSpan}[] instead of a plain
 * string, preserving color/style information for rich rendering.
 */
export const normalizeOutputRich = (input: string): AnsiSpan[] => {
  // First apply \r normalization per-line (same as normalizeOutput), then parse ANSI.
  // We need to handle \r before splitting on ANSI sequences.
  // eslint-disable-next-line no-control-regex
  const crNormalized = input
    .split('\n')
    .map((line) => {
      if (!line.includes('\r')) return line;
      const segments = line.split('\r');
      return segments[segments.length - 1];
    })
    .join('\n');
  return parseAnsi(crNormalized);
};

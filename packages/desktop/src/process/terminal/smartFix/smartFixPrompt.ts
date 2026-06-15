/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PURE helpers for the Smart Fix in-terminal confirmation prompt (auto-rerun).
 *
 * When auto-rerun is enabled and a failed command has a known remap, the
 * terminal prints a `(y/N)` question and waits for the next keystroke. Printing
 * the question into the terminal (rather than only showing a GUI button) makes
 * Smart Fix answerable by an AGENT driving the terminal via text — it reads the
 * question from the output stream and types `y`/`n`, exactly like a human.
 *
 * These helpers build the prompt line and classify the answer key. No I/O.
 */

/** What a keystroke means while awaiting a Smart Fix confirmation. */
export type ConfirmDecision = 'accept' | 'reject' | 'ignore';

/**
 * Classify a raw keystroke chunk while a `(y/N)` prompt is active:
 *  - `y` / `Y`            → accept (run the replacement)
 *  - `n` / `N` / Esc      → reject (dismiss)
 *  - anything else        → ignore (caller cancels the prompt + passes the key through)
 *
 * Enter is intentionally NOT a default-yes: a `(y/N)` prompt requires an explicit
 * `y`, so a stray Enter never auto-runs a substituted command.
 */
export const interpretConfirmKey = (data: string): ConfirmDecision => {
  if (data === 'y' || data === 'Y') return 'accept';
  if (data === 'n' || data === 'N' || data === '\x1b') return 'reject';
  return 'ignore';
};

/** Localized labels for {@link buildConfirmPrompt} (so the text stays i18n-driven). */
export type ConfirmPromptLabels = {
  /** Short tag, e.g. "Smart Fix". */
  tag: string;
  /** The question, already interpolated, e.g. "run `agi …`? (y/N)". */
  question: string;
};

/** ANSI: yellow tag, reset. Kept tiny + literal so it is easy to test. */
const ESC = '\u001b';
const YELLOW = `${ESC}[33m`;
const DIM = `${ESC}[2m`;
const RESET = `${ESC}[0m`;

/**
 * Build the prompt line written to the terminal when asking to apply a remap.
 * The line is self-contained (leading CRLF, trailing space for the answer) and
 * uses minimal ANSI so it stands out without depending on the theme.
 *
 * @param from The deprecated program.
 * @param to The replacement program.
 * @param labels Localized tag + question.
 * @returns The ready-to-write terminal line.
 */
export const buildConfirmPrompt = (from: string, to: string, labels: ConfirmPromptLabels): string =>
  `\r\n${YELLOW}[${labels.tag}]${RESET} ${DIM}${from} → ${to}${RESET} ${labels.question} `;

/** A short acknowledgement line written after the user answers (accept/reject). */
export const buildAckLine = (text: string): string => `\r\n${DIM}${text}${RESET}\r\n`;

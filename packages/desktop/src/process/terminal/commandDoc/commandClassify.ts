/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * PURE command classification — split a command line into the program (the tool
 * being invoked) and the rest. Used by Smart Fix to look up a deprecated-tool
 * remap by program name (e.g. `gemini` → `agi`).
 *
 * Leading `KEY=VALUE` env assignments are separated out, and the program is
 * reduced to its basename (`./bin/gemini` → `gemini`) so remap lookups match
 * regardless of how the tool was invoked. No I/O.
 */

/** The decomposed parts of a command line. */
export type ClassifiedCommand = {
  /** Leading `KEY=VALUE` env assignments, in order. */
  env: string[];
  /** The program/tool basename (e.g. `gemini`), or '' when empty. */
  program: string;
  /** The raw program token as written (e.g. `./bin/gemini`), or ''. */
  programToken: string;
  /** The arguments after the program (raw, joined). */
  args: string;
  /** Whitespace-tokenised argv. */
  tokens: string[];
};

/** Whether a token is a `KEY=VALUE` env assignment. */
const isEnvAssignment = (token: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);

/** Basename of a program path (handles both `/` and `\` separators). */
const basename = (token: string): string => {
  const parts = token.split(/[\\/]/);
  return parts[parts.length - 1] || token;
};

/**
 * Split a command line into env assignments, program (basename) and args.
 *
 * @param command The command line.
 * @returns The classified parts (program is '' for an empty/blank command).
 */
export const classifyCommand = (command: string): ClassifiedCommand => {
  const tokens = command.trim().split(/\s+/).filter((t) => t.length > 0);
  const env: string[] = [];
  let i = 0;
  while (i < tokens.length && isEnvAssignment(tokens[i])) {
    env.push(tokens[i]);
    i += 1;
  }
  const programToken = tokens[i] ?? '';
  const program = programToken.length > 0 ? basename(programToken) : '';
  const args = tokens.slice(i + 1).join(' ');
  return { env, program, programToken, args, tokens };
};

/**
 * Rebuild a command line, replacing the program token with `newProgram` while
 * keeping env assignments and args intact.
 *
 * @param command The original command.
 * @param newProgram The replacement program name.
 * @returns The rewritten command line.
 */
export const replaceProgram = (command: string, newProgram: string): string => {
  const c = classifyCommand(command);
  if (c.programToken.length === 0) return command;
  const parts = [...c.env, newProgram];
  if (c.args.length > 0) parts.push(c.args);
  return parts.join(' ');
};

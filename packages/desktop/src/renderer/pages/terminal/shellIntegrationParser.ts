/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Renderer-side parser for VS Code-style shell-integration sequences (OSC 633).
 *
 * The shell (instrumented by `process/terminal/shellIntegration.ts`) emits
 * invisible `OSC 633 ; … ST` control sequences around each prompt/command. This
 * module extracts them from a raw output chunk and returns:
 *  - `clean`: the chunk with the OSC 633 sequences removed (safe to feed xterm),
 *  - `markers`: the structured events (prompt/command boundaries + exit code + cwd).
 *
 * Pure + stateless per call — the stateful interpretation (pairing start/end
 * into a command record with a decoration) lives in the consuming component.
 *
 * Process boundary: Renderer module. No Node.js APIs.
 */

/** A structured shell-integration event parsed from the output stream. */
export type ShellIntegrationEvent =
  | { kind: 'prompt-start' }
  | { kind: 'prompt-end' }
  | { kind: 'command-start' }
  | { kind: 'command-end'; exitCode: number }
  | { kind: 'command-line'; commandLine: string }
  | { kind: 'cwd'; cwd: string };

/** Result of {@link parseShellIntegration}. */
export type ParsedShellIntegration = {
  /** The output with OSC 633 sequences stripped. */
  clean: string;
  /** Markers in the order they appeared. */
  events: ShellIntegrationEvent[];
};

// OSC 633 sequence: ESC ] 633 ; <payload> (BEL | ESC \)
// eslint-disable-next-line no-control-regex
const OSC_633 = /\u001b\]633;([^\u0007\u001b]*)(?:\u0007|\u001b\\)/g;

/** Decode an OSC 633 payload (after the `633;`) into a structured event. */
const decodePayload = (payload: string): ShellIntegrationEvent | null => {
  const semi = payload.indexOf(';');
  const code = semi === -1 ? payload : payload.slice(0, semi);
  const rest = semi === -1 ? '' : payload.slice(semi + 1);
  switch (code) {
    case 'A':
      return { kind: 'prompt-start' };
    case 'B':
      return { kind: 'prompt-end' };
    case 'C':
      return { kind: 'command-start' };
    case 'D': {
      const exitCode = rest.length > 0 ? Number.parseInt(rest, 10) : 0;
      return { kind: 'command-end', exitCode: Number.isFinite(exitCode) ? exitCode : 0 };
    }
    case 'E':
      return { kind: 'command-line', commandLine: rest };
    case 'P': {
      // Properties are `Key=Value`; we only care about Cwd.
      const eq = rest.indexOf('=');
      if (eq !== -1 && rest.slice(0, eq) === 'Cwd') return { kind: 'cwd', cwd: rest.slice(eq + 1) };
      return null;
    }
    default:
      return null;
  }
};

/**
 * Strip OSC 633 sequences from a chunk and return the cleaned text plus the
 * structured events found in it.
 */
export const parseShellIntegration = (chunk: string): ParsedShellIntegration => {
  if (!chunk.includes('\u001b]633;')) return { clean: chunk, events: [] };
  const events: ShellIntegrationEvent[] = [];
  const clean = chunk.replace(OSC_633, (_match, payload: string) => {
    const event = decodePayload(payload);
    if (event) events.push(event);
    return '';
  });
  return { clean, events };
};

/** An ordered token from {@link tokenizeShellIntegration}: visible text or an event. */
export type ShellIntegrationToken = { type: 'text'; text: string } | { type: 'event'; event: ShellIntegrationEvent };

/**
 * Split a chunk into ordered tokens: runs of visible text interleaved with the
 * OSC 633 events, in stream order. The terminal writes the text tokens to xterm
 * and, between them (in the write callback), registers command markers/decorations
 * at the correct cursor position — exactly where each command boundary occurred.
 */
export const tokenizeShellIntegration = (chunk: string): ShellIntegrationToken[] => {
  if (!chunk.includes('\u001b]633;')) return [{ type: 'text', text: chunk }];
  const tokens: ShellIntegrationToken[] = [];
  let lastIndex = 0;
  OSC_633.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = OSC_633.exec(chunk)) !== null) {
    if (match.index > lastIndex) tokens.push({ type: 'text', text: chunk.slice(lastIndex, match.index) });
    const event = decodePayload(match[1]);
    if (event) tokens.push({ type: 'event', event });
    lastIndex = OSC_633.lastIndex;
  }
  if (lastIndex < chunk.length) tokens.push({ type: 'text', text: chunk.slice(lastIndex) });
  return tokens;
};

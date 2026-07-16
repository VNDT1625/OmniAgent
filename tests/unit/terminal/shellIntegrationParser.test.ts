/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the renderer-side OSC 633 shell-integration parser. Pure
 * string → events, so no DOM/xterm is needed.
 */

import { describe, expect, it } from 'vitest';
import {
  parseShellIntegration,
  tokenizeShellIntegration,
  type ShellIntegrationToken,
} from '@/renderer/pages/terminal/shellIntegrationParser';

const ESC = '\u001b';
const BEL = '\u0007';
const osc = (payload: string): string => `${ESC}]633;${payload}${BEL}`;

describe('parseShellIntegration', () => {
  it('returns the chunk unchanged when no OSC 633 is present', () => {
    const input = 'plain output with a : colon and ] bracket';
    expect(parseShellIntegration(input)).toEqual({ clean: input, events: [] });
  });

  it('strips OSC 633 sequences from the visible text', () => {
    const input = `${osc('A')}user@host$ ${osc('B')}ls${osc('C')}file.txt${osc('D;0')}`;
    const { clean } = parseShellIntegration(input);
    expect(clean).toBe('user@host$ lsfile.txt');
    expect(clean).not.toContain('633');
  });

  it('decodes prompt/command boundaries + exit code + cwd', () => {
    const input = `${osc('A')}${osc('B')}${osc('C')}${osc('D;1')}${osc('P;Cwd=/home/me')}`;
    const { events } = parseShellIntegration(input);
    expect(events).toEqual([
      { kind: 'prompt-start' },
      { kind: 'prompt-end' },
      { kind: 'command-start' },
      { kind: 'command-end', exitCode: 1 },
      { kind: 'cwd', cwd: '/home/me' },
    ]);
  });

  it('treats a command-end with no code as exit 0', () => {
    const { events } = parseShellIntegration(osc('D'));
    expect(events).toEqual([{ kind: 'command-end', exitCode: 0 }]);
  });

  it('accepts the ESC-backslash (ST) terminator as well as BEL', () => {
    const input = `${ESC}]633;C${ESC}\\done`;
    const { clean, events } = parseShellIntegration(input);
    expect(clean).toBe('done');
    expect(events).toEqual([{ kind: 'command-start' }]);
  });
});

describe('tokenizeShellIntegration', () => {
  it('returns a single text token when no markers are present', () => {
    expect(tokenizeShellIntegration('hello')).toEqual([{ type: 'text', text: 'hello' }]);
  });

  it('preserves stream order of text and events', () => {
    const input = `a${osc('C')}b${osc('D;0')}c`;
    const tokens = tokenizeShellIntegration(input);
    const kinds = tokens.map((t: ShellIntegrationToken) => (t.type === 'text' ? `T:${t.text}` : `E:${t.event.kind}`));
    expect(kinds).toEqual(['T:a', 'E:command-start', 'T:b', 'E:command-end', 'T:c']);
  });
});

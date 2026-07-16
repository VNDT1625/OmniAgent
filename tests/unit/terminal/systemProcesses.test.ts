/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/terminal/systemProcesses — the OS process-table
 * parsers (Windows tasklist CSV + POSIX ps) and the degrade-safe list helper.
 */

import { describe, expect, it } from 'vitest';
import { listSystemTerminals, parsePsOutput, parseTasklistCsv } from '@/process/terminal/systemProcesses';

describe('parseTasklistCsv', () => {
  it('keeps only shell/terminal images with valid PIDs', () => {
    const csv = [
      '"cmd.exe","1234","Console","1","5,000 K"',
      '"powershell.exe","5678","Console","1","20,000 K"',
      '"chrome.exe","9999","Console","1","100,000 K"',
      '"explorer.exe","4242","Console","1","30,000 K"',
    ].join('\r\n');

    const result = parseTasklistCsv(csv);

    expect(result).toEqual([
      { pid: 1234, name: 'cmd.exe' },
      { pid: 5678, name: 'powershell.exe' },
    ]);
  });

  it('ignores blank and malformed lines', () => {
    const csv = '\n"wt.exe","10","Console","1","1 K"\ngarbage line\n';
    expect(parseTasklistCsv(csv)).toEqual([{ pid: 10, name: 'wt.exe' }]);
  });
});

describe('parsePsOutput', () => {
  it('extracts the basename and keeps only shells', () => {
    const ps = ['  1234 /bin/bash', '  5678 /usr/bin/zsh', '  4242 /usr/lib/firefox/firefox', '  9 sh'].join('\n');

    const result = parsePsOutput(ps);

    expect(result).toEqual([
      { pid: 1234, name: 'bash' },
      { pid: 5678, name: 'zsh' },
      { pid: 9, name: 'sh' },
    ]);
  });
});

describe('listSystemTerminals', () => {
  it('returns an empty list (never throws) when the exec fails', async () => {
    const failing = async (): Promise<string> => {
      throw new Error('command not found');
    };
    await expect(listSystemTerminals(failing)).resolves.toEqual([]);
  });

  it('parses output from the injected exec function', async () => {
    // On POSIX the helper runs `ps`; on Windows it runs `tasklist`. Drive the
    // matching parser by platform so the assertion holds on either CI host.
    const exec = async (command: string): Promise<string> =>
      command.startsWith('tasklist') ? '"cmd.exe","7","Console","1","1 K"' : '  7 /bin/bash';

    const result = await listSystemTerminals(exec);

    expect(result).toHaveLength(1);
    expect(result[0].pid).toBe(7);
  });
});

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseMtuiOutput, resolveInstalledWindowsMtui } from '@/process/terminal/mtuiBridge';
import { commandFromTerminalInput, detectMtuiViolations, isDirectWriteCommand } from '@/process/terminal/mtuiPolicy';

const tempDirs: string[] = [];

function createInstallDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mtui-install-'));
  tempDirs.push(dir);
  return dir;
}

function createBinary(path: string): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, '');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('MTUI strict policy helpers', () => {
  it('detects obvious direct file-write commands but allows MTUI/build commands', () => {
    expect(isDirectWriteCommand('Set-Content src/a.ts "x"')).toBe(true);
    expect(isDirectWriteCommand("python -c \"open('src/a.ts', 'w').write('x')\"")).toBe(true);
    expect(isDirectWriteCommand('echo hello > src/a.ts')).toBe(true);
    expect(isDirectWriteCommand('mtui --json new src/a.ts --content x --overwrite')).toBe(false);
    expect(isDirectWriteCommand('bun run test')).toBe(false);
    expect(isDirectWriteCommand('bunx tsc --noEmit')).toBe(false);
  });

  it('extracts complete terminal command lines', () => {
    expect(commandFromTerminalInput('bun run test\r\n')).toBe('bun run test');
    expect(commandFromTerminalInput('partial input')).toBeNull();
  });

  it('reports changed files with no recent MTUI operation', () => {
    const violations = detectMtuiViolations(
      '/repo',
      ['src/a.ts', 'src/b.ts', '.mtui/mtui.db'],
      [
        {
          file_path: '/repo/src/a.ts',
          changed: true,
        },
      ]
    );

    expect(violations).toEqual([
      {
        path: 'src/b.ts',
        reason: 'Changed file has no recent MTUI write operation.',
      },
    ]);
  });

  it('ignores files accepted by the policy baseline', () => {
    const violations = detectMtuiViolations('/repo', ['src/a.ts', 'src/b.ts'], [], new Set(['src/a.ts']));

    expect(violations).toEqual([
      {
        path: 'src/b.ts',
        reason: 'Changed file has no recent MTUI write operation.',
      },
    ]);
  });

  it('ignores spec temporary files', () => {
    const violations = detectMtuiViolations(
      '/repo',
      ['.aionui/specs/demo/plan/temporary/test.log', '.kiro/tmp-ox.txt', 'src/a.ts'],
      [],
      new Set()
    );

    expect(violations).toEqual([
      {
        path: 'src/a.ts',
        reason: 'Changed file has no recent MTUI write operation.',
      },
    ]);
  });

  it('preserves MTUI stale-confirmation JSON from non-zero CLI output', () => {
    const response = parseMtuiOutput(
      JSON.stringify({
        ok: false,
        error_type: 'CONFLICT',
        details: {
          resolution: {
            status: 'needs_confirmation',
            confirmation_token: 'token-1',
          },
          checked_operations: [{ diff_excerpt: '+ return bar() + 1;' }],
        },
      })
    );

    expect(response.ok).toBe(false);
    expect(response.details).toEqual({
      resolution: {
        status: 'needs_confirmation',
        confirmation_token: 'token-1',
      },
      checked_operations: [{ diff_excerpt: '+ return bar() + 1;' }],
    });
  });
});

describe('MTUI binary resolution', () => {
  it('prefers the installer latest metadata over lexicographic version folders', () => {
    const installDir = createInstallDir();
    const latestBinary = join(installDir, 'versions', '0.1.0-9', 'mtui.exe');
    const staleBinary = join(installDir, 'versions', '0.1.0-999', 'mtui.exe');
    createBinary(latestBinary);
    createBinary(staleBinary);
    writeFileSync(join(installDir, 'latest.json'), JSON.stringify({ binary: latestBinary }));

    expect(resolveInstalledWindowsMtui('mtui.exe', installDir)).toBe(latestBinary);
  });

  it('falls back to the newest version folder when latest metadata is missing or stale', () => {
    const installDir = createInstallDir();
    const primaryBinary = join(installDir, 'mtui.exe');
    const newestBinary = join(installDir, 'versions', '0.1.0-200', 'mtui.exe');
    createBinary(primaryBinary);
    createBinary(newestBinary);
    writeFileSync(join(installDir, 'latest.json'), JSON.stringify({ binary: join(installDir, 'missing', 'mtui.exe') }));

    expect(resolveInstalledWindowsMtui('mtui.exe', installDir)).toBe(newestBinary);
  });
});

/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { buildTestCommand, detectRunner, nearestTestName } from '@/process/ide/testrun/testCommand';

describe('detectRunner', () => {
  it('detects pytest from a .py file regardless of package.json', () => {
    expect(detectRunner(null, 'a/b/test_x.py')).toBe('pytest');
  });
  it('detects vitest / jest from package.json', () => {
    expect(detectRunner('{"devDependencies":{"vitest":"^4"}}', 'a.test.ts')).toBe('vitest');
    expect(detectRunner('{"devDependencies":{"jest":"^29"}}', 'a.test.ts')).toBe('jest');
  });
  it('returns unknown when nothing matches', () => {
    expect(detectRunner('{"name":"x"}', 'a.test.ts')).toBe('unknown');
    expect(detectRunner(null, 'a.test.ts')).toBe('unknown');
  });
});

describe('nearestTestName', () => {
  const src = ["describe('group', () => {", "  it('does a thing', () => {", '    expect(1).toBe(1)', '  })', '})'].join(
    '\n'
  );
  it('finds the enclosing it() title from inside the body', () => {
    expect(nearestTestName(src, 3)).toBe('does a thing');
  });
  it('falls back to describe when above the it', () => {
    expect(nearestTestName(src, 1)).toBe('group');
  });
  it('returns null when no test on/above the line', () => {
    expect(nearestTestName('const x = 1\n', 1)).toBeNull();
  });
  it('supports it.only / test.skip', () => {
    expect(nearestTestName("it.only('x', () => {})", 1)).toBe('x');
    expect(nearestTestName('test.skip("y", () => {})', 1)).toBe('y');
  });
});

describe('buildTestCommand', () => {
  const pkg = '{"devDependencies":{"vitest":"^4"}}';

  it('targets a single test by name for vitest', () => {
    const out = buildTestCommand({
      filePath: 'src/a.test.ts',
      content: "it('my case', () => {})",
      line: 1,
      packageJson: pkg,
    });
    expect(out.runner).toBe('vitest');
    expect(out.testName).toBe('my case');
    expect(out.command).toBe('bunx vitest run "src/a.test.ts" -t "my case"');
  });

  it('runs the whole file when no test name is found', () => {
    const out = buildTestCommand({ filePath: 'src/a.test.ts', content: 'const x = 1', line: 1, packageJson: pkg });
    expect(out.command).toBe('bunx vitest run "src/a.test.ts"');
  });

  it('uses -k for pytest', () => {
    const out = buildTestCommand({
      filePath: 'test_x.py',
      content: 'def test_foo():\n    assert True',
      line: 2,
      packageJson: null,
    });
    // pytest test discovery uses function names, not the it() pattern, so name is null here.
    expect(out.runner).toBe('pytest');
    expect(out.command).toBe('pytest "test_x.py"');
  });

  it('returns null command for an unknown runner', () => {
    const out = buildTestCommand({ filePath: 'a.test.ts', content: "it('x',()=>{})", line: 1, packageJson: '{}' });
    expect(out.command).toBeNull();
  });

  it('normalises backslashes to forward slashes in the path', () => {
    const out = buildTestCommand({ filePath: 'src\\a.test.ts', content: 'x', line: 1, packageJson: pkg });
    expect(out.command).toContain('"src/a.test.ts"');
  });
});

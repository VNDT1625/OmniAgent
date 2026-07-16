/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectFiles, grepRepo } from '@/process/ide/search/ideSearchBridge';

const tempRoots: string[] = [];

const makeRepo = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aionui-ide-search-'));
  tempRoots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('collectFiles', () => {
  it('walks text files in stable order and skips ignored directories', async () => {
    const root = await makeRepo();
    await Promise.all([
      mkdir(path.join(root, 'src', 'nested'), { recursive: true }),
      mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(path.join(root, 'src', 'b.ts'), 'export const b = 1;\n'),
      writeFile(path.join(root, 'src', 'nested', 'a.ts'), 'export const a = 1;\n'),
      writeFile(path.join(root, 'node_modules', 'pkg', 'skip.ts'), 'export const skip = 1;\n'),
      writeFile(path.join(root, 'src', 'asset.png'), 'not text\n'),
    ]);

    const files = await collectFiles(root);

    expect(files.map((file) => path.relative(root, file).replace(/\\/g, '/'))).toEqual(['src/b.ts', 'src/nested/a.ts']);
  });
});

describe('grepRepo', () => {
  it('returns matching lines in stable file and line order', async () => {
    const root = await makeRepo();
    await mkdir(path.join(root, 'src'), { recursive: true });
    await Promise.all([
      writeFile(path.join(root, 'src', 'b.ts'), 'needle on b line 1\nneedle on b line 2\n'),
      writeFile(path.join(root, 'src', 'a.ts'), 'other\nneedle on a line 2\n'),
    ]);

    const matches = await grepRepo({ rootPath: root, query: 'needle' });

    expect(
      matches.map((match) => ({
        file: path.basename(match.path),
        line: match.line,
        text: match.text,
      }))
    ).toEqual([
      { file: 'a.ts', line: 2, text: 'needle on a line 2' },
      { file: 'b.ts', line: 1, text: 'needle on b line 1' },
      { file: 'b.ts', line: 2, text: 'needle on b line 2' },
    ]);
  });

  it('keeps searches bounded by result count and file size', async () => {
    const root = await makeRepo();
    await mkdir(path.join(root, 'src'), { recursive: true });
    await Promise.all([
      writeFile(path.join(root, 'src', 'a.ts'), 'needle a\nneedle a2\n'),
      writeFile(path.join(root, 'src', 'b.ts'), 'needle b\n'),
      writeFile(path.join(root, 'src', 'huge.ts'), `needle huge\n${'x'.repeat(2 * 1024 * 1024)}`),
    ]);

    const matches = await grepRepo({ rootPath: root, query: 'needle', maxResults: 2 });

    expect(matches).toHaveLength(2);
    expect(matches.map((match) => path.basename(match.path))).not.toContain('huge.ts');
  });
});

import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeFileGateway } from '@process/resources/nativeFileGateway';
import { rm } from 'node:fs/promises';

const roots: string[] = [];
const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tomny-file-gateway-test-'));
  roots.push(root);
  return root;
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('native file gateway', () => {
  it('writes and reads text without a backend process', async () => {
    const root = await tempRoot();
    const target = path.join(root, 'nested', 'hello.txt');
    const gateway = new NativeFileGateway();

    await expect(gateway.writeText(target, 'xin ch?o')).resolves.toBe(true);
    await expect(gateway.readText(target)).resolves.toBe('xin ch?o');
    await expect(readFile(target, 'utf8')).resolves.toBe('xin ch?o');
  });

  it('returns null for a missing file but propagates non-file failures', async () => {
    const root = await tempRoot();
    const gateway = new NativeFileGateway();

    await expect(gateway.readText(path.join(root, 'missing.txt'))).resolves.toBeNull();
    await expect(gateway.readText(root)).rejects.toBeDefined();
  });

  it('lists workspace files while excluding git, node_modules and symlink loops', async () => {
    const root = await tempRoot();
    const gateway = new NativeFileGateway();
    await gateway.writeText(path.join(root, 'src', 'a.ts'), 'a');
    await gateway.writeText(path.join(root, '.git', 'secret'), 'x');
    await gateway.writeText(path.join(root, 'node_modules', 'dep.js'), 'x');

    await expect(gateway.listWorkspaceFiles(root)).resolves.toEqual([
      { name: 'a.ts', fullPath: path.join(root, 'src', 'a.ts'), relativePath: 'src/a.ts' },
    ]);
  });

  it('prevents source_root traversal when copying into a workspace', async () => {
    const root = await tempRoot();
    const sourceRoot = path.join(root, 'source');
    const workspace = path.join(root, 'workspace');
    const outside = path.join(root, 'outside.txt');
    await gatewayWrite(sourceRoot, 'inside.txt', 'inside');
    await writeFile(outside, 'outside');
    const gateway = new NativeFileGateway();

    const result = await gateway.copyToWorkspace({
      file_paths: [path.join(sourceRoot, 'inside.txt'), outside],
      workspace,
      source_root: sourceRoot,
    });

    expect(result.copied_files).toEqual([path.join(workspace, 'inside.txt')]);
    expect(result.failed_files?.[0]?.error).toContain('outside source_root');
  });

  it('rejects path separators in rename targets', async () => {
    const root = await tempRoot();
    const gateway = new NativeFileGateway();
    const source = path.join(root, 'a.txt');
    await writeFile(source, 'a');

    await expect(gateway.rename(source, `nested${path.sep}b.txt`)).rejects.toThrow('single file name');
  });
});

const gatewayWrite = async (root: string, relative: string, content: string): Promise<void> => {
  const gateway = new NativeFileGateway();
  await gateway.writeText(path.join(root, relative), content);
};

import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import JSZip from 'jszip';
import { afterEach, describe, expect, it } from 'vitest';
import { NativeZipService } from '@process/resources/nativePlatform/fileOperations';
import { NativeMcpConfigScanner } from '@process/resources/nativePlatform/mcpDrivers';
import { NativeSkillCatalog } from '@process/resources/nativePlatform/skillCatalog';
import { NativeSnapshotService } from '@process/resources/nativePlatform/snapshotService';

const temporary: string[] = [];
const tempDir = async (): Promise<string> => {
  const value = await mkdtemp(path.join(os.tmpdir(), 'tomny-native-'));
  temporary.push(value);
  return value;
};
afterEach(async () => {
  await Promise.all(temporary.splice(0).map((value) => rm(value, { recursive: true, force: true })));
});

describe('native ZIP service', () => {
  it('creates a readable archive from inline and source entries', async () => {
    const root = await tempDir();
    const source = path.join(root, 'source.txt');
    const target = path.join(root, 'result.zip');
    await writeFile(source, 'source value');
    await new NativeZipService().create({
      path: target,
      files: [
        { name: 'inline.txt', content: 'inline value' },
        { name: 'nested/source.txt', source_path: source },
      ],
    });
    const archive = await JSZip.loadAsync(await readFile(target));
    expect(await archive.file('inline.txt')?.async('string')).toBe('inline value');
    expect(await archive.file('nested/source.txt')?.async('string')).toBe('source value');
  });
  it('rejects traversal names and reports unknown cancellation', async () => {
    const root = await tempDir();
    const service = new NativeZipService();
    await expect(
      service.create({ path: path.join(root, 'bad.zip'), files: [{ name: '../secret.txt', content: 'x' }] })
    ).rejects.toThrow('Unsafe archive entry');
    expect(service.cancel('missing')).toBe(false);
  });
});

describe('native non-git snapshots', () => {
  it('classifies, stages and restores workspace changes', async () => {
    const root = await tempDir();
    const file = path.join(root, 'note.txt');
    const service = new NativeSnapshotService();
    await writeFile(file, 'before');
    await service.init(root);
    await writeFile(file, 'after');
    expect((await service.compare(root)).unstaged[0]?.operation).toBe('modify');
    await service.stage(root, file);
    expect((await service.compare(root)).staged).toHaveLength(1);
    await service.discard(root, file, 'modify');
    expect(await readFile(file, 'utf8')).toBe('before');
  });
  it('rejects staging before initialization', async () => {
    const root = await tempDir();
    await expect(new NativeSnapshotService().stage(root, path.join(root, 'x'))).rejects.toThrow(
      'Snapshot is not initialized'
    );
  });
});

describe('native skill catalog', () => {
  it('scans, imports and materializes selected skills', async () => {
    const root = await tempDir();
    const builtin = path.join(root, 'builtin');
    const user = path.join(root, 'user');
    const materialized = path.join(root, 'materialized');
    const skill = path.join(builtin, 'writer');
    await mkdir(skill, { recursive: true });
    await writeFile(path.join(skill, 'SKILL.md'), '---\nname: writer\ndescription: Writes reports\n---\n');
    const catalog = new NativeSkillCatalog(user, [builtin], materialized);
    expect((await catalog.list())[0]?.description).toBe('Writes reports');
    await catalog.import(skill);
    const result = await catalog.materialize('conversation/1', ['writer']);
    expect(result.skills).toHaveLength(1);
    expect(await readFile(path.join(result.skills[0].source_path, 'SKILL.md'), 'utf8')).toContain('Writes reports');
  });
  it('ignores missing scan roots', async () => {
    const root = await tempDir();
    const catalog = new NativeSkillCatalog(path.join(root, 'user'), [], path.join(root, 'out'));
    await expect(catalog.scan(path.join(root, 'missing'))).resolves.toEqual([]);
  });
});

describe('native MCP config scanner', () => {
  it('normalizes importable stdio and HTTP servers', async () => {
    const root = await tempDir();
    const file = path.join(root, 'mcp.json');
    await writeFile(
      file,
      JSON.stringify({
        mcpServers: { local: { command: 'node', args: ['server.js'] }, remote: { url: 'https://example.test/mcp' } },
      })
    );
    const groups = await new NativeMcpConfigScanner([{ source: 'test', file }]).scan();
    expect(groups[0].servers.map((server) => server.transport.type)).toEqual(['stdio', 'streamable_http']);
  });
  it('ignores invalid configuration instead of failing the full scan', async () => {
    const root = await tempDir();
    const file = path.join(root, 'invalid.json');
    await writeFile(file, '{');
    await expect(new NativeMcpConfigScanner([{ source: 'invalid', file }]).scan()).resolves.toEqual([]);
  });
});

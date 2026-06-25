import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileProjectRepo } from './fileProjectRepo';
import { createTrack } from '../shared/factory';

describe('FileProjectRepo', () => {
  let dir: string;
  let repo: FileProjectRepo;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'musicdaw-'));
    repo = new FileProjectRepo(dir);
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('creates, lists, opens and saves a project round-trip', async () => {
    const { project, path: folder } = await repo.create('My Song');
    expect(folder.endsWith('.daw')).toBe(true);

    const list = await repo.list();
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('My Song');

    project.tracks.push(createTrack('Drums'));
    await repo.save(folder, project);

    const reopened = await repo.open(folder);
    expect(reopened.tracks).toHaveLength(1);
    expect(reopened.tracks[0].name).toBe('Drums');
    expect(reopened.id).toBe(project.id);
  });

  it('removes a project folder', async () => {
    const { path: folder } = await repo.create('Trash Me');
    await repo.remove(folder);
    expect(await repo.list()).toHaveLength(0);
  });

  it('rejects opening an invalid project.json', async () => {
    const { path: folder } = await repo.create('Bad');
    await fs.writeFile(path.join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, name: 'x' }), 'utf8');
    await expect(repo.open(folder)).rejects.toThrow(/Invalid project/);
  });

  it('imports a sample into samples/ with a relative ref', async () => {
    const { path: folder } = await repo.create('Imports');
    const src = path.join(dir, 'kick.wav');
    await fs.writeFile(src, Buffer.from([0, 1, 2, 3]));

    const ref = await repo.importSample(folder, src);
    expect(ref.file).toBe('samples/kick.wav');
    const copied = await fs.readFile(path.join(folder, ref.file));
    expect(copied).toHaveLength(4);
  });

  it('does not clobber a same-named sample', async () => {
    const { path: folder } = await repo.create('Dup');
    const src = path.join(dir, 'snare.wav');
    await fs.writeFile(src, Buffer.from([9]));

    const first = await repo.importSample(folder, src);
    const second = await repo.importSample(folder, src);
    expect(first.file).toBe('samples/snare.wav');
    expect(second.file).not.toBe(first.file);
  });
});

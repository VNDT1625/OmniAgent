/**
 * Framework-agnostic smoke verifier for the core data layer.
 *
 * Why this exists: the real test specs use Vitest (see *.test.ts). While this
 * project lives nested inside the AionUi Vitest monorepo, the parent runner's
 * config/instance leaks into nested runs. To verify correctness without that
 * conflict, this script uses only node:assert and is executed directly by bun
 * (`bun run src/verify.ts`). Once musicdaw is a standalone repo, `vitest` runs
 * the .test.ts specs normally.
 */

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { createEffect, createPatternClip, createProject, createSample, createTrack } from './shared/factory';
import { migrateProject, needsMigration } from './shared/migrate';
import { CURRENT_SCHEMA_VERSION } from './shared/schema';
import { isValidProject, validateProject } from './shared/validate';
import { FileProjectRepo } from './main/fileProjectRepo';

let passed = 0;
const failures: string[] = [];

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(`${name}: ${(err as Error).message}`);
    console.log(`FAIL  ${name}`);
  }
}

async function main(): Promise<void> {
  await test('createProject yields a valid empty project', () => {
    const p = createProject('Demo');
    assert.equal(p.schemaVersion, CURRENT_SCHEMA_VERSION);
    assert.equal(p.name, 'Demo');
    assert.ok(p.tempo > 0);
    assert.equal(isValidProject(p), true);
  });

  await test('multitrack beat validates', () => {
    const project = createProject('Beat');
    const sample = createSample('samples/kick.wav', 'Kick', 0.4);
    project.samples.push(sample);
    const drums = createTrack('Drums', 'instrument', 0);
    drums.instrument = { kind: 'sampler', sampleId: sample.id };
    const clip = createPatternClip(0, 4);
    clip.steps = [
      { step: 0, sampleId: sample.id, velocity: 100 },
      { step: 4, sampleId: sample.id, velocity: 90 },
    ];
    drums.effects.push(createEffect('eq3'));
    drums.clips.push(clip);
    project.tracks.push(drums);
    assert.equal(isValidProject(project), true);
    assert.equal(project.tracks[0].clips[0].steps?.length, 2);
  });

  await test('tracks get distinct ids', () => {
    assert.notEqual(createTrack('A').id, createTrack('B').id);
  });

  await test('validate rejects non-object', () => {
    assert.ok(validateProject(null).includes('project must be an object'));
  });

  await test('validate flags wrong schema version', () => {
    const p = { ...createProject('x'), schemaVersion: 999 };
    assert.ok(validateProject(p).some((e) => e.includes('schemaVersion')));
  });

  await test('validate flags non-positive tempo', () => {
    const p = { ...createProject('x'), tempo: 0 };
    assert.ok(validateProject(p).some((e) => e.includes('tempo')));
  });

  await test('validate reports nested clip path', () => {
    const p = createProject('x');
    const t = createTrack('T');
    (t.clips as unknown[]).push({ id: 'c1', startBeat: 0, lengthBeat: 1, kind: 'bogus' });
    p.tracks.push(t);
    assert.ok(validateProject(p).some((e) => e.includes('tracks[0].clips[0].kind')));
  });

  await test('migrate: current version is a no-op', () => {
    const p = createProject('x') as unknown as Record<string, unknown>;
    assert.equal(needsMigration(p), false);
    assert.equal(migrateProject(p), p);
  });

  await test('migrate: future version throws', () => {
    assert.throws(() => migrateProject({ schemaVersion: CURRENT_SCHEMA_VERSION + 1 }), /newer than supported/);
  });

  await test('migrate: missing migrator throws', () => {
    assert.throws(() => migrateProject({ schemaVersion: 0 }), /No migrator/);
  });

  // ---- FileProjectRepo (filesystem) ----
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'musicdaw-'));
  try {
    const repo = new FileProjectRepo(dir);

    await test('repo: create/list/save/open round-trip', async () => {
      const { project, path: folder } = await repo.create('My Song');
      assert.ok(folder.endsWith('.daw'));
      const list = await repo.list();
      assert.equal(list.length, 1);
      assert.equal(list[0].name, 'My Song');
      project.tracks.push(createTrack('Drums'));
      await repo.save(folder, project);
      const reopened = await repo.open(folder);
      assert.equal(reopened.tracks.length, 1);
      assert.equal(reopened.tracks[0].name, 'Drums');
      assert.equal(reopened.id, project.id);
    });

    await test('repo: remove deletes folder', async () => {
      const { path: folder } = await repo.create('Trash Me');
      await repo.remove(folder);
      const names = (await repo.list()).map((s) => s.name);
      assert.ok(!names.includes('Trash Me'));
    });

    await test('repo: open rejects invalid project.json', async () => {
      const { path: folder } = await repo.create('Bad');
      await fs.writeFile(path.join(folder, 'project.json'), JSON.stringify({ schemaVersion: 1, name: 'x' }), 'utf8');
      await assert.rejects(() => repo.open(folder), /Invalid project/);
    });

    await test('repo: importSample copies with relative ref', async () => {
      const { path: folder } = await repo.create('Imports');
      const src = path.join(dir, 'kick.wav');
      await fs.writeFile(src, Buffer.from([0, 1, 2, 3]));
      const ref = await repo.importSample(folder, src);
      assert.equal(ref.file, 'samples/kick.wav');
      const copied = await fs.readFile(path.join(folder, ref.file));
      assert.equal(copied.length, 4);
    });

    await test('repo: importSample does not clobber same name', async () => {
      const { path: folder } = await repo.create('Dup');
      const src = path.join(dir, 'snare.wav');
      await fs.writeFile(src, Buffer.from([9]));
      const first = await repo.importSample(folder, src);
      const second = await repo.importSample(folder, src);
      assert.equal(first.file, 'samples/snare.wav');
      assert.notEqual(second.file, first.file);
    });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(` - ${f}`);
    process.exit(1);
  }
}

void main();

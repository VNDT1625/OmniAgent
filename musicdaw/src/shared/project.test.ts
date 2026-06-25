import { describe, expect, it } from 'vitest';

import { createEffect, createPatternClip, createProject, createSample, createTrack } from './factory';
import { migrateProject, needsMigration } from './migrate';
import { CURRENT_SCHEMA_VERSION } from './schema';
import { isValidProject, validateProject } from './validate';

describe('factory', () => {
  it('creates a valid empty project', () => {
    const p = createProject('Demo');
    expect(p.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(p.name).toBe('Demo');
    expect(p.tempo).toBeGreaterThan(0);
    expect(isValidProject(p)).toBe(true);
  });

  it('builds a multitrack beat that validates', () => {
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

    expect(isValidProject(project)).toBe(true);
    expect(project.tracks[0].clips[0].steps).toHaveLength(2);
  });

  it('assigns distinct ids', () => {
    const a = createTrack('A');
    const b = createTrack('B');
    expect(a.id).not.toBe(b.id);
  });
});

describe('validate', () => {
  it('rejects a non-object', () => {
    expect(validateProject(null)).toContain('project must be an object');
  });

  it('flags a wrong schema version', () => {
    const p = { ...createProject('x'), schemaVersion: 999 };
    const errors = validateProject(p);
    expect(errors.some((e) => e.includes('schemaVersion'))).toBe(true);
  });

  it('flags a non-positive tempo', () => {
    const p = { ...createProject('x'), tempo: 0 };
    expect(validateProject(p).some((e) => e.includes('tempo'))).toBe(true);
  });

  it('reports nested clip errors with a path', () => {
    const p = createProject('x');
    const t = createTrack('T');
    // @ts-expect-error intentionally invalid clip kind
    t.clips.push({ id: 'c1', startBeat: 0, lengthBeat: 1, kind: 'bogus' });
    p.tracks.push(t);
    expect(validateProject(p).some((e) => e.includes('tracks[0].clips[0].kind'))).toBe(true);
  });
});

describe('migrate', () => {
  it('treats a current-version project as not needing migration', () => {
    const p = createProject('x') as unknown as Record<string, unknown>;
    expect(needsMigration(p)).toBe(false);
    expect(migrateProject(p)).toBe(p);
  });

  it('throws for a future schema version', () => {
    const p = { schemaVersion: CURRENT_SCHEMA_VERSION + 1 };
    expect(() => migrateProject(p)).toThrow(/newer than supported/);
  });

  it('throws when no migrator exists for an old version', () => {
    const p = { schemaVersion: 0 };
    expect(() => migrateProject(p)).toThrow(/No migrator/);
  });
});

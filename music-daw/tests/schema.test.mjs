/**
 * Tests for the project schema, validation, and migration.
 *
 * Uses Node's built-in test runner (node:test) + assert so the scaffold has
 * zero external dependencies and can be verified immediately. We import the
 * compiled-equivalent logic by re-implementing nothing — the .ts sources are
 * plain ESM and run under Node via the loader when transpiled; for this
 * dependency-free scaffold we test the JS-portable logic by importing the
 * mirrored .mjs build. See run note in tests/README.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { createProjectSchema, createTrack, CURRENT_SCHEMA_VERSION } from '../build/shared/schema.js';
import { validateProject } from '../build/shared/validate.js';
import { migrateProject } from '../build/shared/migrate.js';

test('createProjectSchema produces a valid default project', () => {
  const p = createProjectSchema('My Song');
  assert.equal(p.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(p.name, 'My Song');
  assert.equal(p.tempo, 120);
  assert.deepEqual(p.timeSignature, [4, 4]);
  assert.ok(Array.isArray(p.tracks));
  const result = validateProject(p);
  assert.equal(result.ok, true);
});

test('createTrack defaults are valid inside a project', () => {
  const p = createProjectSchema('S');
  p.tracks.push(createTrack('Drums'));
  const result = validateProject(p);
  assert.equal(result.ok, true);
});

test('validateProject rejects bad pan', () => {
  const p = createProjectSchema('S');
  const t = createTrack('Bad');
  t.pan = 5; // out of range
  p.tracks.push(t);
  const result = validateProject(p);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('pan')));
});

test('validateProject rejects non-object', () => {
  assert.equal(validateProject(null).ok, false);
  assert.equal(validateProject(42).ok, false);
});

test('validateProject rejects non-positive tempo', () => {
  const p = createProjectSchema('S');
  p.tempo = 0;
  const result = validateProject(p);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => e.includes('tempo')));
});

test('migrateProject is a no-op for current version', () => {
  const p = createProjectSchema('S');
  const { project, migratedFrom, migratedTo } = migrateProject(p);
  assert.equal(migratedFrom, CURRENT_SCHEMA_VERSION);
  assert.equal(migratedTo, CURRENT_SCHEMA_VERSION);
  assert.equal(project.name, 'S');
});

test('migrateProject throws for a future version', () => {
  const p = createProjectSchema('S');
  p.schemaVersion = 999;
  assert.throws(() => migrateProject(p), /newer than supported/);
});

/**
 * Forward-only schema migration.
 *
 * Each step upgrades a project from version N to N+1. When you bump
 * CURRENT_SCHEMA_VERSION, add a migrator here keyed by the *source* version.
 * `migrateProject` applies steps in sequence until the project reaches the
 * current version, so old files always open.
 */

import { CURRENT_SCHEMA_VERSION } from './schema';

type AnyProject = Record<string, unknown>;
type Migrator = (project: AnyProject) => AnyProject;

/**
 * Registry of migrators. Key = source version. Example for the future:
 *   1: (p) => ({ ...p, schemaVersion: 2, swing: 0 }),
 */
const MIGRATORS: Record<number, Migrator> = {};

export function needsMigration(project: AnyProject): boolean {
  return typeof project.schemaVersion === 'number' && project.schemaVersion < CURRENT_SCHEMA_VERSION;
}

export function migrateProject(input: AnyProject): AnyProject {
  let project = input;
  let version = typeof project.schemaVersion === 'number' ? project.schemaVersion : 0;

  if (version > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Project schemaVersion ${version} is newer than supported ${CURRENT_SCHEMA_VERSION}. Update the app.`
    );
  }

  while (version < CURRENT_SCHEMA_VERSION) {
    const migrator = MIGRATORS[version];
    if (!migrator) {
      throw new Error(`No migrator registered for schema version ${version}`);
    }
    project = migrator(project);
    const next = typeof project.schemaVersion === 'number' ? project.schemaVersion : version;
    if (next <= version) {
      throw new Error(`Migrator for version ${version} did not advance schemaVersion`);
    }
    version = next;
  }

  return project;
}

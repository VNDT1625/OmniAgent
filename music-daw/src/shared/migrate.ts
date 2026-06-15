/**
 * Schema migration pipeline.
 *
 * Loaded project files may have been written by an older app version. Each
 * migration step bumps the schema by exactly one version so upgrades are
 * incremental and testable. `migrateProject` runs every step needed to bring a
 * file up to CURRENT_SCHEMA_VERSION.
 *
 * When adding a new schema version:
 *   1. bump CURRENT_SCHEMA_VERSION in schema.ts
 *   2. add a `migrations[N]` entry that upgrades from version N to N+1
 */

import { CURRENT_SCHEMA_VERSION, type ProjectSchema } from './schema.js';

type AnyProject = Record<string, unknown>;

/** migrations[n] upgrades a project from schemaVersion n to n+1. */
const migrations: Record<number, (p: AnyProject) => AnyProject> = {
  // Example placeholder for the first future migration (v1 -> v2):
  // 1: (p) => ({ ...p, schemaVersion: 2, newField: defaultValue }),
};

export type MigrateResult = {
  project: ProjectSchema;
  migratedFrom: number;
  migratedTo: number;
};

export const migrateProject = (data: AnyProject): MigrateResult => {
  const startVersion = typeof data.schemaVersion === 'number' ? data.schemaVersion : 0;

  if (startVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Project schemaVersion ${startVersion} is newer than supported ${CURRENT_SCHEMA_VERSION}. ` +
        'Please update the application.'
    );
  }

  let current: AnyProject = data;
  let version = startVersion;

  while (version < CURRENT_SCHEMA_VERSION) {
    const step = migrations[version];
    if (!step) {
      throw new Error(`No migration step from schemaVersion ${version} to ${version + 1}`);
    }
    current = step(current);
    version += 1;
  }

  return {
    project: current as ProjectSchema,
    migratedFrom: startVersion,
    migratedTo: version,
  };
};

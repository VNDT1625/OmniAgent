/**
 * Local project repository — the Supabase replacement.
 *
 * In the upstream `beets` base, project CRUD and sample uploads go through
 * Supabase (auth + Postgres + storage). For a desktop app we persist to the
 * local filesystem instead. Every Supabase call in the fork should be routed
 * to a single instance of this class so the cloud dependency is removed in one
 * place rather than scattered across the codebase.
 *
 * This file runs in the Electron MAIN process (Node.js APIs allowed). The
 * renderer talks to it through the typed IPC bridge — never directly.
 *
 * On-disk layout (one folder per project):
 *   <projectsDir>/<ProjectName>.daw/
 *     project.json
 *     samples/
 *     renders/
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createProjectSchema, type ProjectSchema, type SampleRef, createSampleRef } from '../shared/schema.js';
import { validateProject } from '../shared/validate.js';
import { migrateProject } from '../shared/migrate.js';

const PROJECT_FILE = 'project.json';
const SAMPLES_DIR = 'samples';
const RENDERS_DIR = 'renders';
const PROJECT_EXT = '.daw';

export type ProjectSummary = {
  name: string;
  folderPath: string;
  modifiedMs: number;
};

const sanitizeName = (name: string): string =>
  name
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\.+$/, '')
    .trim() || 'Untitled';

export class ProjectRepository {
  constructor(private readonly projectsDir: string) {}

  /** Ensure the root projects directory exists. */
  async init(): Promise<void> {
    await fs.mkdir(this.projectsDir, { recursive: true });
  }

  private folderFor(name: string): string {
    return path.join(this.projectsDir, `${sanitizeName(name)}${PROJECT_EXT}`);
  }

  /** Create a new project folder + project.json and return the schema. */
  async create(name: string): Promise<{ project: ProjectSchema; folderPath: string }> {
    const folderPath = this.folderFor(name);
    await fs.mkdir(path.join(folderPath, SAMPLES_DIR), { recursive: true });
    await fs.mkdir(path.join(folderPath, RENDERS_DIR), { recursive: true });

    const project = createProjectSchema(name);
    await this.writeProjectFile(folderPath, project);
    return { project, folderPath };
  }

  /** List all projects in the projects directory, newest first. */
  async list(): Promise<ProjectSummary[]> {
    let entries: string[];
    try {
      entries = await fs.readdir(this.projectsDir);
    } catch {
      return [];
    }

    const summaries: ProjectSummary[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(PROJECT_EXT)) continue;
      const folderPath = path.join(this.projectsDir, entry);
      const filePath = path.join(folderPath, PROJECT_FILE);
      try {
        const stat = await fs.stat(filePath);
        summaries.push({
          name: entry.slice(0, -PROJECT_EXT.length),
          folderPath,
          modifiedMs: stat.mtimeMs,
        });
      } catch {
        // Folder without a project.json — skip it.
      }
    }
    return summaries.toSorted((a, b) => b.modifiedMs - a.modifiedMs);
  }

  /** Open a project by folder path, validating and migrating as needed. */
  async open(folderPath: string): Promise<ProjectSchema> {
    const filePath = path.join(folderPath, PROJECT_FILE);
    const raw = await fs.readFile(filePath, 'utf-8');

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(`Project file is not valid JSON: ${filePath}`);
    }

    const { project } = migrateProject(parsed);

    const result = validateProject(project);
    if (!result.ok) {
      throw new Error(`Invalid project file ${filePath}:\n${result.errors.join('\n')}`);
    }
    return project;
  }

  /** Save a project (overwrites project.json atomically via temp file). */
  async save(folderPath: string, project: ProjectSchema): Promise<void> {
    const result = validateProject(project);
    if (!result.ok) {
      throw new Error(`Refusing to save invalid project:\n${result.errors.join('\n')}`);
    }
    await this.writeProjectFile(folderPath, project);
  }

  /** Delete a project folder and all its contents. */
  async delete(folderPath: string): Promise<void> {
    // Guard: only delete folders that look like a project to avoid accidents.
    if (!folderPath.endsWith(PROJECT_EXT)) {
      throw new Error(`Refusing to delete non-project folder: ${folderPath}`);
    }
    await fs.rm(folderPath, { recursive: true, force: true });
  }

  /** Import an external audio file into the project's samples/ folder. */
  async importSample(folderPath: string, sourceFile: string, displayName?: string): Promise<SampleRef> {
    const baseName = path.basename(sourceFile);
    const destRel = path.posix.join(SAMPLES_DIR, baseName);
    const destAbs = path.join(folderPath, SAMPLES_DIR, baseName);
    await fs.mkdir(path.join(folderPath, SAMPLES_DIR), { recursive: true });
    await fs.copyFile(sourceFile, destAbs);
    return createSampleRef(destRel, displayName ?? baseName);
  }

  private async writeProjectFile(folderPath: string, project: ProjectSchema): Promise<void> {
    const filePath = path.join(folderPath, PROJECT_FILE);
    const tmpPath = `${filePath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(project, null, 2), 'utf-8');
    await fs.rename(tmpPath, filePath);
  }
}

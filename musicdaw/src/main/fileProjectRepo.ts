/**
 * Node/Electron-main implementation of ProjectRepo backed by the local
 * filesystem. This is the concrete replacement for beets' Supabase backend.
 *
 * NOTE: Node-only module. Do not import from the renderer; reach it through
 * the preload IPC bridge instead.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';

import { migrateProject, needsMigration } from '../shared/migrate';
import type { ImportedSampleRef, ProjectRepo, ProjectSummary } from '../shared/projectRepo';
import { createProject } from '../shared/factory';
import { isValidProject, validateProject } from '../shared/validate';
import type { Project } from '../shared/schema';

const PROJECT_FILE = 'project.json';
const SAMPLES_DIR = 'samples';
const RENDERS_DIR = 'renders';
const PROJECT_EXT = '.daw';

function sanitizeName(name: string): string {
  const cleaned = name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim();
  return cleaned.length > 0 ? cleaned : 'Untitled';
}

export class FileProjectRepo implements ProjectRepo {
  constructor(private readonly projectsDir: string) {}

  private projectJsonPath(folder: string): string {
    return path.join(folder, PROJECT_FILE);
  }

  async list(): Promise<ProjectSummary[]> {
    await fs.mkdir(this.projectsDir, { recursive: true });
    const entries = await fs.readdir(this.projectsDir, { withFileTypes: true });
    const summaries: ProjectSummary[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.endsWith(PROJECT_EXT)) continue;
      const folder = path.join(this.projectsDir, entry.name);
      const jsonPath = this.projectJsonPath(folder);
      try {
        const [raw, stat] = await Promise.all([fs.readFile(jsonPath, 'utf8'), fs.stat(jsonPath)]);
        const parsed = JSON.parse(raw) as { id?: string; name?: string };
        summaries.push({
          id: typeof parsed.id === 'string' ? parsed.id : entry.name,
          name: typeof parsed.name === 'string' ? parsed.name : entry.name.replace(PROJECT_EXT, ''),
          path: folder,
          updatedAtMs: stat.mtimeMs,
        });
      } catch {
        // Skip folders without a readable project.json.
      }
    }
    return summaries.toSorted((a, b) => b.updatedAtMs - a.updatedAtMs);
  }

  async create(name: string): Promise<{ project: Project; path: string }> {
    const safe = sanitizeName(name);
    const folder = path.join(this.projectsDir, `${safe}${PROJECT_EXT}`);
    await fs.mkdir(path.join(folder, SAMPLES_DIR), { recursive: true });
    await fs.mkdir(path.join(folder, RENDERS_DIR), { recursive: true });
    const project = createProject(safe);
    await this.save(folder, project);
    return { project, path: folder };
  }

  async open(folder: string): Promise<Project> {
    const raw = await fs.readFile(this.projectJsonPath(folder), 'utf8');
    let parsed = JSON.parse(raw) as Record<string, unknown>;
    if (needsMigration(parsed)) {
      parsed = migrateProject(parsed);
    }
    const errors = validateProject(parsed);
    if (errors.length > 0) {
      throw new Error(`Invalid project at ${folder}:\n - ${errors.join('\n - ')}`);
    }
    return parsed as unknown as Project;
  }

  async save(folder: string, project: Project): Promise<void> {
    if (!isValidProject(project)) {
      throw new Error(`Refusing to save invalid project:\n - ${validateProject(project).join('\n - ')}`);
    }
    await fs.mkdir(folder, { recursive: true });
    const tmp = this.projectJsonPath(folder) + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(project, null, 2), 'utf8');
    // Atomic-ish replace to avoid corrupting project.json on a crash mid-write.
    await fs.rename(tmp, this.projectJsonPath(folder));
  }

  async remove(folder: string): Promise<void> {
    await fs.rm(folder, { recursive: true, force: true });
  }

  async importSample(folder: string, sourceAbsolutePath: string): Promise<ImportedSampleRef> {
    const samplesDir = path.join(folder, SAMPLES_DIR);
    await fs.mkdir(samplesDir, { recursive: true });
    const base = path.basename(sourceAbsolutePath);
    let target = path.join(samplesDir, base);
    // Avoid clobbering an existing sample with the same name.
    if (await exists(target)) {
      const ext = path.extname(base);
      const stem = path.basename(base, ext);
      target = path.join(samplesDir, `${stem}-${Date.now()}${ext}`);
    }
    await fs.copyFile(sourceAbsolutePath, target);
    return { file: path.join(SAMPLES_DIR, path.basename(target)).split(path.sep).join('/') };
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

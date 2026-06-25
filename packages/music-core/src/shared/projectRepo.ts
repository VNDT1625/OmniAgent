/**
 * ProjectRepo contract.
 *
 * This is the seam that replaces beets' Supabase calls (auth, project CRUD,
 * sample upload). The renderer talks to this interface only — never to a
 * cloud SDK. In Electron the concrete implementation lives in the main process
 * (Node fs) and is reached through the preload IPC bridge.
 *
 * A `<Name>.daw/` folder is one project:
 *   <Name>.daw/
 *     project.json   (the Project)
 *     samples/       (imported / recorded audio)
 *     renders/       (export output)
 */

import type { Project } from './schema';

export type ProjectSummary = {
  id: string;
  name: string;
  path: string;
  updatedAtMs: number;
};

export type ImportedSampleRef = {
  /** Path relative to the project folder, e.g. "samples/kick.wav". */
  file: string;
};

export type ProjectRepo = {
  /** List known projects under the app's projects directory. */
  list(): Promise<ProjectSummary[]>;
  /** Create a new project folder + project.json; returns its path. */
  create(name: string): Promise<{ project: Project; path: string }>;
  /** Load and (if needed) migrate + validate a project by folder path. */
  open(path: string): Promise<Project>;
  /** Persist a project back to its folder. */
  save(path: string, project: Project): Promise<void>;
  /** Delete a project folder. */
  remove(path: string): Promise<void>;
  /** Copy an external audio file into the project's samples/ folder. */
  importSample(path: string, sourceAbsolutePath: string): Promise<ImportedSampleRef>;
};

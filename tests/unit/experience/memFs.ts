/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Shared in-memory filesystem for ExpBase engine tests. Satisfies both
 * ExperienceStoreFs and ProjectionFs (superset) so no real disk or live
 * Electron `app` is touched. `readdir` is derived from the flat path map.
 */

import * as path from 'node:path';
import type { ExperienceStoreFs } from '@/process/experience/experienceStore';
import type { ProjectionFs } from '@/process/experience/experienceProjection';

const enoent = (target: string): NodeJS.ErrnoException => {
  const error = new Error(`ENOENT: ${target}`) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
};

export type MemFs = ExperienceStoreFs & ProjectionFs & { files: Map<string, string> };

export const createMemFs = (): MemFs => {
  const files = new Map<string, string>();
  return {
    files,
    readFile: async (filePath) => {
      const content = files.get(filePath);
      if (content === undefined) {
        throw enoent(filePath);
      }
      return content;
    },
    writeFile: async (filePath, data) => {
      files.set(filePath, data);
    },
    rename: async (oldPath, newPath) => {
      const content = files.get(oldPath);
      if (content === undefined) {
        throw enoent(oldPath);
      }
      files.set(newPath, content);
      files.delete(oldPath);
    },
    mkdir: async (dirPath) => dirPath,
    rm: async (filePath) => {
      files.delete(filePath);
    },
    readdir: async (dirPath) => {
      const prefix = dirPath.endsWith(path.sep) ? dirPath : `${dirPath}${path.sep}`;
      const names = new Set<string>();
      let found = false;
      for (const key of files.keys()) {
        if (key.startsWith(prefix)) {
          found = true;
          const name = key.slice(prefix.length).split(path.sep)[0];
          if (name.length > 0) {
            names.add(name);
          }
        }
      }
      if (!found) {
        throw enoent(dirPath);
      }
      return [...names];
    },
  };
};

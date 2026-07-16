/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/company/memoryStore — the file-based, per-agent
 * soul.md / memory.md store for the agent company model (Requirement 3.4).
 * Uses an in-memory fs so no real disk or live Electron `app` is touched.
 */

import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CloudStorageProvider, MemoryStoreFs } from '@/process/company/memoryStore';
import { createMemoryStore } from '@/process/company/memoryStore';

/**
 * In-memory {@link MemoryStoreFs} so tests never touch real disk or a live
 * Electron `app`. Models a flat path→contents map with directory tracking.
 */
const createMemFs = (): MemoryStoreFs & { files: Map<string, string>; dirs: Set<string> } => {
  const files = new Map<string, string>();
  const dirs = new Set<string>();
  return {
    files,
    dirs,
    readFile: async (filePath) => {
      const content = files.get(filePath);
      if (content === undefined) {
        const error = new Error(`ENOENT: ${filePath}`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      return content;
    },
    writeFile: async (filePath, data) => {
      files.set(filePath, data);
    },
    rename: async (oldPath, newPath) => {
      const content = files.get(oldPath);
      if (content === undefined) {
        const error = new Error(`ENOENT: ${oldPath}`) as NodeJS.ErrnoException;
        error.code = 'ENOENT';
        throw error;
      }
      files.set(newPath, content);
      files.delete(oldPath);
    },
    mkdir: async (dirPath) => {
      dirs.add(dirPath);
      return dirPath;
    },
  };
};

const ROOT = path.join('test-root');

describe('createMemoryStore', () => {
  it('resolves the agent directory under <root>/<companyId>/agents/<agentId>', async () => {
    const fsImpl = createMemFs();
    const store = createMemoryStore({ companyId: 'acme', localRootDir: ROOT, fs: fsImpl });

    const dir = await store.getAgentDir('president');

    expect(dir).toBe(path.join(ROOT, 'acme', 'agents', 'president'));
  });

  it('returns empty strings for soul/memory before anything is written', async () => {
    const fsImpl = createMemFs();
    const store = createMemoryStore({ companyId: 'acme', localRootDir: ROOT, fs: fsImpl });

    expect(await store.readSoul('a1')).toBe('');
    expect(await store.readMemory('a1')).toBe('');
    expect(await store.readAll('a1')).toEqual({ agentId: 'a1', soul: '', memory: '' });
  });

  it('ensureAgent seeds empty soul.md and memory.md', async () => {
    const fsImpl = createMemFs();
    const store = createMemoryStore({ companyId: 'acme', localRootDir: ROOT, fs: fsImpl });

    await store.ensureAgent('a1');
    const agentDir = path.join(ROOT, 'acme', 'agents', 'a1');

    expect(fsImpl.files.has(path.join(agentDir, 'soul.md'))).toBe(true);
    expect(fsImpl.files.has(path.join(agentDir, 'memory.md'))).toBe(true);
  });

  it('writeSoul / readSoul round-trips content', async () => {
    const fsImpl = createMemFs();
    const store = createMemoryStore({ companyId: 'acme', localRootDir: ROOT, fs: fsImpl });

    await store.writeSoul('a1', '# Role: President\nKeeps the company aligned.');

    expect(await store.readSoul('a1')).toBe('# Role: President\nKeeps the company aligned.');
  });

  it('writeMemory / readMemory round-trips content', async () => {
    const fsImpl = createMemFs();
    const store = createMemoryStore({ companyId: 'acme', localRootDir: ROOT, fs: fsImpl });

    await store.writeMemory('a1', 'Compacted summary.');

    expect(await store.readMemory('a1')).toBe('Compacted summary.');
  });

  it('appendMemory adds newline-delimited entries', async () => {
    const fsImpl = createMemFs();
    const store = createMemoryStore({ companyId: 'acme', localRootDir: ROOT, fs: fsImpl });

    await store.appendMemory('a1', 'First lesson learned');
    await store.appendMemory('a1', 'Second lesson learned');

    expect(await store.readMemory('a1')).toBe('First lesson learned\nSecond lesson learned\n');
  });

  it('appendMemory does not double newlines when entry already ends with one', async () => {
    const fsImpl = createMemFs();
    const store = createMemoryStore({ companyId: 'acme', localRootDir: ROOT, fs: fsImpl });

    await store.appendMemory('a1', 'Entry with trailing newline\n');

    expect(await store.readMemory('a1')).toBe('Entry with trailing newline\n');
  });

  it('keeps two agents isolated within the same company', async () => {
    const fsImpl = createMemFs();
    const store = createMemoryStore({ companyId: 'acme', localRootDir: ROOT, fs: fsImpl });

    await store.writeSoul('a1', 'soul one');
    await store.writeSoul('a2', 'soul two');

    expect(await store.readSoul('a1')).toBe('soul one');
    expect(await store.readSoul('a2')).toBe('soul two');
  });

  it('rejects unsafe companyId at construction time', () => {
    expect(() => createMemoryStore({ companyId: '../escape', localRootDir: ROOT })).toThrow(/Invalid companyId/);
  });

  it('rejects unsafe agentId on access', async () => {
    const fsImpl = createMemFs();
    const store = createMemoryStore({ companyId: 'acme', localRootDir: ROOT, fs: fsImpl });

    await expect(store.readSoul('../../etc/passwd')).rejects.toThrow(/Invalid agentId/);
    await expect(store.getAgentDir('a/b')).rejects.toThrow(/Invalid agentId/);
  });

  describe("storageLocation 'cloud'", () => {
    it('resolves the companies root through the cloud provider and triggers sync', async () => {
      const fsImpl = createMemFs();
      const synced: string[] = [];
      const cloudProvider: CloudStorageProvider = {
        resolveRoot: async () => path.join('cloud-root'),
        sync: async (filePath) => {
          synced.push(filePath);
        },
      };
      const store = createMemoryStore({ companyId: 'acme', storageLocation: 'cloud', cloudProvider, fs: fsImpl });

      const dir = await store.getAgentDir('a1');
      await store.writeSoul('a1', 'cloud soul');

      expect(dir).toBe(path.join('cloud-root', 'companies', 'acme', 'agents', 'a1'));
      expect(await store.readSoul('a1')).toBe('cloud soul');
      expect(synced).toEqual([path.join('cloud-root', 'companies', 'acme', 'agents', 'a1', 'soul.md')]);
    });

    it('throws when cloud storage is selected without a provider', async () => {
      const fsImpl = createMemFs();
      const store = createMemoryStore({ companyId: 'acme', storageLocation: 'cloud', fs: fsImpl });

      await expect(store.readSoul('a1')).rejects.toThrow(/requires a cloudProvider/);
    });
  });
});

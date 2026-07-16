import { execSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveBinaryPath } from '../../../packages/desktop/src/process/backend/binaryResolver';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readdirSync: vi.fn(),
}));

const originalResourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
const originalDefaultApp = (process as NodeJS.Process & { defaultApp?: boolean }).defaultApp;

function setDefaultApp(defaultApp: boolean | undefined): void {
  Object.defineProperty(process, 'defaultApp', {
    configurable: true,
    value: defaultApp,
  });
}

function setResourcesPath(resourcesPath: string | undefined): void {
  Object.defineProperty(process, 'resourcesPath', {
    configurable: true,
    value: resourcesPath,
  });
}

function dirEntry(name: string, isDirectory = false): ReturnType<typeof readdirSync>[number] {
  return {
    name,
    isDirectory: () => isDirectory,
  } as unknown as ReturnType<typeof readdirSync>[number];
}

describe('resolveBinaryPath', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    setResourcesPath(originalResourcesPath);
    setDefaultApp(originalDefaultApp);
  });

  it('attaches bundled path diagnostics when Tomny Core cannot be resolved', () => {
    const resourcesPath = '/app/resources';
    const runtimeKey = `${process.platform}-${process.arch}`;
    const binaryName = process.platform === 'win32' ? 'tomny-core.exe' : 'tomny-core';
    const bundledDir = join(resourcesPath, 'bundled-tomny-core');
    const runtimeDir = join(bundledDir, runtimeKey);
    const checkedBundledPath = join(runtimeDir, binaryName);

    setResourcesPath(resourcesPath);
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readdirSync).mockImplementation((path) => {
      if (path === resourcesPath) return [dirEntry('bundled-tomny-core', true)];
      if (path === runtimeDir) return [dirEntry('manifest.json')];
      return [] as ReturnType<typeof readdirSync>;
    });
    vi.mocked(execSync).mockImplementation(() => {
      throw new Error('not found on PATH');
    });

    expect(() => resolveBinaryPath()).toThrow('Cannot find "tomny-core" binary');

    try {
      resolveBinaryPath();
    } catch (error) {
      expect(error).toMatchObject({
        name: 'BackendBinaryResolveError',
        diagnostics: expect.objectContaining({
          resourcesPath,
          runtimeKey,
          binaryName,
          checkedBundledPath,
          bundledDirExists: false,
          runtimeDirExists: false,
          resourcesDirEntries: ['bundled-tomny-core/'],
          runtimeDirEntries: ['manifest.json'],
          pathLookupCommand: process.platform === 'win32' ? 'where tomny-core' : 'which tomny-core',
          pathLookupError: expect.stringContaining('not found on PATH'),
        }),
      });
    }
  });

  it('prefers the isolated project backend while Electron runs in development mode', () => {
    const runtimeKey = `${process.platform}-${process.arch}`;
    const binaryName = process.platform === 'win32' ? 'tomny-core.exe' : 'tomny-core';
    const preparedSourceBuild = join(process.cwd(), 'resources', 'bundled-tomny-core', runtimeKey, binaryName);

    setDefaultApp(true);
    vi.mocked(existsSync).mockImplementation((candidate) => candidate === preparedSourceBuild);

    expect(resolveBinaryPath()).toBe(preparedSourceBuild);
    expect(execSync).not.toHaveBeenCalled();
  });
});

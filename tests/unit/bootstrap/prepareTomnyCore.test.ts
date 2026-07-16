/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const {
  gitRepositoryArgs,
  manifestMatches,
  patchTomnyBranding,
  patchTomnyCompatibility,
  repairCachedRepository,
  stagedBinaryName,
  targetTriple,
}: {
  gitRepositoryArgs: (sourceDir: string) => string[];
  manifestMatches: (path: string, version: string, commit: string) => boolean;
  patchTomnyBranding: (sourceDir: string) => void;
  patchTomnyCompatibility: (sourceDir: string) => void;
  repairCachedRepository: (sourceDir: string) => void;
  stagedBinaryName: (platform: string) => string;
  targetTriple: (platform: string, arch: string) => string | null;
} = require('../../../packages/shared-scripts/src/prepare-tomny-core.js');

describe('Tomny Core source builder', () => {
  it('maps supported release targets and rejects unknown targets', () => {
    expect(targetTriple('win32', 'x64')).toBe('x86_64-pc-windows-msvc');
    expect(targetTriple('linux', 'arm64')).toBe('aarch64-unknown-linux-gnu');
    expect(targetTriple('freebsd', 'x64')).toBeNull();
    expect(stagedBinaryName('win32')).toBe('tomny-core.exe');
  });

  it('only accepts current source-built manifests pinned to the requested revision', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tomny-core-manifest-'));
    const manifestPath = join(directory, 'manifest.json');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 'v0.1.16',
        sourceCommit: 'abc',
        sourceType: 'source-build',
        buildRecipeVersion: 3,
      })
    );

    expect(manifestMatches(manifestPath, 'v0.1.16', 'abc')).toBe(true);
    expect(manifestMatches(manifestPath, 'v0.1.16', 'different')).toBe(false);
  });

  it('brands the executable, command, and log without rewriting the compatibility API', () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'tomny-core-branding-'));
    const appDir = join(sourceDir, 'crates', 'aionui-app', 'src');
    const bootstrapDir = join(appDir, 'bootstrap');
    mkdirSync(bootstrapDir, { recursive: true });
    const cliPath = join(appDir, 'cli.rs');
    const tracingPath = join(bootstrapDir, 'tracing_init.rs');
    const cargoPath = join(sourceDir, 'crates', 'aionui-app', 'Cargo.toml');
    writeFileSync(cliPath, '#[command(name = "aioncore", about = "AionUi Backend Server", version)]');
    writeFileSync(tracingPath, '.filename_suffix("aioncore.log")');
    writeFileSync(cargoPath, '[[bin]]\r\nname = "aioncore"\r\npath = "src/main.rs"\r\n');

    patchTomnyBranding(sourceDir);

    expect(readFileSync(cliPath, 'utf8')).toContain('name = "tomny-core"');
    expect(readFileSync(tracingPath, 'utf8')).toContain('tomny-core.log');
    expect(readFileSync(cargoPath, 'utf8')).toContain('name = "tomny-core"');
  });

  it('normalizes file API relative paths on Windows source checkouts', () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'tomny-core-compatibility-'));
    const fileDir = join(sourceDir, 'crates', 'aionui-file', 'src');
    mkdirSync(fileDir, { recursive: true });
    const servicePath = join(fileDir, 'service.rs');
    writeFileSync(
      servicePath,
      'let relative_path = path.strip_prefix(root).unwrap_or(&path).to_string_lossy().into_owned();\r\n' +
        'let relative_path = canonical\r\n            .to_string_lossy()\r\n            .into_owned();\r\n'
    );

    patchTomnyCompatibility(sourceDir);

    const patched = readFileSync(servicePath, 'utf8');
    expect(patched).toContain('replace(\'\\\\\', "/")');
    expect(patched).not.toContain('.into_owned();');
  });
  it('repairs restored Git metadata and pins commands to the intended checkout', () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'tomny-core-git-'));
    const gitDir = join(sourceDir, '.git');
    mkdirSync(join(gitDir, 'objects'), { recursive: true });
    writeFileSync(join(gitDir, 'HEAD'), 'ref: refs/heads/main\n');

    repairCachedRepository(sourceDir);

    expect(existsSync(join(gitDir, 'refs', 'heads'))).toBe(true);
    expect(existsSync(join(gitDir, 'refs', 'tags'))).toBe(true);
    expect(gitRepositoryArgs(sourceDir)).toEqual([`--git-dir=${gitDir}`, `--work-tree=${sourceDir}`]);
  });
});

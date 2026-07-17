/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
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
  manifestMatches: (path: string, binary: string, version: string, commit: string, triple: string) => boolean;
  patchTomnyBranding: (sourceDir: string) => void;
  patchTomnyCompatibility: (sourceDir: string) => void;
  repairCachedRepository: (sourceDir: string) => void;
  stagedBinaryName: (platform: string) => string;
  targetTriple: (platform: string, arch: string) => string | null;
} = require('../../../packages/shared-scripts/src/prepare-tomny-core.js');
const {
  assertPinnedCommit,
  normalizeRepositoryUrl,
  sealSourceCache,
  validateReusableSource,
}: {
  assertPinnedCommit: (commit: string) => void;
  normalizeRepositoryUrl: (repository: string) => string;
  sealSourceCache: (input: {
    sourceDir: string;
    identity: { actualCommit: string; sourceRepository: string; sourceTree: string };
    recipeIdentity: string;
  }) => { sourceHash: string };
  validateReusableSource: (input: {
    sourceDir: string;
    repository: string;
    commit: string;
    recipeIdentity: string;
  }) => { actualCommit: string; sourceRepository: string; sourceTree: string; sourceHash?: string };
} = require('../../../packages/shared-scripts/src/source-build-identity.js');

describe('Tomny Core source builder', () => {
  it('maps supported release targets and rejects unknown targets', () => {
    expect(targetTriple('win32', 'x64')).toBe('x86_64-pc-windows-msvc');
    expect(targetTriple('linux', 'arm64')).toBe('aarch64-unknown-linux-gnu');
    expect(targetTriple('freebsd', 'x64')).toBeNull();
    expect(stagedBinaryName('win32')).toBe('tomny-core.exe');
  });

  it('only accepts artifacts whose binary and full source identity match', () => {
    const directory = mkdtempSync(join(tmpdir(), 'tomny-core-manifest-'));
    const manifestPath = join(directory, 'manifest.json');
    const binaryPath = join(directory, 'tomny-core.exe');
    const commit = 'a'.repeat(40);
    writeFileSync(binaryPath, 'trusted-binary');
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 'v0.1.16',
        sourceCommit: commit,
        sourceRepository: 'https://github.com/VNDT1625/OmniAgent.git',
        sourceTree: 'b'.repeat(40),
        sourceHash: 'c'.repeat(64),
        binarySha256: '94bfbc5b9a95c1e17ffb07b413f68ccd74601c45f1ed1d71dfa6c76aeebd10d1',
        targetTriple: 'x86_64-pc-windows-msvc',
        sourceType: 'source-build',
        buildRecipeVersion: 4,
      })
    );

    expect(manifestMatches(manifestPath, binaryPath, 'v0.1.16', commit, 'x86_64-pc-windows-msvc')).toBe(true);
    writeFileSync(binaryPath, 'poisoned-binary');
    expect(manifestMatches(manifestPath, binaryPath, 'v0.1.16', commit, 'x86_64-pc-windows-msvc')).toBe(false);
  });

  it('rejects ambiguous repository URLs and abbreviated commits', () => {
    expect(() => normalizeRepositoryUrl('git@github.com:VNDT1625/OmniAgent.git')).toThrow('absolute HTTPS');
    expect(() => normalizeRepositoryUrl('https://user@example.com/repository.git')).toThrow('uncredentialed HTTPS');
    expect(() => assertPinnedCommit('abc123')).toThrow('full lowercase SHA-1');
  });

  it('seals a pinned checkout and fails closed after source or remote tampering', () => {
    const sourceDir = mkdtempSync(join(tmpdir(), 'tomny-source-identity-'));
    const repository = 'https://github.com/VNDT1625/OmniAgent.git';
    const sourcePath = join(sourceDir, 'source.txt');
    execFileSync('git', ['init', sourceDir]);
    writeFileSync(sourcePath, 'trusted source');
    execFileSync('git', ['-C', sourceDir, 'add', 'source.txt']);
    execFileSync('git', [
      '-C',
      sourceDir,
      '-c',
      'user.name=Tomny Test',
      '-c',
      'user.email=test@tomny.local',
      'commit',
      '-m',
      'fixture',
    ]);
    execFileSync('git', ['-C', sourceDir, 'remote', 'add', 'origin', repository]);
    const commit = execFileSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    writeFileSync(sourcePath, 'unproven local change');
    expect(() => validateReusableSource({ sourceDir, repository, commit, recipeIdentity: 'test-recipe' })).toThrow(
      'Unproven source cache'
    );
    writeFileSync(sourcePath, 'trusted source');
    const identity = validateReusableSource({ sourceDir, repository, commit, recipeIdentity: 'test-recipe' });
    const provenance = sealSourceCache({ sourceDir, identity, recipeIdentity: 'test-recipe' });

    expect(validateReusableSource({ sourceDir, repository, commit, recipeIdentity: 'test-recipe' }).sourceHash).toBe(
      provenance.sourceHash
    );
    expect(sealSourceCache({ sourceDir, identity, recipeIdentity: 'test-recipe' }).sourceHash).toBe(
      provenance.sourceHash
    );
    writeFileSync(sourcePath, 'poisoned source');
    expect(() => validateReusableSource({ sourceDir, repository, commit, recipeIdentity: 'test-recipe' })).toThrow(
      'potentially poisoned'
    );
    writeFileSync(sourcePath, 'trusted source');
    execFileSync('git', ['-C', sourceDir, 'remote', 'set-url', 'origin', 'https://github.com/attacker/repository.git']);
    expect(() => validateReusableSource({ sourceDir, repository, commit, recipeIdentity: 'test-recipe' })).toThrow(
      'repository mismatch'
    );
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

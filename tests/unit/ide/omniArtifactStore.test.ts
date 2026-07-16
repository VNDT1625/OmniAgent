/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createOmniArtifactStore } from '@/process/ide/mcp/omniArtifactStore';

const SESSION_ID = 'session-test';

let rootPath = '';
let tempPath = '';

const makeStore = (overrides: Partial<Parameters<typeof createOmniArtifactStore>[0]> = {}) =>
  createOmniArtifactStore({
    rootPath,
    now: () => new Date('2026-06-28T00:00:00.000Z'),
    newId: () => 'artifact-1',
    ...overrides,
  });

beforeEach(async () => {
  rootPath = await mkdtemp(path.join(os.tmpdir(), 'omni-artifacts-root-'));
  tempPath = await mkdtemp(path.join(os.tmpdir(), 'omni-artifacts-upload-'));
});

afterEach(async () => {
  await rm(rootPath, { recursive: true, force: true });
  await rm(tempPath, { recursive: true, force: true });
});

describe('omniArtifactStore', () => {
  it('imports a text artifact and stores metadata without applying it', async () => {
    const source = path.join(tempPath, 'large.md');
    await writeFile(source, '# Spec\n\nhello world', 'utf-8');
    const store = makeStore();

    const result = await store.importText({ sessionId: SESSION_ID, file: source, purpose: 'spec' });

    expect(result).toMatchObject({
      artifactId: 'artifact-1',
      purpose: 'spec',
      size: 19,
      preview: '# Spec\n\nhello world',
      createdAt: '2026-06-28T00:00:00.000Z',
    });
    expect(result.sha256).toHaveLength(64);
    expect(store.list(SESSION_ID)).toHaveLength(1);
  });

  it('imports text from a connector-resolved proxied mount path', async () => {
    const localSource = path.join(tempPath, 'snippet.txt');
    await writeFile(localSource, 'from connector mount', 'utf-8');
    const store = makeStore({
      resolveInputFile: async (file) => (file === '/mnt/data/snippet.txt' ? localSource : undefined),
    });

    const result = await store.importText({
      sessionId: SESSION_ID,
      file: '/mnt/data/snippet.txt',
      purpose: 'snippet',
    });

    expect(result.preview).toBe('from connector mount');
  });

  it('rejects text artifacts with unsupported extensions', async () => {
    const source = path.join(tempPath, 'payload.exe');
    await writeFile(source, 'not really an exe', 'utf-8');
    const store = makeStore();

    await expect(store.importText({ sessionId: SESSION_ID, file: source, purpose: 'snippet' })).rejects.toThrow(
      'Unsupported text artifact extension'
    );
  });

  it('rejects uploaded file references that the connector did not resolve', async () => {
    const store = makeStore();

    await expect(
      store.importText({ sessionId: SESSION_ID, file: 'file_00000000db607206961cb6eb36252316', purpose: 'snippet' })
    ).rejects.toThrow('Uploaded file was not resolved by connector runtime');
  });

  it('rejects connector mount paths that were not rewritten for Windows', async () => {
    const store = makeStore();

    await expect(
      store.importText({ sessionId: SESSION_ID, file: '/mnt/data/snippet.txt', purpose: 'snippet' })
    ).rejects.toThrow('Uploaded file was not resolved by connector runtime');
  });

  it('rejects missing local source files with a clear error', async () => {
    const store = makeStore();
    const missing = path.join(tempPath, 'missing.txt');

    await expect(store.importText({ sessionId: SESSION_ID, file: missing, purpose: 'snippet' })).rejects.toThrow(
      'file does not exist'
    );
  });

  it('rejects relative source path traversal', async () => {
    const store = makeStore();

    await expect(
      store.importText({ sessionId: SESSION_ID, file: '../secret.txt', purpose: 'snippet' })
    ).rejects.toThrow('file must not contain path traversal');
  });

  it('rejects target path traversal when applying an artifact', async () => {
    const source = path.join(tempPath, 'snippet.txt');
    await writeFile(source, 'replacement', 'utf-8');
    const store = makeStore();
    const imported = await store.importText({ sessionId: SESSION_ID, file: source, purpose: 'snippet' });

    await expect(
      store.applyEdit({
        sessionId: SESSION_ID,
        artifactId: imported.artifactId,
        targetPath: '../outside.txt',
        mode: 'replace_anchor',
        anchor: 'old',
      })
    ).rejects.toThrow('inside the workspace root');
  });

  it('dry-runs an anchor edit without changing the target file', async () => {
    const source = path.join(tempPath, 'snippet.txt');
    const target = path.join(rootPath, 'target.ts');
    await writeFile(source, 'newValue', 'utf-8');
    await writeFile(target, 'const value = oldValue;\n', 'utf-8');
    const store = makeStore();
    const imported = await store.importText({ sessionId: SESSION_ID, file: source, purpose: 'snippet' });

    const result = await store.applyEdit({
      sessionId: SESSION_ID,
      artifactId: imported.artifactId,
      targetPath: 'target.ts',
      mode: 'replace_anchor',
      anchor: 'oldValue',
      dryRun: true,
    });

    expect(result.ok).toBe(true);
    expect(result.changed).toBe(true);
    expect(result.diffPreview).toContain('- const value = oldValue;');
    expect(await readFile(target, 'utf-8')).toBe('const value = oldValue;\n');
  });

  it('applies an anchor edit when the anchor matches exactly once', async () => {
    const source = path.join(tempPath, 'snippet.txt');
    const target = path.join(rootPath, 'target.ts');
    await writeFile(source, 'newValue', 'utf-8');
    await writeFile(target, 'const value = oldValue;\n', 'utf-8');
    const writeTextFile = vi.fn(async (filePath: string, data: string) => {
      await writeFile(filePath, data, 'utf-8');
      return { ok: true, backupId: 'backup-1' };
    });
    const store = makeStore({ writeTextFile });
    const imported = await store.importText({ sessionId: SESSION_ID, file: source, purpose: 'snippet' });

    const result = await store.applyEdit({
      sessionId: SESSION_ID,
      artifactId: imported.artifactId,
      targetPath: 'target.ts',
      mode: 'replace_anchor',
      anchor: 'oldValue',
    });

    expect(writeTextFile).toHaveBeenCalledOnce();
    expect(result.backupId).toBe('backup-1');
    expect(await readFile(target, 'utf-8')).toBe('const value = newValue;\n');
  });

  it('imports an image asset into an allowed repo asset folder', async () => {
    const source = path.join(tempPath, 'product.png');
    await writeFile(source, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const store = makeStore();

    const result = await store.importMediaAsset({
      file: source,
      destPath: 'public/product.png',
      kind: 'image',
    });

    expect(result.ok).toBe(true);
    expect(result.mime).toBe('image/png');
    expect(result.size).toBe(4);
    expect(await readFile(path.join(rootPath, 'public', 'product.png'))).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  });

  it('imports an image asset from a connector-resolved proxied mount path', async () => {
    const localSource = path.join(tempPath, 'product.png');
    await writeFile(localSource, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const store = makeStore({
      resolveInputFile: async (file) => (file === '/mnt/data/product.png' ? localSource : undefined),
    });

    const result = await store.importMediaAsset({
      file: '/mnt/data/product.png',
      destPath: 'public/assets/product.png',
      kind: 'image',
    });

    expect(result.ok).toBe(true);
    expect(await readFile(path.join(rootPath, 'public', 'assets', 'product.png'))).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    );
  });

  it('imports media with a Unicode connector filename', async () => {
    const unicodeName = 'chú_cún_retriever_con_mới_dễ_thương.png';
    const localSource = path.join(tempPath, unicodeName);
    await writeFile(localSource, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const mountPath = `/mnt/data/${unicodeName}`;
    const store = makeStore({
      resolveInputFile: async (file) => (file === mountPath ? localSource : undefined),
    });

    const result = await store.importMediaAsset({
      file: mountPath,
      destPath: `public/assets/${unicodeName}`,
      kind: 'image',
    });

    expect(result.mime).toBe('image/png');
    expect(await readFile(path.join(rootPath, 'public', 'assets', unicodeName))).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    );
  });

  it('imports a video asset and returns duration metadata when available', async () => {
    const source = path.join(tempPath, 'demo.mp4');
    await writeFile(source, Buffer.from([0, 0, 0, 1]));
    const store = makeStore({ probeVideoDuration: async () => 30 });

    const result = await store.importMediaAsset({
      file: source,
      destPath: 'docs/assets/demo.mp4',
      kind: 'video',
    });

    expect(result.ok).toBe(true);
    expect(result.mime).toBe('video/mp4');
    expect(result.durationSeconds).toBe(30);
    expect(await readFile(path.join(rootPath, 'docs', 'assets', 'demo.mp4'))).toEqual(Buffer.from([0, 0, 0, 1]));
  });
});

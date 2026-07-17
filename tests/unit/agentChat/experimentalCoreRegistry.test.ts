/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { adapterCatalogPayload, hashAdapterCatalogPayload } from '@process/experimentalCore/catalog';
import {
  CORE_ADAPTER_DEFINITIONS,
  detectCoreTargets,
  loadCoreAdapterDefinitions,
  resolveExecutableOnPath,
} from '../../../packages/desktop/src/process/experimentalCore/coreRegistry';

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('direct core adapter registry', () => {
  it('contains the requested CLI families without routing through aioncore', () => {
    expect(CORE_ADAPTER_DEFINITIONS.map((definition) => definition.id)).toEqual(
      expect.arrayContaining([
        'tomny',
        'codex',
        'claude',
        'kiro',
        'antigravity',
        'cursor',
        'hermes',
        'openclaw',
        'opencode',
      ])
    );
  });

  it('marks executable-backed adapters runnable and keeps unsupported protocols visible', async () => {
    const resolveExecutable = vi.fn(async (candidates: string[]) =>
      candidates.includes('codex')
        ? 'C:\\Tools\\codex.exe'
        : candidates.includes('openclaw')
          ? 'C:\\Tools\\openclaw.exe'
          : null
    );

    const targets = await detectCoreTargets(resolveExecutable);
    const codex = targets.find((target) => target.id === 'codex');
    const openclaw = targets.find((target) => target.id === 'openclaw');

    expect(codex).toMatchObject({ available: true, protocol: 'codex-app-server' });
    expect(openclaw).toMatchObject({ available: true, detected: true, protocol: 'acp', args: ['acp'] });
  });

  it('rejects a bundled Tomny executable whose manifest hash is missing or tampered', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'bundled-tomny-cli-'));
    tempDirectories.push(directory);
    const runtimeDir = path.join(directory, 'bundled-tomny-cli', 'test-runtime');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(runtimeDir, { recursive: true });
    const binaryPath = path.join(runtimeDir, 'tomny.exe');
    await writeFile(binaryPath, 'trusted-binary');
    const binarySha256 = createHash('sha256').update('trusted-binary').digest('hex');
    await writeFile(path.join(runtimeDir, 'manifest.json'), JSON.stringify({ binarySha256 }));

    await expect(resolveExecutableOnPath([binaryPath])).resolves.toBe(binaryPath);
    await writeFile(binaryPath, 'tampered-binary');
    await expect(resolveExecutableOnPath([binaryPath])).resolves.toBeNull();
  });

  it('loads versioned CLI overrides without rebuilding the core', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tomny-adapters-'));
    tempDirectories.push(directory);
    const catalogPath = path.join(directory, 'catalog.json');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const draft = {
      schemaVersion: 1,
      revision: 'registry-r1',
      coreCompatibility: { min: '0.0.0', max: '99.0.0' },
      definitions: [
        {
          id: 'openclaw',
          name: 'OpenClaw Next',
          protocol: 'acp' as const,
          candidates: ['openclaw-next'],
          args: ['agent', 'acp'],
          detail: 'Updated outside the application bundle',
          runnable: true,
        },
      ],
    };
    const hashed = { ...draft, sha256: hashAdapterCatalogPayload(draft) };
    const catalog = {
      ...hashed,
      signature: sign(null, Buffer.from(adapterCatalogPayload(hashed)), privateKey).toString('base64'),
    };
    await writeFile(catalogPath, JSON.stringify(catalog));

    const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
    const definitions = await loadCoreAdapterDefinitions(catalogPath, publicKeyDer);

    expect(definitions.find((definition) => definition.id === 'openclaw')).toMatchObject({
      name: 'OpenClaw Next',
      candidates: ['openclaw-next'],
      args: ['agent', 'acp'],
    });
    expect(definitions.find((definition) => definition.id === 'tomny')).toBeDefined();
  });

  it('rejects unsigned external catalogs and missing trust roots', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'tomny-adapters-'));
    tempDirectories.push(directory);
    const catalogPath = path.join(directory, 'catalog.json');
    await writeFile(catalogPath, '[]');

    await expect(loadCoreAdapterDefinitions(catalogPath)).rejects.toThrow(/PUBLIC_KEY|public key/i);
    await expect(loadCoreAdapterDefinitions(catalogPath, 'invalid')).rejects.toThrow();
  });
});

import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const {
  generateReleaseProvenance,
  verifyBuildManifest,
} = require('../../../packages/shared-scripts/src/release-provenance.js');

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const fixture = async () => {
  const rootDir = await mkdtemp(path.join(tmpdir(), 'tomny-provenance-'));
  directories.push(rootDir);
  const outDir = path.join(rootDir, 'out');
  await writeFile(
    path.join(rootDir, 'package.json'),
    JSON.stringify({ name: 'tomny-test', version: '1.2.3', dependencies: { zod: '4.0.0' } })
  );
  await writeFile(path.join(rootDir, 'bun.lock'), 'lock-data');
  await writeFile(path.join(rootDir, 'artifact.exe'), 'ignored');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(outDir);
  await writeFile(path.join(outDir, 'Tomny.exe'), 'release-bytes');
  return { rootDir, outDir };
};

describe('release provenance', () => {
  it('writes a CycloneDX SBOM and hashes release artifacts', async () => {
    const paths = await fixture();
    const result = generateReleaseProvenance(paths);

    expect(result.sbom).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.5' });
    expect(result.manifest.artifacts).toEqual([expect.objectContaining({ path: 'Tomny.exe', size: 13 })]);
    expect(JSON.parse(await readFile(result.manifestPath, 'utf8')).sbom.sha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it('signs the manifest with Ed25519 and detects tampering', async () => {
    const paths = await fixture();
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const result = generateReleaseProvenance({
      ...paths,
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    });

    expect(verifyBuildManifest(result.manifest, publicKey)).toBe(true);
    expect(verifyBuildManifest({ ...result.manifest, version: 'tampered' }, publicKey)).toBe(false);
  });

  it('fails closed when release policy requires a signature without a key', async () => {
    const paths = await fixture();
    expect(() => generateReleaseProvenance({ ...paths, requireSignature: true })).toThrow(
      /SIGNING_PRIVATE_KEY|signing private key/i
    );
  });
});

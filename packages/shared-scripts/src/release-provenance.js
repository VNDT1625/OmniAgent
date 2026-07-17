/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');

const ARTIFACT_PATTERN = /\.(?:exe|msi|dmg|zip|7z|appimage|deb|rpm|blockmap|yml)$/iu;

const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
const stableJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
};

const sourceRevision = (rootDir) => {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  try {
    return childProcess
      .execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: rootDir,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
      .trim();
  } catch {
    return 'unknown';
  }
};

const timestamp = () => {
  const epoch = Number(process.env.SOURCE_DATE_EPOCH);
  return new Date(Number.isFinite(epoch) && epoch > 0 ? epoch * 1000 : Date.now()).toISOString();
};

const runtimeComponents = (packageJson) =>
  Object.entries({ ...packageJson.dependencies, ...packageJson.optionalDependencies })
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, version]) => ({
      type: 'library',
      name,
      version: String(version),
      purl: `pkg:npm/${name}@${version}`,
    }));

const readPrivateKey = (value) => {
  if (!value?.trim()) return undefined;
  const trimmed = value.trim();
  return trimmed.includes('BEGIN PRIVATE KEY')
    ? crypto.createPrivateKey(trimmed)
    : crypto.createPrivateKey({ key: Buffer.from(trimmed, 'base64'), format: 'der', type: 'pkcs8' });
};

const verifyBuildManifest = (manifest, publicKey) => {
  if (!manifest.signature?.value || manifest.signature.algorithm !== 'Ed25519') return false;
  const unsigned = { ...manifest };
  delete unsigned.signature;
  try {
    return crypto.verify(
      null,
      Buffer.from(stableJson(unsigned)),
      publicKey,
      Buffer.from(manifest.signature.value, 'base64')
    );
  } catch {
    return false;
  }
};

const generateReleaseProvenance = (options = {}) => {
  const rootDir = path.resolve(options.rootDir ?? path.join(__dirname, '../../..'));
  const outDir = path.resolve(options.outDir ?? path.join(rootDir, 'out'));
  const packageJson = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
  fs.mkdirSync(outDir, { recursive: true });

  const lockPath = path.join(rootDir, 'bun.lock');
  const sbom = {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${crypto.randomUUID()}`,
    version: 1,
    metadata: {
      timestamp: timestamp(),
      component: { type: 'application', name: packageJson.name, version: packageJson.version },
      properties: fs.existsSync(lockPath)
        ? [{ name: 'tomny:lockfile:sha256', value: sha256(fs.readFileSync(lockPath)) }]
        : [],
    },
    components: runtimeComponents(packageJson),
  };
  const sbomPath = path.join(outDir, 'tomny-sbom.cdx.json');
  fs.writeFileSync(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`, { mode: 0o600 });

  const artifacts = fs
    .readdirSync(outDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && ARTIFACT_PATTERN.test(entry.name) && entry.name !== path.basename(sbomPath))
    .map((entry) => {
      const filePath = path.join(outDir, entry.name);
      const bytes = fs.readFileSync(filePath);
      return { path: entry.name, size: bytes.length, sha256: sha256(bytes) };
    })
    .sort((left, right) => left.path.localeCompare(right.path));

  const manifest = {
    schemaVersion: 1,
    product: packageJson.name,
    version: packageJson.version,
    sourceRevision: sourceRevision(rootDir),
    generatedAt: timestamp(),
    sbom: { path: path.basename(sbomPath), sha256: sha256(fs.readFileSync(sbomPath)) },
    artifacts,
  };
  const privateKey = readPrivateKey(options.privateKey ?? process.env.TOMNY_RELEASE_SIGNING_PRIVATE_KEY);
  const requireSignature = options.requireSignature ?? process.env.TOMNY_RELEASE_REQUIRE_SIGNATURE === '1';
  if (requireSignature && !privateKey) {
    throw new Error('TOMNY_RELEASE_SIGNING_PRIVATE_KEY is required for signed release provenance.');
  }
  if (privateKey) {
    if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error('Release signing key must use Ed25519.');
    const publicKey = crypto.createPublicKey(privateKey);
    manifest.signature = {
      algorithm: 'Ed25519',
      keyId: sha256(publicKey.export({ type: 'spki', format: 'der' })).slice(0, 16),
      value: crypto.sign(null, Buffer.from(stableJson(manifest)), privateKey).toString('base64'),
    };
  }
  const manifestPath = path.join(outDir, 'tomny-build-manifest.json');
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return { manifest, manifestPath, sbom, sbomPath };
};

if (require.main === module) {
  const result = generateReleaseProvenance();
  console.log(`Release manifest: ${result.manifestPath}`);
  console.log(`CycloneDX SBOM: ${result.sbomPath}`);
}

module.exports = { generateReleaseProvenance, stableJson, verifyBuildManifest };

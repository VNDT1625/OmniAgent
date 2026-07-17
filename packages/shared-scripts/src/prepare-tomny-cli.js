/**
 * Build and stage the Tomny CLI runtime for desktop packaging.
 *
 * Tomny starts from the Apache-2.0 aionrs codebase at a pinned upstream commit.
 * The source is compiled locally after applying the Tomny product namespace;
 * the desktop runtime never launches or calls AionCore.
 */

const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  artifactManifestMatches,
  assertPinnedCommit,
  sealSourceCache,
  sha256File,
  validateReusableSource,
} = require('./source-build-identity');

const UPSTREAM_REPOSITORY = 'https://github.com/iOfficeAI/aionrs.git';
const SOURCE_PATCH_VERSION = 'tool-result-v2';
const SOURCE_PATCH = path.join(__dirname, 'tomny-tool-result.patch');
const SOURCE_PATCH_SHA256 = crypto.createHash('sha256').update(fs.readFileSync(SOURCE_PATCH)).digest('hex');
const RECIPE_IDENTITY = `tomny-cli-${SOURCE_PATCH_VERSION}-${SOURCE_PATCH_SHA256}`;

const targetTriple = (platform, arch) => {
  const targets = {
    'darwin-x64': 'x86_64-apple-darwin',
    'darwin-arm64': 'aarch64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'win32-x64': 'x86_64-pc-windows-msvc',
    'win32-arm64': 'aarch64-pc-windows-msvc',
  };
  return targets[`${platform}-${arch}`] || null;
};

const binaryName = (platform) => (platform === 'win32' ? 'tomny.exe' : 'tomny');

const walkTextFiles = (directory, files = []) => {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'target') continue;
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      walkTextFiles(fullPath, files);
    } else if (/\.(?:rs|toml|md)$/u.test(entry.name)) {
      files.push(fullPath);
    }
  }
  return files;
};

const patchTomnyBranding = (sourceDir) => {
  for (const filePath of walkTextFiles(sourceDir)) {
    const before = fs.readFileSync(filePath, 'utf8');
    let after = before.replaceAll('AionRS', 'Tomny').replaceAll('Aionrs', 'Tomny').replaceAll('aionrs', 'tomny');

    if (after !== before) fs.writeFileSync(filePath, after);
  }
};

const ensureSource = ({ version, commit }) => {
  const cacheRoot = path.join(os.tmpdir(), 'tomny-cli-source');
  const cacheKey = `${version}-${commit.slice(0, 12)}-${SOURCE_PATCH_SHA256.slice(0, 12)}`;
  const sourceDir = process.env.TOMNY_CLI_SOURCE_DIR || path.join(cacheRoot, cacheKey);
  if (!fs.existsSync(sourceDir)) {
    fs.mkdirSync(cacheRoot, { recursive: true });
    execFileSync('git', ['clone', '--depth', '1', '--branch', version, UPSTREAM_REPOSITORY, sourceDir], {
      stdio: 'inherit',
    });
  } else if (!fs.existsSync(path.join(sourceDir, '.git'))) {
    throw new Error(`Tomny CLI source cache is not a Git checkout: ${sourceDir}`);
  }

  return {
    sourceDir,
    identity: validateReusableSource({
      sourceDir,
      repository: UPSTREAM_REPOSITORY,
      commit,
      recipeIdentity: RECIPE_IDENTITY,
    }),
  };
};

const canApplyPatch = (sourceDir, args) => {
  try {
    execFileSync('git', ['-C', sourceDir, 'apply', ...args, SOURCE_PATCH], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const applyTomnyProtocolPatch = (sourceDir) => {
  if (canApplyPatch(sourceDir, ['--reverse', '--check'])) return;
  if (!canApplyPatch(sourceDir, ['--check'])) {
    throw new Error(`Tomny CLI protocol patch ${SOURCE_PATCH_VERSION} is incompatible with the selected source.`);
  }
  execFileSync('git', ['-C', sourceDir, 'apply', SOURCE_PATCH], { stdio: 'inherit' });
};

const copyLicense = (sourceDir, targetDir) => {
  const source = path.join(sourceDir, 'LICENSE');
  if (fs.existsSync(source)) {
    fs.copyFileSync(source, path.join(targetDir, 'THIRD_PARTY_LICENSE.tomny-cli.txt'));
  }
};

/**
 * Compile and stage a source-built Tomny CLI.
 *
 * @param {object} options
 * @param {string} options.projectRoot
 * @param {NodeJS.Platform} options.platform
 * @param {string} options.arch
 * @param {string} options.version
 * @param {string} options.commit
 */
const manifestMatches = (manifestPath, binaryPath, version, commit, triple) =>
  artifactManifestMatches({
    manifestPath,
    binaryPath,
    expected: {
      version,
      sourceCommit: commit,
      sourceRepository: UPSTREAM_REPOSITORY,
      sourceType: 'source-build',
      sourcePatchVersion: SOURCE_PATCH_VERSION,
      sourcePatchSha256: SOURCE_PATCH_SHA256,
      targetTriple: triple,
    },
  });

function prepareTomnyCli(options) {
  const { projectRoot, platform, arch, version, commit } = options;
  assertPinnedCommit(commit);
  const triple = targetTriple(platform, arch);
  if (!triple) throw new Error(`Unsupported Tomny CLI target: ${platform}-${arch}`);

  const runtimeKey = `${platform}-${arch}`;
  const stagedDir = path.join(projectRoot, 'resources', 'bundled-tomny-cli', runtimeKey);
  const stagedBinary = path.join(stagedDir, binaryName(platform));
  const stagedManifest = path.join(stagedDir, 'manifest.json');
  if (manifestMatches(stagedManifest, stagedBinary, version, commit, triple)) {
    console.log(`Tomny CLI already prepared: resources/bundled-tomny-cli/${runtimeKey}/${binaryName(platform)}`);
    return { prepared: true, cached: true, dir: stagedDir, sourceCommit: commit };
  }

  const { sourceDir, identity } = ensureSource({ version, commit });
  applyTomnyProtocolPatch(sourceDir);
  patchTomnyBranding(sourceDir);
  const provenance = sealSourceCache({ sourceDir, identity, recipeIdentity: RECIPE_IDENTITY });
  const actualCommit = identity.actualCommit;

  execFileSync('rustup', ['target', 'add', '--toolchain', 'stable', triple], { cwd: sourceDir, stdio: 'inherit' });
  execFileSync(
    'rustup',
    [
      'run',
      'stable',
      'cargo',
      'build',
      '--locked',
      '--release',
      '--target',
      triple,
      '--package',
      'aion-cli',
      '--bin',
      'tomny',
    ],
    { cwd: sourceDir, stdio: 'inherit', env: process.env }
  );

  const sourceBinary = path.join(sourceDir, 'target', triple, 'release', binaryName(platform));
  if (!fs.existsSync(sourceBinary)) throw new Error(`Tomny CLI build output was not found: ${sourceBinary}`);

  const targetDir = path.join(projectRoot, 'resources', 'bundled-tomny-cli', runtimeKey);
  fs.mkdirSync(targetDir, { recursive: true });
  const targetBinary = path.join(targetDir, binaryName(platform));
  fs.copyFileSync(sourceBinary, targetBinary);
  if (platform !== 'win32') fs.chmodSync(targetBinary, 0o755);
  copyLicense(sourceDir, targetDir);
  fs.writeFileSync(
    path.join(targetDir, 'manifest.json'),
    JSON.stringify(
      {
        name: 'Tomny CLI',
        version,
        sourceCommit: actualCommit,
        sourceRepository: UPSTREAM_REPOSITORY,
        sourceTree: provenance.sourceTree,
        sourceHash: provenance.sourceHash,
        sourceType: 'source-build',
        sourcePatchVersion: SOURCE_PATCH_VERSION,
        sourcePatchSha256: SOURCE_PATCH_SHA256,
        binarySha256: sha256File(targetBinary),
        targetTriple: triple,
        license: 'Apache-2.0',
        protocol: 'json-stream',
        builtAt: new Date().toISOString(),
      },
      null,
      2
    )
  );

  console.log(`Tomny CLI prepared: resources/bundled-tomny-cli/${runtimeKey}/${binaryName(platform)}`);
  return { prepared: true, dir: targetDir, sourceCommit: actualCommit };
}

module.exports = { manifestMatches, prepareTomnyCli };

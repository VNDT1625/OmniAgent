/**
 * Build and stage the Tomny CLI runtime for desktop packaging.
 *
 * Tomny starts from the Apache-2.0 aionrs codebase at a pinned upstream commit.
 * The source is compiled locally after applying the Tomny product namespace;
 * the desktop runtime never launches or calls AionCore.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const UPSTREAM_REPOSITORY = 'https://github.com/VNDT1625/aionrs.git';

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
  const sourceDir = process.env.TOMNY_CLI_SOURCE_DIR || path.join(cacheRoot, version);
  if (!fs.existsSync(sourceDir)) {
    fs.mkdirSync(cacheRoot, { recursive: true });
    execFileSync('git', ['clone', '--depth', '1', '--branch', version, UPSTREAM_REPOSITORY, sourceDir], {
      stdio: 'inherit',
    });
  }

  const actualCommit = execFileSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (commit && actualCommit !== commit) {
    throw new Error(`Tomny CLI source mismatch: expected ${commit}, received ${actualCommit}`);
  }
  return { sourceDir, actualCommit };
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
function prepareTomnyCli(options) {
  const { projectRoot, platform, arch, version, commit } = options;
  const triple = targetTriple(platform, arch);
  if (!triple) throw new Error(`Unsupported Tomny CLI target: ${platform}-${arch}`);

  const runtimeKey = `${platform}-${arch}`;
  const stagedDir = path.join(projectRoot, 'resources', 'bundled-tomny-cli', runtimeKey);
  const stagedBinary = path.join(stagedDir, binaryName(platform));
  const stagedManifest = path.join(stagedDir, 'manifest.json');
  if (fs.existsSync(stagedBinary) && fs.existsSync(stagedManifest)) {
    const manifest = JSON.parse(fs.readFileSync(stagedManifest, 'utf8'));
    if (manifest.sourceCommit === commit && manifest.version === version) {
      console.log(`Tomny CLI already prepared: resources/bundled-tomny-cli/${runtimeKey}/${binaryName(platform)}`);
      return { prepared: true, cached: true, dir: stagedDir, sourceCommit: commit };
    }
  }

  const { sourceDir, actualCommit } = ensureSource({ version, commit });
  patchTomnyBranding(sourceDir);

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

module.exports = { prepareTomnyCli };

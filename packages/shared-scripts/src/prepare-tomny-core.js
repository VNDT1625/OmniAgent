/**
 * Build and stage the source-owned Tomny Core compatibility runtime.
 *
 * The binary is compiled from a pinned MIT-licensed AionCore source revision,
 * branded and packaged as Tomny Core. No downloaded AionCore executable is
 * used at build time or runtime.
 */

const { execFileSync } = require('child_process');
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

const UPSTREAM_REPOSITORY = 'https://github.com/VNDT1625/OmniAgent.git';
const BUILD_RECIPE_VERSION = 4;
const RECIPE_IDENTITY = `tomny-core-v${BUILD_RECIPE_VERSION}`;

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

const stagedBinaryName = (platform) => (platform === 'win32' ? 'tomny-core.exe' : 'tomny-core');

const replaceIfPresent = (filePath, replacements) => {
  if (!fs.existsSync(filePath)) return;
  const before = fs.readFileSync(filePath, 'utf8');
  let after = before;
  for (const [from, to] of replacements) after = after.replaceAll(from, to);
  if (after !== before) fs.writeFileSync(filePath, after);
};

const patchTomnyBranding = (sourceDir) => {
  replaceIfPresent(path.join(sourceDir, 'crates', 'aionui-app', 'src', 'cli.rs'), [
    [
      '#[command(name = "aioncore", about = "AionUi Backend Server", version)]',
      '#[command(name = "tomny-core", about = "Tomny Core Server", version)]',
    ],
    ['Cli::try_parse_from(["aioncore"', 'Cli::try_parse_from(["tomny-core"'],
    ['rendered.contains("aioncore")', 'rendered.contains("tomny-core")'],
  ]);
  replaceIfPresent(path.join(sourceDir, 'crates', 'aionui-app', 'src', 'bootstrap', 'tracing_init.rs'), [
    ['aioncore.log', 'tomny-core.log'],
  ]);
  replaceIfPresent(path.join(sourceDir, 'crates', 'aionui-app', 'Cargo.toml'), [
    ['name = "aioncore"', 'name = "tomny-core"'],
  ]);
};

const patchTomnyCompatibility = (sourceDir) => {
  replaceIfPresent(path.join(sourceDir, 'crates', 'aionui-file', 'src', 'service.rs'), [
    [
      'path.strip_prefix(root).unwrap_or(&path).to_string_lossy().into_owned()',
      'path.strip_prefix(root).unwrap_or(&path).to_string_lossy().replace(\'\\\\\', "/")',
    ],
    [
      'path.strip_prefix(root).unwrap_or(path).to_string_lossy().into_owned()',
      'path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace(\'\\\\\', "/")',
    ],
    ['.to_string_lossy()\r\n            .into_owned();', '.to_string_lossy()\r\n            .replace(\'\\\\\', "/");'],
    ['.to_string_lossy()\n            .into_owned();', '.to_string_lossy()\n            .replace(\'\\\\\', "/");'],
  ]);
};
const gitRepositoryArgs = (sourceDir) => [`--git-dir=${path.join(sourceDir, '.git')}`, `--work-tree=${sourceDir}`];

const repairCachedRepository = (sourceDir) => {
  const gitDir = path.join(sourceDir, '.git');
  if (!fs.existsSync(path.join(gitDir, 'HEAD')) || !fs.existsSync(path.join(gitDir, 'objects'))) return;

  // Git requires refs to exist even when every reference is packed. Some cache
  // restoration tools omit empty directories, which makes Git walk up to an
  // unrelated parent repository instead of using this checkout.
  fs.mkdirSync(path.join(gitDir, 'refs', 'heads'), { recursive: true });
  fs.mkdirSync(path.join(gitDir, 'refs', 'tags'), { recursive: true });
};

const ensureSource = ({ version, commit }) => {
  const cacheRoot = path.join(os.tmpdir(), 'tomny-core-source');
  const cacheKey = `${version}-${commit.slice(0, 12)}-r${BUILD_RECIPE_VERSION}`;
  const sourceDir = process.env.TOMNY_CORE_SOURCE_DIR || path.join(cacheRoot, cacheKey);
  if (!fs.existsSync(sourceDir)) {
    fs.mkdirSync(cacheRoot, { recursive: true });
    execFileSync('git', ['clone', '--depth', '1', '--branch', version, UPSTREAM_REPOSITORY, sourceDir], {
      stdio: 'inherit',
    });
  } else if (!fs.existsSync(path.join(sourceDir, '.git'))) {
    throw new Error(`Tomny Core source cache is not a Git checkout: ${sourceDir}`);
  }
  repairCachedRepository(sourceDir);
  const identity = validateReusableSource({
    sourceDir,
    repository: UPSTREAM_REPOSITORY,
    commit,
    recipeIdentity: RECIPE_IDENTITY,
  });
  patchTomnyBranding(sourceDir);
  patchTomnyCompatibility(sourceDir);
  const provenance = sealSourceCache({ sourceDir, identity, recipeIdentity: RECIPE_IDENTITY });
  return { sourceDir, actualCommit: identity.actualCommit, provenance };
};

const manifestMatches = (manifestPath, binaryPath, version, commit, triple) =>
  artifactManifestMatches({
    manifestPath,
    binaryPath,
    expected: {
      version,
      sourceCommit: commit,
      sourceRepository: UPSTREAM_REPOSITORY,
      sourceType: 'source-build',
      buildRecipeVersion: BUILD_RECIPE_VERSION,
      targetTriple: triple,
    },
  });

function prepareTomnyCore(options) {
  const { projectRoot, platform, arch, version, commit } = options;
  assertPinnedCommit(commit);
  const triple = targetTriple(platform, arch);
  if (!triple) throw new Error(`Unsupported Tomny Core target: ${platform}-${arch}`);

  const runtimeKey = `${platform}-${arch}`;
  const targetDir = path.join(projectRoot, 'resources', 'bundled-tomny-core', runtimeKey);
  const targetBinary = path.join(targetDir, stagedBinaryName(platform));
  const manifestPath = path.join(targetDir, 'manifest.json');
  if (manifestMatches(manifestPath, targetBinary, version, commit, triple)) {
    return { prepared: true, cached: true, dir: targetDir, sourceCommit: commit };
  }

  const { sourceDir, actualCommit, provenance } = ensureSource({ version, commit });
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
      'aionui-app',
      '--bin',
      'tomny-core',
    ],
    { cwd: sourceDir, stdio: 'inherit', env: process.env }
  );

  const sourceBinary = path.join(sourceDir, 'target', triple, 'release', stagedBinaryName(platform));
  if (!fs.existsSync(sourceBinary)) throw new Error(`Tomny Core build output was not found: ${sourceBinary}`);

  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(sourceBinary, targetBinary);
  if (platform !== 'win32') fs.chmodSync(targetBinary, 0o755);
  const licensePath = path.join(sourceDir, 'LICENSE');
  if (fs.existsSync(licensePath)) fs.copyFileSync(licensePath, path.join(targetDir, 'LICENSE.tomny-core.txt'));
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        name: 'Tomny Core',
        buildRecipeVersion: BUILD_RECIPE_VERSION,
        version,
        sourceCommit: actualCommit,
        sourceRepository: UPSTREAM_REPOSITORY,
        sourceTree: provenance.sourceTree,
        sourceHash: provenance.sourceHash,
        binarySha256: sha256File(targetBinary),
        targetTriple: triple,
        sourceType: 'source-build',
        compatibility: 'aioncore-rest-ws-v1',
        license: 'MIT',
        builtAt: new Date().toISOString(),
      },
      null,
      2
    ) + '\n'
  );
  return { prepared: true, cached: false, dir: targetDir, sourceCommit: actualCommit };
}

module.exports = {
  gitRepositoryArgs,
  manifestMatches,
  patchTomnyBranding,
  patchTomnyCompatibility,
  prepareTomnyCore,
  repairCachedRepository,
  stagedBinaryName,
  targetTriple,
};

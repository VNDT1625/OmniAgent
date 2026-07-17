const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SOURCE_PROVENANCE_FILE = '.tomny-source-provenance.json';
const SHA1_PATTERN = /^[a-f0-9]{40}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

const sha256File = (filePath) => crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');

const normalizeRepositoryUrl = (repository) => {
  if (typeof repository !== 'string' || repository.length === 0) throw new Error('Source repository URL is required.');
  let parsed;
  try {
    parsed = new URL(repository);
  } catch {
    throw new Error(`Source repository must be an absolute HTTPS URL: ${repository}`);
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error(`Source repository must be an uncredentialed HTTPS URL: ${repository}`);
  }
  const pathname = parsed.pathname.replace(/\/+$/u, '').replace(/\.git$/u, '');
  if (!pathname || pathname === '/') throw new Error(`Source repository path is invalid: ${repository}`);
  return `https://${parsed.hostname.toLowerCase()}${parsed.port ? `:${parsed.port}` : ''}${pathname}`;
};

const assertPinnedCommit = (commit) => {
  if (!SHA1_PATTERN.test(commit))
    throw new Error(`Source commit must be a full lowercase SHA-1: ${commit || '<empty>'}`);
};

const gitArgs = (sourceDir) => [`--git-dir=${path.join(sourceDir, '.git')}`, `--work-tree=${sourceDir}`];

const runGit = (sourceDir, args) =>
  execFileSync('git', [...gitArgs(sourceDir), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const hashSourceTree = (sourceDir) => {
  const hash = crypto.createHash('sha256');
  const visit = (directory, relativeDirectory = '') => {
    const entries = fs
      .readdirSync(directory, { withFileTypes: true })
      .toSorted((left, right) => left.name.localeCompare(right.name, 'en'));
    for (const entry of entries) {
      if (!relativeDirectory && ['.git', 'target', SOURCE_PROVENANCE_FILE].includes(entry.name)) continue;
      const relativePath = path.posix.join(relativeDirectory, entry.name);
      const fullPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${relativePath}\0`);
        visit(fullPath, relativePath);
      } else if (entry.isSymbolicLink()) {
        const target = fs.readlinkSync(fullPath);
        if (path.isAbsolute(target) || target.split(/[\\/]/u).includes('..')) {
          throw new Error(`Source tree contains an unsafe symbolic link: ${relativePath}`);
        }
        hash.update(`l\0${relativePath}\0${target}\0`);
      } else if (entry.isFile()) {
        hash.update(`f\0${relativePath}\0`);
        hash.update(fs.readFileSync(fullPath));
        hash.update('\0');
      } else {
        throw new Error(`Source tree contains an unsupported entry: ${relativePath}`);
      }
    }
  };
  visit(sourceDir);
  return hash.digest('hex');
};

const inspectSourceRepository = ({ sourceDir, repository, commit }) => {
  assertPinnedCommit(commit);
  const expectedRepository = normalizeRepositoryUrl(repository);
  if (!fs.existsSync(path.join(sourceDir, '.git'))) throw new Error(`Source cache is not a Git checkout: ${sourceDir}`);
  const actualRepository = normalizeRepositoryUrl(runGit(sourceDir, ['config', '--get', 'remote.origin.url']));
  if (actualRepository !== expectedRepository) {
    throw new Error(`Source repository mismatch: expected ${expectedRepository}, received ${actualRepository}`);
  }
  const actualCommit = runGit(sourceDir, ['rev-parse', '--verify', 'HEAD^{commit}']).toLowerCase();
  if (actualCommit !== commit) throw new Error(`Source commit mismatch: expected ${commit}, received ${actualCommit}`);
  const sourceTree = runGit(sourceDir, ['rev-parse', '--verify', 'HEAD^{tree}']).toLowerCase();
  if (!SHA1_PATTERN.test(sourceTree)) throw new Error(`Source tree identity is invalid: ${sourceTree}`);
  return { actualCommit, sourceRepository: actualRepository, sourceTree };
};

const readJson = (filePath) => {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Source provenance is unreadable: ${error instanceof Error ? error.message : String(error)}`, {
      cause: error,
    });
  }
};

const validateReusableSource = ({ sourceDir, repository, commit, recipeIdentity }) => {
  const identity = inspectSourceRepository({ sourceDir, repository, commit });
  const provenancePath = path.join(sourceDir, SOURCE_PROVENANCE_FILE);
  if (!fs.existsSync(provenancePath)) {
    const status = runGit(sourceDir, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (status)
      throw new Error('Unproven source cache contains local changes; delete it and rebuild from the pinned source.');
    return identity;
  }
  const provenance = readJson(provenancePath);
  const actualHash = hashSourceTree(sourceDir);
  if (
    provenance.schemaVersion !== 1 ||
    provenance.sourceRepository !== identity.sourceRepository ||
    provenance.sourceCommit !== identity.actualCommit ||
    provenance.sourceTree !== identity.sourceTree ||
    provenance.recipeIdentity !== recipeIdentity ||
    !SHA256_PATTERN.test(provenance.sourceHash) ||
    provenance.sourceHash !== actualHash
  ) {
    throw new Error('Source cache provenance mismatch; refusing to reuse a potentially poisoned checkout.');
  }
  return { ...identity, sourceHash: actualHash };
};

const sealSourceCache = ({ sourceDir, identity, recipeIdentity }) => {
  const sourceHash = hashSourceTree(sourceDir);
  const provenance = {
    schemaVersion: 1,
    sourceRepository: identity.sourceRepository,
    sourceCommit: identity.actualCommit,
    sourceTree: identity.sourceTree,
    sourceHash,
    recipeIdentity,
  };
  const provenancePath = path.join(sourceDir, SOURCE_PROVENANCE_FILE);
  const temporaryPath = `${provenancePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(provenance, null, 2)}\n`, { flag: 'wx' });
  fs.renameSync(temporaryPath, provenancePath);
  return provenance;
};

const artifactManifestMatches = ({ manifestPath, binaryPath, expected }) => {
  if (!fs.existsSync(manifestPath) || !fs.existsSync(binaryPath)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return (
      Object.entries(expected).every(([key, value]) => manifest[key] === value) &&
      SHA1_PATTERN.test(manifest.sourceCommit) &&
      SHA1_PATTERN.test(manifest.sourceTree) &&
      SHA256_PATTERN.test(manifest.sourceHash) &&
      SHA256_PATTERN.test(manifest.binarySha256) &&
      manifest.binarySha256 === sha256File(binaryPath)
    );
  } catch {
    return false;
  }
};

module.exports = {
  SOURCE_PROVENANCE_FILE,
  artifactManifestMatches,
  assertPinnedCommit,
  gitArgs,
  hashSourceTree,
  inspectSourceRepository,
  normalizeRepositoryUrl,
  sealSourceCache,
  sha256File,
  validateReusableSource,
};

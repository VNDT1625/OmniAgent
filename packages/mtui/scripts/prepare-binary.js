const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const TARGETS = {
  darwin: {
    x64: 'x86_64-apple-darwin',
    arm64: 'aarch64-apple-darwin',
  },
  linux: {
    x64: 'x86_64-unknown-linux-gnu',
    arm64: 'aarch64-unknown-linux-gnu',
  },
  win32: {
    x64: 'x86_64-pc-windows-msvc',
    arm64: 'aarch64-pc-windows-msvc',
  },
};

function resolveRustTarget(platform, arch) {
  const target = TARGETS[platform]?.[arch];
  if (!target) {
    throw new Error(`Unsupported MTUI build target: ${platform}/${arch}`);
  }
  return target;
}

function getBinaryName(platform) {
  return platform === 'win32' ? 'mtui.exe' : 'mtui';
}

function run(command, args, options = {}) {
  execFileSync(command, args, { stdio: 'inherit', ...options });
}

function getBuildEnvironment(platform, arch) {
  if (platform === 'linux' && arch === 'arm64') {
    return {
      ...process.env,
      CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER: 'aarch64-linux-gnu-gcc',
    };
  }
  return process.env;
}

function prepareMtuiBinary({
  projectRoot = path.resolve(__dirname, '../../..'),
  platform = process.platform,
  arch = process.arch,
  execute = run,
} = {}) {
  const target = resolveRustTarget(platform, arch);
  const manifestPath = path.join(projectRoot, 'packages', 'mtui', 'Cargo.toml');
  const binaryName = getBinaryName(platform);
  const sourcePath = path.join(projectRoot, 'packages', 'mtui', 'target', target, 'release', binaryName);
  const destinationDir = path.join(projectRoot, 'resources', 'binaries');
  const destinationPath = path.join(destinationDir, binaryName);

  console.log(`?? Preparing MTUI production binary for ${platform}/${arch} (${target})...`);
  execute('rustup', ['target', 'add', target], { cwd: projectRoot });
  execute('cargo', ['build', '--locked', '--release', '--manifest-path', manifestPath, '--target', target], {
    cwd: projectRoot,
    env: getBuildEnvironment(platform, arch),
  });

  if (!fs.existsSync(sourcePath) || fs.statSync(sourcePath).size === 0) {
    throw new Error(`MTUI build did not produce a non-empty binary: ${sourcePath}`);
  }

  fs.mkdirSync(destinationDir, { recursive: true });
  for (const candidate of ['mtui', 'mtui.exe']) {
    const existing = path.join(destinationDir, candidate);
    if (existing !== destinationPath) {
      fs.rmSync(existing, { force: true });
    }
  }
  fs.copyFileSync(sourcePath, destinationPath);
  if (platform !== 'win32') {
    fs.chmodSync(destinationPath, 0o755);
  }

  console.log(`? MTUI binary ready: ${destinationPath}`);
  return { destinationPath, sourcePath, target };
}

function parseArch(argv) {
  const index = argv.indexOf('--arch');
  return index === -1 ? process.arch : argv[index + 1];
}

if (require.main === module) {
  prepareMtuiBinary({ arch: parseArch(process.argv.slice(2)) });
}

module.exports = { getBinaryName, getBuildEnvironment, prepareMtuiBinary, resolveRustTarget };

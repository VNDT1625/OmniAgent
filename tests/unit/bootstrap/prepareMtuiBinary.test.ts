import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

type PrepareBinaryModule = {
  getBinaryName: (platform: NodeJS.Platform) => string;
  getBuildEnvironment: (platform: NodeJS.Platform, arch: string) => NodeJS.ProcessEnv;
  resolveRustTarget: (platform: NodeJS.Platform, arch: string) => string;
};

const require = createRequire(import.meta.url);
const prepareBinary = require('../../../packages/mtui/scripts/prepare-binary.js') as PrepareBinaryModule;

describe('prepare MTUI production binary', () => {
  it.each([
    ['win32', 'x64', 'x86_64-pc-windows-msvc'],
    ['win32', 'arm64', 'aarch64-pc-windows-msvc'],
    ['darwin', 'x64', 'x86_64-apple-darwin'],
    ['darwin', 'arm64', 'aarch64-apple-darwin'],
    ['linux', 'x64', 'x86_64-unknown-linux-gnu'],
    ['linux', 'arm64', 'aarch64-unknown-linux-gnu'],
  ] as const)('maps %s/%s to %s', (platform, arch, target) => {
    expect(prepareBinary.resolveRustTarget(platform, arch)).toBe(target);
  });

  it('uses the platform executable name', () => {
    expect(prepareBinary.getBinaryName('win32')).toBe('mtui.exe');
    expect(prepareBinary.getBinaryName('linux')).toBe('mtui');
  });

  it('configures the Linux ARM64 cross-linker', () => {
    expect(prepareBinary.getBuildEnvironment('linux', 'arm64').CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER).toBe(
      'aarch64-linux-gnu-gcc'
    );
  });

  it('rejects unsupported targets', () => {
    expect(() => prepareBinary.resolveRustTarget('freebsd', 'x64')).toThrow('Unsupported MTUI build target');
  });
});

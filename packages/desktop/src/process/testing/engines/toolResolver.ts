/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `toolResolver` — locate the external binaries the real test engines need
 * (ffmpeg for video, adb/emulator for Android), honestly and at runtime.
 *
 * Philosophy: NEVER fake a capability. Each resolver returns the absolute path
 * of a working binary, or `null` with a precise reason the caller surfaces to
 * the user ("install the Android SDK and set ANDROID_HOME"). ffmpeg is bundled
 * via `ffmpeg-static` so video ALWAYS works without a system install; adb /
 * emulator are looked up from `ANDROID_HOME`/`ANDROID_SDK_ROOT`/`PATH` because
 * the multi-GB SDK cannot be bundled.
 *
 * Process boundary: Main-process (Node.js) module — no DOM APIs.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Result of resolving a tool: a usable path, or a reason it is unavailable. */
export type ToolResolution = {
  /** Whether a usable binary was found. */
  ok: boolean;
  /** Absolute path of the binary when `ok` is true. */
  path?: string;
  /** Human-readable reason when `ok` is false. */
  reason?: string;
};

/** Resolve the bundled ffmpeg binary (always available — shipped via ffmpeg-static). */
export const resolveFfmpeg = (): ToolResolution => {
  try {
    // `ffmpeg-static` default-exports the absolute path to a platform ffmpeg.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const ffmpegPath = require('ffmpeg-static') as string | null;
    if (ffmpegPath && fs.existsSync(ffmpegPath)) return { ok: true, path: ffmpegPath };
    return { ok: false, reason: 'Bundled ffmpeg binary not found (ffmpeg-static).' };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
};

/** Candidate roots for the Android SDK, in priority order. */
const androidSdkRoots = (): string[] => {
  const roots: string[] = [];
  for (const env of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT]) {
    if (env && env.trim()) roots.push(env.trim());
  }
  const home = process.env.USERPROFILE || process.env.HOME;
  if (home) roots.push(path.join(home, 'AppData', 'Local', 'Android', 'Sdk'), path.join(home, 'Android', 'Sdk'));
  return roots;
};

/** With `.exe`/`.bat` suffixes on Windows. */
const withExeSuffixes = (base: string): string[] =>
  process.platform === 'win32' ? [`${base}.exe`, `${base}.bat`, base] : [base];

/**
 * Resolve an Android SDK tool (`adb` or `emulator`) from the SDK roots or PATH.
 *
 * @param tool        The tool name (`adb` / `emulator`).
 * @param relativeDir The SDK subdir it lives in (`platform-tools` / `emulator`).
 */
const resolveAndroidTool = (tool: string, relativeDir: string): ToolResolution => {
  for (const root of androidSdkRoots()) {
    const dir = path.join(root, relativeDir);
    for (const name of withExeSuffixes(tool)) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return { ok: true, path: candidate };
    }
  }
  // Fall back to PATH (resolved lazily by the OS when executed by bare name).
  return {
    ok: false,
    reason: `${tool} not found. Install the Android SDK and set ANDROID_HOME (expected ${relativeDir}/${tool}).`,
  };
};

/** Resolve `adb` (Android Debug Bridge). */
export const resolveAdb = (): ToolResolution => resolveAndroidTool('adb', 'platform-tools');

/** Resolve the Android `emulator` binary. */
export const resolveEmulator = (): ToolResolution => resolveAndroidTool('emulator', 'emulator');

/** Verify a resolved binary actually runs `<bin> <versionArg>` (sanity probe). */
export const probeBinary = async (binPath: string, versionArg = '-version'): Promise<boolean> => {
  try {
    await execFileAsync(binPath, [versionArg], { timeout: 8000 });
    return true;
  } catch {
    return false;
  }
};

/** List installed AVDs via `emulator -list-avds` (empty when none/unavailable). */
export const listAvds = async (emulatorPath: string): Promise<string[]> => {
  try {
    const { stdout } = await execFileAsync(emulatorPath, ['-list-avds'], { timeout: 10000 });
    return stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('INFO'));
  } catch {
    return [];
  }
};

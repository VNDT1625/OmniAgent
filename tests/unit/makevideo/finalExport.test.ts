/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/makevideo/finalExport — merges video segments into a
 * single .mp4 via ffmpeg. The ffmpeg binary path, spawn function, and fs are
 * injected so no real ffmpeg or disk is touched.
 *
 * Covers:
 * - Concatenation of clips with no audio (single ffmpeg concat invocation).
 * - Muxing a clip that has an audio track before concatenation.
 * - Empty segment list rejected.
 * - A non-zero ffmpeg exit code surfaces the stderr tail.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { exportFinalVideo, type SpawnFn } from '@/process/makevideo/finalExport';

/** A fake child process that closes with `exitCode` on the next tick. */
const fakeChild = (exitCode: number, stderr = '') => {
  const child = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => void };
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  queueMicrotask(() => {
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', exitCode);
  });
  return child;
};

/** Spawn that always succeeds, recording each invocation's args. */
const okSpawn = (): SpawnFn & { calls: string[][] } => {
  const calls: string[][] = [];
  const fn = ((_cmd: string, args: readonly string[]) => {
    calls.push([...args]);
    return fakeChild(0) as unknown as ReturnType<SpawnFn>;
  }) as SpawnFn & { calls: string[][] };
  fn.calls = calls;
  return fn;
};

const memFs = () => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  rm: vi.fn(async () => undefined),
});

describe('exportFinalVideo', () => {
  it('rejects an empty segment list', async () => {
    await expect(exportFinalVideo([], '/out.mp4', { ffmpegPath: '/ff', spawnImpl: okSpawn(), fs: memFs() })).rejects.toThrow(
      /no segments/i
    );
  });

  it('concatenates clips without audio in a single ffmpeg pass', async () => {
    const spawnImpl = okSpawn();
    const fs = memFs();
    const result = await exportFinalVideo(
      [{ videoClipPath: '/a.mp4' }, { videoClipPath: '/b.mp4' }],
      '/out/final.mp4',
      { ffmpegPath: '/ff', spawnImpl, fs }
    );

    expect(result.outputPath).toBe('/out/final.mp4');
    expect(result.durationSec).toBe(10); // 2 segments * 5s heuristic
    // Only the concat pass runs (no per-segment mux).
    expect(spawnImpl.calls).toHaveLength(1);
    expect(spawnImpl.calls[0]).toContain('concat');
    // A manifest was written and the temp dir cleaned up.
    expect(fs.writeFile).toHaveBeenCalledTimes(1);
    expect(fs.rm).toHaveBeenCalledTimes(1);
  });

  it('muxes a clip that carries an audio track before concatenation', async () => {
    const spawnImpl = okSpawn();
    await exportFinalVideo([{ videoClipPath: '/a.mp4', audioPath: '/a.mp3' }], '/out/final.mp4', {
      ffmpegPath: '/ff',
      spawnImpl,
      fs: memFs(),
    });
    // First pass = mux (-shortest), second pass = concat.
    expect(spawnImpl.calls).toHaveLength(2);
    expect(spawnImpl.calls[0]).toContain('-shortest');
    expect(spawnImpl.calls[1]).toContain('concat');
  });

  it('surfaces the ffmpeg stderr tail on a non-zero exit code', async () => {
    const spawnImpl: SpawnFn = () => fakeChild(1, 'Invalid data found') as unknown as ReturnType<SpawnFn>;
    await expect(
      exportFinalVideo([{ videoClipPath: '/a.mp4' }], '/out/final.mp4', { ffmpegPath: '/ff', spawnImpl, fs: memFs() })
    ).rejects.toThrow(/ffmpeg exited with code 1.*Invalid data found/s);
  });

  it('renders a still-image segment (no clip) into a slideshow clip with audio', async () => {
    const spawnImpl = okSpawn();
    const result = await exportFinalVideo([{ imagePath: '/scene.png', audioPath: '/scene.mp3' }], '/out/final.mp4', {
      ffmpegPath: '/ff',
      spawnImpl,
      fs: memFs(),
    });
    expect(result.outputPath).toBe('/out/final.mp4');
    // Pass 1 = still-image render (-loop 1 + -shortest for audio), pass 2 = concat.
    expect(spawnImpl.calls).toHaveLength(2);
    expect(spawnImpl.calls[0]).toEqual(expect.arrayContaining(['-loop', '1', '-tune', 'stillimage', '-shortest']));
    expect(spawnImpl.calls[1]).toContain('concat');
  });

  it('renders a still image with no audio for a fixed duration', async () => {
    const spawnImpl = okSpawn();
    const result = await exportFinalVideo([{ imagePath: '/scene.png', durationSec: 8 }], '/out/final.mp4', {
      ffmpegPath: '/ff',
      spawnImpl,
      fs: memFs(),
    });
    expect(result.durationSec).toBe(8);
    expect(spawnImpl.calls[0]).toEqual(expect.arrayContaining(['-loop', '1', '-t', '8', '-an']));
  });

  it('mixes a video clip and a still image into one export', async () => {
    const spawnImpl = okSpawn();
    await exportFinalVideo([{ videoClipPath: '/a.mp4' }, { imagePath: '/b.png' }], '/out/final.mp4', {
      ffmpegPath: '/ff',
      spawnImpl,
      fs: memFs(),
    });
    // Only the still image needs a render pass; then the concat pass.
    expect(spawnImpl.calls).toHaveLength(2);
    expect(spawnImpl.calls[0]).toContain('-loop');
    expect(spawnImpl.calls[1]).toContain('concat');
  });

  it('rejects when no segment has a clip or an image', async () => {
    await expect(
      exportFinalVideo([{ audioPath: '/a.mp3' }], '/out/final.mp4', { ffmpegPath: '/ff', spawnImpl: okSpawn(), fs: memFs() })
    ).rejects.toThrow(/no segment had a video clip or a rendered image/i);
  });
});

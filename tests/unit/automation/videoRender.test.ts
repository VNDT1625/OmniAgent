/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the Automation video renderer. A fake spawn returns a stubbed
 * child process so the ffmpeg invocation is exercised without a real binary.
 */

import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { buildConcatManifest, createVideoRenderer } from '@/process/automation/connectors/videoRender';

/** A minimal fake child process: emits `close` with the given code on next tick. */
const fakeChild = (code: number): EventEmitter & { stderr: EventEmitter; kill: () => void } => {
  const emitter = new EventEmitter() as EventEmitter & { stderr: EventEmitter; kill: () => void };
  emitter.stderr = new EventEmitter();
  emitter.kill = () => undefined;
  setTimeout(() => emitter.emit('close', code), 0);
  return emitter;
};

const memFs = () => {
  const writes: { path: string; data: string }[] = [];
  return {
    writes,
    fs: {
      mkdir: () => Promise.resolve(undefined),
      writeFile: (p: string, data: string) => {
        writes.push({ path: p, data });
        return Promise.resolve();
      },
      rm: () => Promise.resolve(),
    },
  };
};

describe('buildConcatManifest', () => {
  it('emits a file + duration line per scene and repeats the last file', () => {
    const manifest = buildConcatManifest([
      { imagePath: '/a.png', durationSec: 2 },
      { imagePath: '/b.png', durationSec: 3 },
    ]);
    const lines = manifest.trim().split('\n');
    expect(lines).toEqual(["file '/a.png'", 'duration 2', "file '/b.png'", 'duration 3', "file '/b.png'"]);
  });

  it('escapes single quotes in paths', () => {
    const manifest = buildConcatManifest([{ imagePath: "/it's/a.png", durationSec: 1 }]);
    expect(manifest).toContain("file '/it'\\''s/a.png'");
  });
});

describe('createVideoRenderer', () => {
  it('writes a manifest and runs ffmpeg to produce the output path', async () => {
    const { writes, fs } = memFs();
    const spawnImpl = vi.fn(() => fakeChild(0) as never);
    const renderer = createVideoRenderer({ ffmpegPath: '/usr/bin/ffmpeg', spawnImpl, fs });

    const out = await renderer.render({
      scenes: [
        { imagePath: '/a.png', durationSec: 2 },
        { imagePath: '/b.png', durationSec: 2 },
      ],
      outputPath: '/tmp/out.mp4',
    });

    expect(out).toBe('/tmp/out.mp4');
    expect(writes).toHaveLength(1);
    expect(spawnImpl).toHaveBeenCalledOnce();
    const [bin, args] = spawnImpl.mock.calls[0] as unknown as [string, string[]];
    expect(bin).toBe('/usr/bin/ffmpeg');
    expect(args).toContain('/tmp/out.mp4');
    expect(args).toContain('libx264');
  });

  it('rejects when ffmpeg exits non-zero', async () => {
    const { fs } = memFs();
    const renderer = createVideoRenderer({ ffmpegPath: '/usr/bin/ffmpeg', spawnImpl: () => fakeChild(1) as never, fs });
    await expect(
      renderer.render({ scenes: [{ imagePath: '/a.png', durationSec: 1 }], outputPath: '/tmp/out.mp4' })
    ).rejects.toThrow(/ffmpeg exited with code 1/);
  });

  it('rejects when there are no scenes', async () => {
    const { fs } = memFs();
    const renderer = createVideoRenderer({ ffmpegPath: '/usr/bin/ffmpeg', spawnImpl: () => fakeChild(0) as never, fs });
    await expect(renderer.render({ scenes: [], outputPath: '/tmp/out.mp4' })).rejects.toThrow(/no scenes/i);
  });
});

/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the yt-dlp transcript fetcher — the primary YouTube transcript
 * path. All collaborators (binary locator, spawner, temp dir, fs reads) are
 * injected so the whole flow runs without yt-dlp or the network.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createYtDlpTranscript, parseVtt, parseJson3 } from '@/process/services/contentExtract/ytDlpTranscript';

const tempDirs: string[] = [];
const realTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'aionui-ytdlp-test-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('parseVtt', () => {
  it('drops timing cues, sequence numbers and inline tags, dedups rolling lines', () => {
    const vtt = [
      'WEBVTT',
      '',
      '1',
      '00:00:01.000 --> 00:00:03.000',
      '<c>Hello</c> world',
      '',
      '2',
      '00:00:03.000 --> 00:00:05.000',
      'Hello world',
      'second line',
    ].join('\n');
    expect(parseVtt(vtt)).toBe('Hello world second line');
  });
});

describe('parseJson3', () => {
  it('joins event segments and collapses whitespace', () => {
    const body = JSON.stringify({
      events: [{ segs: [{ utf8: 'Hello ' }, { utf8: 'there' }] }, { segs: [{ utf8: 'again' }] }],
    });
    expect(parseJson3(body)).toBe('Hello there again');
  });
  it('returns empty string for invalid json', () => {
    expect(parseJson3('not json')).toBe('');
  });
});

describe('createYtDlpTranscript', () => {
  it('returns ok:false when yt-dlp is not installed', async () => {
    const fetcher = createYtDlpTranscript({ resolveBinary: () => Promise.resolve(null) });
    const out = await fetcher.fetchTranscript('dQw4w9WgXcQ');
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('not installed');
  });

  it('downloads, parses a VTT subtitle and reports the language', async () => {
    const spawn = vi.fn(async (_file: string, _args: string[], options: { cwd?: string }) => {
      // Simulate yt-dlp writing a subtitle file into the temp dir.
      await writeFile(
        join(options.cwd as string, 'vid.en.vtt'),
        'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\nhello world\n',
        'utf-8'
      );
      return { code: 0, stdout: '', stderr: '' };
    });
    const fetcher = createYtDlpTranscript({
      resolveBinary: () => Promise.resolve('/usr/bin/yt-dlp'),
      spawn,
      makeTempDir: realTempDir,
    });
    const out = await fetcher.fetchTranscript('https://www.youtube.com/watch?v=vid');
    expect(out.ok).toBe(true);
    if (out.ok) {
      expect(out.text).toBe('hello world');
      expect(out.via).toBe('ytdlp');
      expect(out.lang).toBe('en');
    }
  });

  it('prefers a preferred-language track when several are present', async () => {
    const spawn = vi.fn(async (_file: string, _args: string[], options: { cwd?: string }) => {
      const cwd = options.cwd as string;
      await writeFile(join(cwd, 'vid.en.vtt'), 'WEBVTT\n\nEnglish caption\n', 'utf-8');
      await writeFile(join(cwd, 'vid.vi.vtt'), 'WEBVTT\n\nPhu de tieng Viet\n', 'utf-8');
      return { code: 0, stdout: '', stderr: '' };
    });
    const fetcher = createYtDlpTranscript({
      resolveBinary: () => Promise.resolve('yt-dlp'),
      spawn,
      makeTempDir: realTempDir,
      preferLangs: ['vi', 'en'],
    });
    const out = await fetcher.fetchTranscript('vid');
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.lang).toBe('vi');
  });

  it('returns ok:false with a diagnostic when no subtitle files are produced', async () => {
    const spawn = vi.fn(async () => ({ code: 0, stdout: '', stderr: 'no subtitles' }));
    const fetcher = createYtDlpTranscript({
      resolveBinary: () => Promise.resolve('yt-dlp'),
      spawn,
      makeTempDir: realTempDir,
    });
    const out = await fetcher.fetchTranscript('vid');
    expect(out.ok).toBe(false);
    // Message now distinguishes "no captions" from other failures.
    if (!out.ok) expect(out.reason).toMatch(/ytdlp/i);
  });

  it('passes --cookies when a cookie file is exported (signed-in past 429)', async () => {
    let seenArgs: string[] = [];
    const spawn = vi.fn(async (_file: string, args: string[], options: { cwd?: string }) => {
      seenArgs = args;
      await writeFile(join(options.cwd as string, 'vid.en.vtt'), 'WEBVTT\n\nhi\n', 'utf-8');
      return { code: 0, stdout: '', stderr: '' };
    });
    const fetcher = createYtDlpTranscript({
      resolveBinary: () => Promise.resolve('yt-dlp'),
      spawn,
      makeTempDir: realTempDir,
      getCookieFile: (dir) => Promise.resolve(join(dir, 'cookies.txt')),
    });
    const out = await fetcher.fetchTranscript('vid');
    expect(out.ok).toBe(true);
    const i = seenArgs.indexOf('--cookies');
    expect(i).toBeGreaterThan(-1);
    expect(seenArgs[i + 1]).toMatch(/cookies\.txt$/);
  });

  it('runs anonymously when the cookie exporter returns null', async () => {
    let seenArgs: string[] = [];
    const spawn = vi.fn(async (_file: string, args: string[], options: { cwd?: string }) => {
      seenArgs = args;
      await writeFile(join(options.cwd as string, 'vid.en.vtt'), 'WEBVTT\n\nhi\n', 'utf-8');
      return { code: 0, stdout: '', stderr: '' };
    });
    const fetcher = createYtDlpTranscript({
      resolveBinary: () => Promise.resolve('yt-dlp'),
      spawn,
      makeTempDir: realTempDir,
      getCookieFile: () => Promise.resolve(null),
    });
    const out = await fetcher.fetchTranscript('vid');
    expect(out.ok).toBe(true);
    expect(seenArgs.includes('--cookies')).toBe(false);
  });
});

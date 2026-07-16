/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the YouTube cookie exporter (yt-dlp `--cookies` support). The
 * Electron `Session.cookies` reader is injected so the whole flow runs without
 * Electron, and writes only into a real temp dir.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  toNetscapeCookieFile,
  writeYoutubeCookieFile,
  type CookieLike,
  type CookieReader,
} from '@/process/services/contentExtract/youtubeCookies';

const tempDirs: string[] = [];
const realTempDir = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'aionui-ytcookie-test-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(async () => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe('toNetscapeCookieFile', () => {
  it('writes the required header and one tab-separated line per cookie', () => {
    const out = toNetscapeCookieFile([
      { name: 'SID', value: 'abc', domain: '.youtube.com', path: '/', secure: true, expirationDate: 1893456000 },
    ]);
    expect(out.startsWith('# Netscape HTTP Cookie File')).toBe(true);
    const line = out.split('\n').find((l) => l.includes('SID'));
    expect(line).toBe('.youtube.com\tTRUE\t/\tTRUE\t1893456000\tSID\tabc');
  });

  it('marks host-only cookies as not including subdomains and session cookies as expiry 0', () => {
    const out = toNetscapeCookieFile([
      { name: 'HOST', value: 'v', domain: 'www.youtube.com', path: '/', hostOnly: true },
    ]);
    const line = out.split('\n').find((l) => l.includes('HOST'));
    // includeSub FALSE (host-only), secure FALSE, expiry 0 (session).
    expect(line).toBe('www.youtube.com\tFALSE\t/\tFALSE\t0\tHOST\tv');
  });

  it('skips cookies with no domain', () => {
    const out = toNetscapeCookieFile([{ name: 'X', value: 'y' }]);
    expect(out.includes('\tX\t')).toBe(false);
  });
});

describe('writeYoutubeCookieFile', () => {
  it('collects youtube + google cookies, de-dups, and writes cookies.txt', async () => {
    const reader: CookieReader = {
      get: vi.fn(async ({ domain }: { domain?: string }) => {
        if (domain === '.youtube.com')
          return [{ name: 'SID', value: 'a', domain: '.youtube.com', path: '/' }] as CookieLike[];
        if (domain === '.google.com') {
          return [
            { name: 'SID', value: 'a', domain: '.google.com', path: '/' },
            { name: 'HSID', value: 'b', domain: '.google.com', path: '/' },
          ] as CookieLike[];
        }
        return [];
      }),
    };
    const dir = await realTempDir();
    const file = await writeYoutubeCookieFile(reader, dir);
    expect(file).toBe(join(dir, 'cookies.txt'));
    const body = await readFile(file as string, 'utf-8');
    expect(body).toContain('.youtube.com\t');
    expect(body).toContain('\tHSID\tb');
    // Two SID lines (one per domain) are distinct keys; HSID once → 3 cookie lines.
    const cookieLines = body.split('\n').filter((l) => l.includes('SID') || l.includes('HSID'));
    expect(cookieLines.length).toBe(3);
  });

  it('returns null when there are no cookies (anonymous fallback)', async () => {
    const reader: CookieReader = { get: vi.fn(async () => [] as CookieLike[]) };
    const dir = await realTempDir();
    expect(await writeYoutubeCookieFile(reader, dir)).toBeNull();
  });

  it('never throws when the reader fails', async () => {
    const reader: CookieReader = {
      get: vi.fn(async () => {
        throw new Error('cookie store locked');
      }),
    };
    const dir = await realTempDir();
    expect(await writeYoutubeCookieFile(reader, dir)).toBeNull();
  });
});

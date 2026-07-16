/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchGithubTrending, clearGithubTrendingCache } from '@process/news/githubTrending';

const REPO = {
  id: 42,
  full_name: 'acme/rocket',
  name: 'rocket',
  description: 'A fast thing',
  html_url: 'https://github.com/acme/rocket',
  stargazers_count: 1234,
  language: 'Rust',
  owner: { login: 'acme' },
};

const ok = (items: unknown[]) => new Response(JSON.stringify({ items }), { status: 200 });

describe('githubTrending', () => {
  beforeEach(() => clearGithubTrendingCache());

  it('normalises repositories from the search API', async () => {
    const fetchMock = vi.fn(async () => ok([REPO]));
    const res = await fetchGithubTrending({ since: 'weekly' }, { fetch: fetchMock as unknown as typeof fetch });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.repos).toHaveLength(1);
    expect(res.repos[0]).toMatchObject({
      id: 42,
      fullName: 'acme/rocket',
      owner: 'acme',
      stars: 1234,
      language: 'Rust',
      url: 'https://github.com/acme/rocket',
    });
  });

  it('drops malformed entries', async () => {
    const fetchMock = vi.fn(async () => ok([REPO, { name: 'no-id' }, { id: 1 }]));
    const res = await fetchGithubTrending({ since: 'daily' }, { fetch: fetchMock as unknown as typeof fetch });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.repos).toHaveLength(1);
  });

  it('serves the cache on a second call (no extra fetch)', async () => {
    const fetchMock = vi.fn(async () => ok([REPO]));
    await fetchGithubTrending({ since: 'monthly' }, { fetch: fetchMock as unknown as typeof fetch });
    await fetchGithubTrending({ since: 'monthly' }, { fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bypasses the cache with force', async () => {
    const fetchMock = vi.fn(async () => ok([REPO]));
    await fetchGithubTrending({ since: 'weekly' }, { fetch: fetchMock as unknown as typeof fetch });
    await fetchGithubTrending({ since: 'weekly', force: true }, { fetch: fetchMock as unknown as typeof fetch });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('returns an error result on a non-ok response', async () => {
    const fetchMock = vi.fn(async () => new Response('rate limited', { status: 403 }));
    const res = await fetchGithubTrending({ since: 'daily' }, { fetch: fetchMock as unknown as typeof fetch });
    expect(res.ok).toBe(false);
  });
});

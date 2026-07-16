/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { detectLocationByIp } from '@process/news/geoLocation';

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

// Provider chain order (see geoLocation.ts): ip.sb → geojs → ip-api.com → freeipapi.
describe('geoLocation — IP detection with provider fallback', () => {
  it('uses the first provider (ip.sb) when it succeeds', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ city: 'Tay Ninh', region: 'Tay Ninh', latitude: 11.31, longitude: 106.1, country: 'Vietnam' })
    );
    const loc = await detectLocationByIp({ fetch: fetchMock as unknown as typeof fetch });
    expect(loc?.city).toBe('Tay Ninh');
    expect(loc?.latitude).toBe(11.31);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the next provider (geojs) when the first fails', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('ip.sb')) return jsonResponse({ error: 'blocked' }, 403);
      if (url.includes('geojs'))
        // geojs returns lat/lon as strings — the mapper must coerce them.
        return jsonResponse({ city: 'Ho Chi Minh City', latitude: '10.82', longitude: '106.62', country: 'VN' });
      return jsonResponse({}, 500);
    });
    const loc = await detectLocationByIp({ fetch: fetchMock as unknown as typeof fetch });
    expect(loc?.city).toBe('Ho Chi Minh City');
    expect(loc?.latitude).toBeCloseTo(10.82, 5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls through to freeipapi as the last resort', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('freeipapi'))
        return jsonResponse({ cityName: 'Hanoi', latitude: 21.0, longitude: 105.8, countryName: 'Vietnam' });
      if (url.includes('ip-api.com')) return jsonResponse({ status: 'fail' });
      return jsonResponse({}, 429);
    });
    const loc = await detectLocationByIp({ fetch: fetchMock as unknown as typeof fetch });
    expect(loc?.city).toBe('Hanoi');
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('returns null when every provider fails', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 403));
    const loc = await detectLocationByIp({ fetch: fetchMock as unknown as typeof fetch });
    expect(loc).toBeNull();
  });
});

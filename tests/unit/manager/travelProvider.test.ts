/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/manager/travelProvider.
 *
 * Covers the three-tier degrade strategy:
 * - Tier 1: Google Distance Matrix (when an API key is set) wins and reports
 *   source 'google'.
 * - Tier 2: keyless OSRM road route (after Open-Meteo geocode) reports 'osrm'.
 * - Tier 3: straight-line haversine estimate when routing is unavailable
 *   ('estimate'), and the fully-offline path returns null only when geocoding
 *   itself fails.
 * - Never throws on network errors; geocode results are memoised.
 */

import { describe, expect, it, vi } from 'vitest';
import { createTravelProvider, haversineMeters, type FetchLike } from '@/process/manager/travelProvider';

/** Build a fetch stub that routes by URL substring to canned JSON responses. */
const makeFetch = (routes: Array<{ match: string; ok?: boolean; body: unknown }>): FetchLike =>
  vi.fn(async (url: string) => {
    const hit = routes.find((r) => url.includes(r.match));
    if (!hit) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: hit.ok !== false, status: hit.ok === false ? 500 : 200, json: async () => hit.body };
  });

describe('travelProvider', () => {
  it('uses Google Distance Matrix when an API key is configured (source: google)', async () => {
    const fetchImpl = makeFetch([
      {
        match: 'distancematrix',
        body: {
          status: 'OK',
          rows: [{ elements: [{ status: 'OK', distance: { value: 5200 }, duration: { value: 900 } }] }],
        },
      },
    ]);
    const provider = createTravelProvider({ fetchImpl, googleApiKey: 'AIza-test' });
    const est = await provider.estimate('A St', 'B Ave', 'driving');
    expect(est).not.toBeNull();
    expect(est!.source).toBe('google');
    expect(est!.distanceMeters).toBe(5200);
    expect(est!.durationSeconds).toBe(900);
  });

  it('falls back to keyless OSRM routing (geocode → route, source: osrm)', async () => {
    const fetchImpl = makeFetch([
      // Open-Meteo geocoder (called twice — once per endpoint).
      { match: 'geocoding-api.open-meteo.com', body: { results: [{ latitude: 10, longitude: 20 }] } },
      { match: 'router.project-osrm.org', body: { code: 'Ok', routes: [{ distance: 4000, duration: 600 }] } },
    ]);
    const provider = createTravelProvider({ fetchImpl }); // no key
    const est = await provider.estimate('Origin', 'Dest', 'driving');
    expect(est).not.toBeNull();
    expect(est!.source).toBe('osrm');
    expect(est!.distanceMeters).toBe(4000);
  });

  it('falls back to a straight-line estimate when routing fails (source: estimate)', async () => {
    const fetchImpl = makeFetch([
      {
        match: 'geocoding-api.open-meteo.com',
        body: { results: [{ latitude: 10.0, longitude: 20.0 }] },
      },
      // OSRM unavailable.
      { match: 'router.project-osrm.org', ok: false, body: {} },
    ]);
    const provider = createTravelProvider({ fetchImpl });
    const est = await provider.estimate('Origin', 'Dest', 'walking');
    expect(est).not.toBeNull();
    expect(est!.source).toBe('estimate');
    // Same coords → ~0 distance + mode overhead (walking overhead is 0).
    expect(est!.distanceMeters).toBeGreaterThanOrEqual(0);
    expect(est!.durationSeconds).toBeGreaterThanOrEqual(0);
  });

  it('returns null when geocoding fails and no Google key is available', async () => {
    const fetchImpl = makeFetch([{ match: 'geocoding-api.open-meteo.com', ok: false, body: {} }]);
    const provider = createTravelProvider({ fetchImpl });
    const est = await provider.estimate('Nowhere', 'Elsewhere', 'driving');
    expect(est).toBeNull();
  });

  it('returns null for blank inputs without touching the network', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
    const provider = createTravelProvider({ fetchImpl });
    expect(await provider.estimate('', 'B', 'driving')).toBeNull();
    expect(await provider.estimate('A', '   ', 'driving')).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('memoises geocode lookups so repeated locations are only resolved once', async () => {
    const fetchImpl = makeFetch([
      { match: 'geocoding-api.open-meteo.com', body: { results: [{ latitude: 1, longitude: 2 }] } },
      { match: 'router.project-osrm.org', body: { code: 'Ok', routes: [{ distance: 100, duration: 60 }] } },
    ]);
    const spy = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const provider = createTravelProvider({ fetchImpl });
    await provider.estimate('Home', 'Office', 'driving');
    await provider.estimate('Home', 'Office', 'driving');
    const geocodeCalls = spy.mock.calls.filter((c) => String(c[0]).includes('geocoding-api.open-meteo.com'));
    // Two unique places, geocoded once each despite two estimate() calls.
    expect(geocodeCalls.length).toBe(2);
  });

  it('haversineMeters is ~0 for identical points and grows with distance', () => {
    const a = { lat: 10, lon: 20 };
    expect(haversineMeters(a, a)).toBeLessThan(1);
    const far = haversineMeters({ lat: 10, lon: 20 }, { lat: 11, lon: 21 });
    expect(far).toBeGreaterThan(100_000); // ~1 degree apart
  });
});

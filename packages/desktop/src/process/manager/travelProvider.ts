/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Travel-time estimation for the AI schedule optimiser (Requirement 8,
 * criterion 8.3c — "group nearby items, account for travel time").
 *
 * World-class personal planners ("leave by 8:40 to make your 9:00") need a real
 * estimate of how long it takes to get from one located event to the next. This
 * module provides that with a graceful three-tier strategy so it works with or
 * without a Google key:
 *
 * 1. **Google Maps Platform** (when the user configured an API key): Geocoding
 *    API → lat/lon, then Distance Matrix API → mode-aware duration/distance.
 *    Most accurate (real road network, traffic-free baseline, transit).
 * 2. **Keyless OSM/OSRM** (no key): Open-Meteo/Nominatim-style geocode via
 *    Open-Meteo's geocoder + the public OSRM router for driving distance/time.
 * 3. **Straight-line estimate** (last resort / offline): haversine distance ÷ a
 *    mode-specific average speed, with a fixed overhead. Never throws.
 *
 * Each tier degrades to the next on any failure, and the final result records
 * which `source` produced it so the UI can be transparent. All network access
 * happens here in the Main process (no renderer CORS), mirroring
 * `weatherProvider`/`webSearch`.
 *
 * Testability: the `fetch` implementation is injectable so tests exercise every
 * tier (and the offline fallback) without real network access.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type { TravelMode } from './managerTypes';

/** A single resolved travel estimate between two places. */
export type TravelEstimate = {
  distanceMeters: number;
  durationSeconds: number;
  mode: TravelMode;
  source: 'google' | 'osrm' | 'estimate';
};

/** Minimal `fetch` surface used here (injectable for tests). */
export type FetchLike = (
  url: string,
  init?: { headers?: Record<string, string> }
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type TravelProviderOptions = {
  /** Defaults to the global `fetch`. Injectable for tests. */
  fetchImpl?: FetchLike;
  /** Google Maps Platform API key. When absent, the keyless tiers are used. */
  googleApiKey?: string | null;
};

const resolveFetch = (options?: TravelProviderOptions): FetchLike | undefined =>
  options?.fetchImpl ?? (typeof fetch === 'function' ? (fetch as unknown as FetchLike) : undefined);

const GOOGLE_GEOCODE = 'https://maps.googleapis.com/maps/api/geocode/json';
const GOOGLE_MATRIX = 'https://maps.googleapis.com/maps/api/distancematrix/json';
const OM_GEOCODE = 'https://geocoding-api.open-meteo.com/v1/search';
const OSRM_ROUTE = 'https://router.project-osrm.org/route/v1';

/** Average speeds (m/s) per mode for the straight-line fallback. */
const AVG_SPEED_MPS: Record<TravelMode, number> = {
  walking: 1.35, // ~4.9 km/h
  bicycling: 4.2, // ~15 km/h
  driving: 11.1, // ~40 km/h (urban)
  transit: 7.0, // ~25 km/h door-to-door incl. waits
};

/** Fixed per-trip overhead (s) — parking, waiting, last-leg walk. */
const MODE_OVERHEAD_S: Record<TravelMode, number> = {
  walking: 0,
  bicycling: 60,
  driving: 240,
  transit: 360,
};

/** Map our mode to Google's Distance Matrix `mode` parameter. */
const googleMode = (mode: TravelMode): string => (mode === 'bicycling' ? 'bicycling' : mode);

/** Map our mode to the OSRM profile (OSRM public only serves `driving`). */
const osrmProfile = (mode: TravelMode): string => (mode === 'driving' ? 'driving' : 'driving');

const toRad = (deg: number): number => (deg * Math.PI) / 180;

/** Great-circle distance in metres between two lat/lon points. */
export const haversineMeters = (a: LatLon, b: LatLon): number => {
  const R = 6_371_000;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};

export type LatLon = { lat: number; lon: number };

// ---------------------------------------------------------------------------
// Geocoding (cached per provider instance)
// ---------------------------------------------------------------------------

const geocodeGoogle = async (location: string, fetchImpl: FetchLike, key: string): Promise<LatLon | null> => {
  try {
    const url = `${GOOGLE_GEOCODE}?address=${encodeURIComponent(location)}&key=${encodeURIComponent(key)}`;
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const body = (await res.json()) as {
      status?: string;
      results?: Array<{ geometry?: { location?: { lat?: number; lng?: number } } }>;
    };
    const loc = body.results?.[0]?.geometry?.location;
    if (body.status !== 'OK' || !loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') return null;
    return { lat: loc.lat, lon: loc.lng };
  } catch {
    return null;
  }
};

const geocodeKeyless = async (location: string, fetchImpl: FetchLike): Promise<LatLon | null> => {
  try {
    const url = `${OM_GEOCODE}?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const body = (await res.json()) as { results?: Array<{ latitude?: number; longitude?: number }> };
    const hit = body.results?.[0];
    if (!hit || typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') return null;
    return { lat: hit.latitude, lon: hit.longitude };
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------------------
// Travel provider
// ---------------------------------------------------------------------------

/** Public contract of the travel-time provider. */
export type ITravelProvider = {
  /** Estimate travel between two free-text locations using the best tier available. */
  estimate(from: string, to: string, mode: TravelMode): Promise<TravelEstimate | null>;
};

/**
 * Create a travel provider. When `googleApiKey` is set it prefers Google; in all
 * cases it degrades gracefully and never throws. Geocode lookups are memoised
 * for the provider's lifetime so a day's worth of legs sharing locations only
 * geocode each place once.
 */
export const createTravelProvider = (options?: TravelProviderOptions): ITravelProvider => {
  const fetchImpl = resolveFetch(options);
  const key = (options?.googleApiKey ?? '').trim() || null;
  const geocodeCache = new Map<string, LatLon | null>();

  const geocode = async (location: string): Promise<LatLon | null> => {
    const trimmed = location.trim();
    if (!trimmed) return null;
    const cacheKey = `${key ? 'g' : 'k'}:${trimmed.toLowerCase()}`;
    if (geocodeCache.has(cacheKey)) return geocodeCache.get(cacheKey) ?? null;
    let result: LatLon | null = null;
    if (fetchImpl) {
      result = key ? await geocodeGoogle(trimmed, fetchImpl, key) : await geocodeKeyless(trimmed, fetchImpl);
      // If Google failed for any reason, still try the keyless geocoder so the
      // straight-line fallback has coordinates to work with.
      if (!result && key) result = await geocodeKeyless(trimmed, fetchImpl);
    }
    geocodeCache.set(cacheKey, result);
    return result;
  };

  /** Tier 1 — Google Distance Matrix (needs key + located endpoints). */
  const viaGoogle = async (from: string, to: string, mode: TravelMode): Promise<TravelEstimate | null> => {
    if (!fetchImpl || !key) return null;
    try {
      const url =
        `${GOOGLE_MATRIX}?origins=${encodeURIComponent(from)}&destinations=${encodeURIComponent(to)}` +
        `&mode=${googleMode(mode)}&key=${encodeURIComponent(key)}`;
      const res = await fetchImpl(url);
      if (!res.ok) return null;
      const body = (await res.json()) as {
        status?: string;
        rows?: Array<{
          elements?: Array<{ status?: string; distance?: { value?: number }; duration?: { value?: number } }>;
        }>;
      };
      const el = body.rows?.[0]?.elements?.[0];
      if (body.status !== 'OK' || !el || el.status !== 'OK') return null;
      const distanceMeters = el.distance?.value;
      const durationSeconds = el.duration?.value;
      if (typeof distanceMeters !== 'number' || typeof durationSeconds !== 'number') return null;
      return { distanceMeters, durationSeconds, mode, source: 'google' };
    } catch {
      return null;
    }
  };

  /** Tier 2 — keyless OSRM driving route (geocode both ends first). */
  const viaOsrm = async (a: LatLon, b: LatLon, mode: TravelMode): Promise<TravelEstimate | null> => {
    if (!fetchImpl) return null;
    try {
      const url = `${OSRM_ROUTE}/${osrmProfile(mode)}/${a.lon},${a.lat};${b.lon},${b.lat}?overview=false`;
      const res = await fetchImpl(url);
      if (!res.ok) return null;
      const body = (await res.json()) as {
        code?: string;
        routes?: Array<{ distance?: number; duration?: number }>;
      };
      const route = body.routes?.[0];
      if (body.code !== 'Ok' || !route || typeof route.distance !== 'number' || typeof route.duration !== 'number') {
        return null;
      }
      // OSRM only routes driving; scale the duration for other modes by speed ratio.
      const scale = mode === 'driving' ? 1 : AVG_SPEED_MPS.driving / AVG_SPEED_MPS[mode];
      return {
        distanceMeters: route.distance,
        durationSeconds: Math.round(route.duration * scale) + MODE_OVERHEAD_S[mode],
        mode,
        source: 'osrm',
      };
    } catch {
      return null;
    }
  };

  /** Tier 3 — straight-line haversine ÷ average speed (always available with coords). */
  const viaEstimate = (a: LatLon, b: LatLon, mode: TravelMode): TravelEstimate => {
    const straight = haversineMeters(a, b);
    // Real roads are longer than straight lines; apply a detour factor.
    const distanceMeters = straight * 1.3;
    const durationSeconds = Math.round(distanceMeters / AVG_SPEED_MPS[mode]) + MODE_OVERHEAD_S[mode];
    return { distanceMeters, durationSeconds, mode, source: 'estimate' };
  };

  return {
    async estimate(from, to, mode) {
      const f = from.trim();
      const t = to.trim();
      if (!f || !t) return null;

      // Tier 1: Google end-to-end (handles its own geocoding).
      const google = await viaGoogle(f, t, mode);
      if (google) return google;

      // Need coordinates for the keyless tiers.
      const [a, b] = await Promise.all([geocode(f), geocode(t)]);
      if (!a || !b) return null;

      // Tier 2: OSRM road route.
      const osrm = await viaOsrm(a, b, mode);
      if (osrm) return osrm;

      // Tier 3: straight-line estimate (offline-safe).
      return viaEstimate(a, b, mode);
    },
  };
};

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Keyless IP-based geolocation for the weather widget's "auto" mode.
 *
 * Desktop apps can't use the browser Geolocation API without a real browser
 * permission prompt (and Electron's is unreliable), so we approximate the
 * user's city from their public IP via free, no-key endpoints. We try a couple
 * of providers in order because any single one may rate-limit (429) or block
 * (403) at any time — `ipapi.co` in particular rate-limits aggressively. Each
 * provider returns lat/lon directly so the caller can skip a geocoding round
 * trip when coordinates are present.
 *
 * Best-effort: every failure path degrades to `null` so the caller can fall
 * back to asking the user to type a location.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

/** Minimal fetch surface (injectable for tests). */
export type FetchLike = typeof fetch;

/** Resolved approximate location. */
export type DetectedLocation = {
  /** City name suitable for display / the Open-Meteo geocoder. */
  city: string;
  /** Latitude, when the provider supplies it (skips a geocode call). */
  latitude?: number;
  /** Longitude, when the provider supplies it. */
  longitude?: number;
  region?: string;
  country?: string;
};

const TIMEOUT_MS = 6_000;

/** One provider attempt: fetch + map its JSON shape to {@link DetectedLocation}. */
type Provider = { url: string; map: (body: unknown) => DetectedLocation | null };

const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/**
 * Provider chain, ordered by **accuracy** (verified against a Viettel VN IP that
 * resolves to Tây Ninh), all keyless:
 *  1. ip.sb     — HTTPS, most accurate (returns "Tay Ninh" + province + lat/lon).
 *  2. geojs     — HTTPS, reliable but coarser (province capital, e.g. HCMC).
 *  3. ip-api.com — HTTP only (may be blocked in Electron); good city accuracy.
 *  4. freeipapi — HTTPS fallback. NOTE: never use its `capital` field — for any
 *     Vietnamese IP that is always "Hanoi", which mislocates everyone outside it.
 */
const PROVIDERS: Provider[] = [
  {
    url: 'https://api.ip.sb/geoip',
    map: (b) => {
      const o = b as Record<string, unknown>;
      const city = str(o.city) || str(o.region);
      if (!city) return null;
      return {
        city,
        latitude: num(o.latitude),
        longitude: num(o.longitude),
        region: str(o.region) || undefined,
        country: str(o.country) || undefined,
      };
    },
  },
  {
    url: 'https://get.geojs.io/v1/ip/geo.json',
    map: (b) => {
      const o = b as Record<string, unknown>;
      const city = str(o.city) || str(o.region);
      if (!city) return null;
      // geojs returns lat/lon as strings.
      const lat = typeof o.latitude === 'string' ? Number(o.latitude) : num(o.latitude);
      const lon = typeof o.longitude === 'string' ? Number(o.longitude) : num(o.longitude);
      return {
        city,
        latitude: Number.isFinite(lat) ? lat : undefined,
        longitude: Number.isFinite(lon) ? lon : undefined,
        region: str(o.region) || undefined,
        country: str(o.country) || undefined,
      };
    },
  },
  {
    url: 'http://ip-api.com/json/?fields=status,country,regionName,city,lat,lon',
    map: (b) => {
      const o = b as Record<string, unknown>;
      if (o.status !== 'success') return null;
      const city = str(o.city) || str(o.regionName);
      if (!city) return null;
      return {
        city,
        latitude: num(o.lat),
        longitude: num(o.lon),
        region: str(o.regionName) || undefined,
        country: str(o.country) || undefined,
      };
    },
  },
  {
    url: 'https://freeipapi.com/api/json',
    map: (b) => {
      const o = b as Record<string, unknown>;
      // IMPORTANT: do NOT fall back to `capital` — see note above.
      const city = str(o.cityName) || str(o.regionName);
      if (!city) return null;
      return { city, latitude: num(o.latitude), longitude: num(o.longitude), country: str(o.countryName) || undefined };
    },
  },
];

/** Fetch one provider with a timeout, returning its parsed JSON or `null`. */
const tryProvider = async (provider: Provider, doFetch: FetchLike): Promise<DetectedLocation | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(provider.url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'AionUi-News/1.0' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as unknown;
    return provider.map(body);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Detect the user's approximate location from their public IP. Tries each
 * provider in order until one succeeds. Returns `null` if all fail. Never
 * throws.
 */
export const detectLocationByIp = async (deps: { fetch?: FetchLike } = {}): Promise<DetectedLocation | null> => {
  const doFetch = deps.fetch ?? fetch;
  for (const provider of PROVIDERS) {
    const hit = await tryProvider(provider, doFetch);
    if (hit) {
      console.log(
        `[geoLocation] resolved via ${provider.url} → city="${hit.city}" region="${hit.region ?? ''}" lat=${hit.latitude} lon=${hit.longitude}`
      );
      return hit;
    }
    console.log(`[geoLocation] provider failed: ${provider.url}`);
  }
  console.log('[geoLocation] all providers failed');
  return null;
};

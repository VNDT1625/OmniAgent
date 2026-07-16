/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Weather resolution for the realtime sidebar widget.
 *
 * Two paths, both keyless (Open-Meteo):
 *  - {@link forecastByCoords} — when lat/lon are already known (e.g. from IP
 *    detection), skip geocoding entirely. This is the robust path.
 *  - {@link forecastByCity} — geocode a free-text city then forecast (used when
 *    the user types a location).
 *
 * Returns a {@link WeatherForecast} shaped exactly like the Manager provider so
 * the renderer type stays unchanged. Never throws — failures degrade to `null`.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

import type { WeatherForecast, DailyForecast } from '@process/manager/weatherProvider';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const TIMEOUT_MS = 8_000;

/** Map a WMO weather code to a short English label. */
const wmoSummary = (code: number): string => {
  if (code === 0) return 'Clear';
  if (code <= 3) return 'Partly cloudy';
  if (code <= 48) return 'Fog';
  if (code <= 67) return 'Rain';
  if (code <= 77) return 'Snow';
  if (code <= 82) return 'Rain showers';
  if (code <= 86) return 'Snow showers';
  if (code <= 99) return 'Thunderstorm';
  return 'Unknown';
};

type FetchLike = typeof fetch;

const fetchJson = async (url: string, doFetch: FetchLike): Promise<unknown | null> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await doFetch(url, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return (await res.json()) as unknown;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/** Build the daily forecast array from an Open-Meteo `daily` block. */
const mapDaily = (daily: Record<string, unknown> | undefined): DailyForecast[] => {
  if (!daily || !Array.isArray(daily.time)) return [];
  const time = daily.time as string[];
  const code = (daily.weather_code as number[]) ?? [];
  const tmax = (daily.temperature_2m_max as number[]) ?? [];
  const tmin = (daily.temperature_2m_min as number[]) ?? [];
  const pop = (daily.precipitation_probability_max as number[]) ?? [];
  return time.map((date, i) => ({
    date,
    weatherCode: code[i] ?? 0,
    tempMaxC: tmax[i] ?? Number.NaN,
    tempMinC: tmin[i] ?? Number.NaN,
    precipitationProbability: pop[i],
    summary: wmoSummary(code[i] ?? 0),
  }));
};

/**
 * Fetch a forecast directly from coordinates (no geocoding). The most reliable
 * path — used when IP detection already provided lat/lon.
 */
export const forecastByCoords = async (
  latitude: number,
  longitude: number,
  label: string,
  days = 5,
  doFetch: FetchLike = fetch
): Promise<WeatherForecast | null> => {
  const n = Math.min(16, Math.max(1, Math.floor(days)));
  const url =
    `${FORECAST_URL}?latitude=${latitude}&longitude=${longitude}` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
    `&forecast_days=${n}&timezone=auto`;
  const body = (await fetchJson(url, doFetch)) as { daily?: Record<string, unknown> } | null;
  if (!body) return null;
  const out = mapDaily(body.daily);
  if (out.length === 0) return null;
  return { location: label, latitude, longitude, days: out };
};

/**
 * Geocode a free-text city then forecast. Used when the user types a location.
 */
export const forecastByCity = async (
  city: string,
  days = 5,
  doFetch: FetchLike = fetch
): Promise<WeatherForecast | null> => {
  const trimmed = city.trim();
  if (!trimmed) return null;
  const geoUrl = `${GEOCODE_URL}?name=${encodeURIComponent(trimmed)}&count=1&language=en&format=json`;
  const geo = (await fetchJson(geoUrl, doFetch)) as {
    results?: Array<{ latitude?: number; longitude?: number; name?: string }>;
  } | null;
  const hit = geo?.results?.[0];
  if (!hit || typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') return null;
  return forecastByCoords(hit.latitude, hit.longitude, hit.name ?? trimmed, days, doFetch);
};

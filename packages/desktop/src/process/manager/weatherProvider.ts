/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Weather lookup for the AI schedule optimiser (Requirement 8, criterion 8.3,
 * 8.4).
 *
 * Uses **Open-Meteo** — a free, no-API-key forecast service with a companion
 * geocoding endpoint — so the user never has to configure a third-party key
 * (design decision: prefer a keyless source). This is the only external network
 * dependency of the Manager feature, and it is **optional**: every failure path
 * (weather disabled, offline, missing location, geocode miss, HTTP error,
 * malformed body) degrades to `null`. The optimiser then drops the weather
 * factor and notes that in its rationale, rather than failing the whole run.
 *
 * Testability: the `fetch` implementation is injectable so tests exercise the
 * degrade paths without real network access.
 *
 * Process boundary: Main-process (Node.js) module. No DOM APIs.
 */

/** A daily forecast entry for one calendar day. */
export type DailyForecast = {
  /** ISO date `YYYY-MM-DD`. */
  date: string;
  /** WMO weather code (https://open-meteo.com/en/docs). */
  weatherCode: number;
  tempMaxC: number;
  tempMinC: number;
  /** Probability of precipitation (%) — may be absent. */
  precipitationProbability?: number;
  /** Short human label derived from {@link weatherCode}. */
  summary: string;
};

/** The compact forecast the optimiser embeds in its prompt. */
export type WeatherForecast = {
  location: string;
  latitude: number;
  longitude: number;
  days: DailyForecast[];
};

/** Minimal `fetch` surface used here (injectable for tests). */
export type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export type WeatherProviderOptions = {
  /** Defaults to the global `fetch`. Injectable for tests. */
  fetchImpl?: FetchLike;
};

const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/** Map a WMO weather code to a short English label (kept dependency-free). */
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

const resolveFetch = (options?: WeatherProviderOptions): FetchLike | undefined =>
  options?.fetchImpl ?? (typeof fetch === 'function' ? (fetch as unknown as FetchLike) : undefined);

/** Geocode a free-text location to lat/lon. Returns `null` on any failure. */
const geocode = async (
  location: string,
  fetchImpl: FetchLike
): Promise<{ latitude: number; longitude: number; name: string } | null> => {
  try {
    const url = `${GEOCODE_URL}?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const body = (await res.json()) as { results?: Array<{ latitude?: number; longitude?: number; name?: string }> };
    const hit = body.results?.[0];
    if (!hit || typeof hit.latitude !== 'number' || typeof hit.longitude !== 'number') return null;
    return { latitude: hit.latitude, longitude: hit.longitude, name: hit.name ?? location };
  } catch {
    return null;
  }
};

/**
 * Fetch a daily forecast for `location` over the next `days` days.
 *
 * Returns `null` whenever weather cannot be determined (missing location,
 * geocode miss, network/HTTP error, malformed body) so the caller can degrade
 * safely. Never throws.
 */
export const getForecast = async (
  location: string | null | undefined,
  days = 7,
  options?: WeatherProviderOptions
): Promise<WeatherForecast | null> => {
  const trimmed = (location ?? '').trim();
  if (!trimmed) return null;

  const fetchImpl = resolveFetch(options);
  if (!fetchImpl) return null;

  const geo = await geocode(trimmed, fetchImpl);
  if (!geo) return null;

  try {
    const forecastDays = Math.min(16, Math.max(1, Math.floor(days)));
    const url =
      `${FORECAST_URL}?latitude=${geo.latitude}&longitude=${geo.longitude}` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max` +
      `&forecast_days=${forecastDays}&timezone=auto`;
    const res = await fetchImpl(url);
    if (!res.ok) return null;
    const body = (await res.json()) as {
      daily?: {
        time?: string[];
        weather_code?: number[];
        temperature_2m_max?: number[];
        temperature_2m_min?: number[];
        precipitation_probability_max?: number[];
      };
    };
    const daily = body.daily;
    if (!daily || !Array.isArray(daily.time)) return null;

    const out: DailyForecast[] = daily.time.map((date, i) => {
      const code = daily.weather_code?.[i] ?? 0;
      return {
        date,
        weatherCode: code,
        tempMaxC: daily.temperature_2m_max?.[i] ?? Number.NaN,
        tempMinC: daily.temperature_2m_min?.[i] ?? Number.NaN,
        precipitationProbability: daily.precipitation_probability_max?.[i],
        summary: wmoSummary(code),
      };
    });

    return { location: geo.name, latitude: geo.latitude, longitude: geo.longitude, days: out };
  } catch {
    return null;
  }
};

/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for process/manager/weatherProvider — Open-Meteo lookup with safe
 * degradation (Requirement 8.3, 8.4). Uses an injected fetch so no network is
 * touched.
 */

import { describe, expect, it, vi } from 'vitest';
import type { FetchLike } from '@/process/manager/weatherProvider';
import { getForecast } from '@/process/manager/weatherProvider';

const okJson = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

describe('getForecast — happy path', () => {
  it('geocodes then returns a daily forecast', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url: string) => {
      if (url.includes('geocoding-api')) {
        return okJson({ results: [{ latitude: 21.02, longitude: 105.84, name: 'Hanoi' }] });
      }
      return okJson({
        daily: {
          time: ['2026-06-01', '2026-06-02'],
          weather_code: [0, 61],
          temperature_2m_max: [33, 30],
          temperature_2m_min: [26, 25],
          precipitation_probability_max: [10, 80],
        },
      });
    });

    const forecast = await getForecast('Hanoi', 2, { fetchImpl });
    expect(forecast).not.toBeNull();
    expect(forecast?.location).toBe('Hanoi');
    expect(forecast?.days).toHaveLength(2);
    expect(forecast?.days[0].summary).toBe('Clear');
    expect(forecast?.days[1].summary).toBe('Rain');
    expect(forecast?.days[1].precipitationProbability).toBe(80);
  });
});

describe('getForecast — safe degradation (returns null, never throws)', () => {
  it('returns null for empty/blank location', async () => {
    const fetchImpl = vi.fn<FetchLike>();
    expect(await getForecast('', 7, { fetchImpl })).toBeNull();
    expect(await getForecast('   ', 7, { fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('returns null when geocoding finds nothing', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => okJson({ results: [] }));
    expect(await getForecast('Nowhereville', 7, { fetchImpl })).toBeNull();
  });

  it('returns null on a non-OK HTTP response', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => ({ ok: false, status: 500, json: async () => ({}) }));
    expect(await getForecast('Hanoi', 7, { fetchImpl })).toBeNull();
  });

  it('returns null when fetch throws (offline)', async () => {
    const fetchImpl = vi.fn<FetchLike>(async () => {
      throw new Error('network down');
    });
    expect(await getForecast('Hanoi', 7, { fetchImpl })).toBeNull();
  });

  it('returns null when the forecast body is malformed', async () => {
    const fetchImpl = vi.fn<FetchLike>(async (url: string) => {
      if (url.includes('geocoding-api')) return okJson({ results: [{ latitude: 1, longitude: 2, name: 'X' }] });
      return okJson({ daily: null });
    });
    expect(await getForecast('X', 7, { fetchImpl })).toBeNull();
  });
});

/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WeatherWidget — compact 5-day forecast card for the realtime sidebar.
 *
 * Defaults to **auto** mode: on first load it asks the bridge for weather with
 * no location, which triggers IP-based city detection in the Main process. The
 * user can override by clicking the card and typing a city; the override (or
 * empty = auto) is remembered in localStorage. Degrades quietly on failure.
 *
 * Process boundary: Renderer. No Node.js APIs.
 */

import { Button, Input, Typography } from '@arco-design/web-react';
import { Local, Edit, Sun, Sunny, HeavyRain, LightRain, Snow, Thunderstorm, Cloudy } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { newsClient } from '../newsBridgeClient';
import type { WeatherForecast } from '@process/news/newsBridge';

const { Text } = Typography;

const STORAGE_KEY = 'aionui.news.weatherLocation';

/** Map a WMO weather code to an Icon-Park icon. */
const weatherIcon = (code: number, size = '20'): React.ReactElement => {
  if (code === 0) return <Sun theme='filled' size={size} className='text-warning' />;
  if (code <= 3) return <Sunny theme='outline' size={size} className='text-warning' />;
  if (code <= 48) return <Cloudy theme='outline' size={size} className='text-t-secondary' />;
  if (code <= 60 || (code >= 80 && code <= 82))
    return <LightRain theme='outline' size={size} className='text-primary-5' />;
  if (code <= 67) return <HeavyRain theme='outline' size={size} className='text-primary-5' />;
  if (code <= 77 || (code >= 85 && code <= 86)) return <Snow theme='outline' size={size} className='text-primary-3' />;
  if (code >= 95) return <Thunderstorm theme='outline' size={size} className='text-warning' />;
  return <Cloudy theme='outline' size={size} className='text-t-secondary' />;
};

const DAY_LABELS_VI = ['CN', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7'];
const DAY_LABELS_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const WeatherWidget: React.FC = () => {
  const { t, i18n } = useTranslation();
  // `null` = auto (detect by IP); a string = explicit override.
  const [location, setLocation] = useState<string | null>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return saved && saved.length > 0 ? saved : null;
    } catch {
      return null;
    }
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [forecast, setForecast] = useState<WeatherForecast | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);

  const dayLabels = i18n.language.startsWith('vi') ? DAY_LABELS_VI : DAY_LABELS_EN;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    // Empty location → Main process auto-detects via IP.
    newsClient
      .getWeather({ location: location ?? '' })
      .then((res) => {
        if (cancelled) return;
        if (res.ok) setForecast(res.data);
        else setFailed(true);
      })
      .catch(() => !cancelled && setFailed(true))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [location]);

  const saveLocation = () => {
    const next = draft.trim();
    try {
      if (next) localStorage.setItem(STORAGE_KEY, next);
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setLocation(next || null);
    setEditing(false);
  };

  const useAuto = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    setLocation(null);
    setEditing(false);
  };

  // Editing state — let the user type a city or switch back to auto.
  if (editing) {
    return (
      <div className='rd-10px border border-solid border-border-2 bg-bg-2 p-12px flex flex-col gap-8px'>
        <div className='flex items-center gap-6px'>
          <Sun theme='filled' size='15' className='text-warning' />
          <Text className='text-12px font-600 text-t-secondary'>{t('news.weather.title')}</Text>
        </div>
        <Input
          size='small'
          placeholder={t('news.weather.locationPlaceholder')}
          value={draft}
          onChange={setDraft}
          onPressEnter={saveLocation}
        />
        <div className='flex gap-6px'>
          <Button type='primary' size='mini' className='flex-1' onClick={saveLocation}>
            {t('news.weather.setLocation')}
          </Button>
          <Button size='mini' icon={<Local theme='outline' size='12' />} onClick={useAuto}>
            {t('news.weather.useAuto')}
          </Button>
        </div>
      </div>
    );
  }

  const today = forecast?.days[0];

  return (
    <div className='rd-10px border border-solid border-border-2 bg-bg-2 overflow-hidden'>
      {/* Current */}
      <div
        className='group flex items-center gap-10px p-12px cursor-pointer hover:bg-fill-1 transition-colors'
        onClick={() => {
          setDraft(location ?? '');
          setEditing(true);
        }}
        title={t('news.weather.setLocation')}
      >
        {today ? (
          <>
            {weatherIcon(today.weatherCode, '32')}
            <div className='flex-1 min-w-0'>
              <div className='text-18px font-700 text-t-primary leading-22px'>
                {Number.isFinite(today.tempMaxC) ? Math.round(today.tempMaxC) : '--'}°
              </div>
              <div className='flex items-center gap-3px'>
                {location === null && <Local theme='outline' size='10' className='text-t-tertiary shrink-0' />}
                <Text className='text-11px text-t-tertiary truncate'>{forecast?.location ?? location}</Text>
              </div>
            </div>
            <div className='flex flex-col items-end gap-2px shrink-0'>
              <Edit
                theme='outline'
                size='13'
                className='text-t-tertiary opacity-0 group-hover:opacity-100 transition-opacity'
              />
              <Text className='text-11px text-t-tertiary text-right'>{today.summary}</Text>
            </div>
          </>
        ) : (
          <>
            <Sun theme='filled' size='20' className='text-warning' />
            <Text className='text-11px text-t-tertiary flex-1'>
              {loading ? '…' : failed ? t('news.weather.unavailable') : t('news.weather.title')}
            </Text>
            <Edit theme='outline' size='13' className='text-t-tertiary shrink-0' />
          </>
        )}
      </div>

      {/* 5-day strip */}
      {forecast && forecast.days.length > 1 && (
        <div className='flex border-t border-solid border-border-2'>
          {forecast.days.slice(0, 5).map((day, idx) => {
            const d = new Date(day.date);
            return (
              <div
                key={day.date}
                className='flex-1 flex flex-col items-center gap-2px py-8px border-r border-solid border-border-2 last:border-r-0'
              >
                <Text className='text-10px text-t-tertiary'>
                  {idx === 0 ? dayLabels[d.getDay()] : dayLabels[d.getDay()]}
                </Text>
                {weatherIcon(day.weatherCode, '16')}
                <Text className='text-10px font-600 text-t-primary'>
                  {Number.isFinite(day.tempMaxC) ? Math.round(day.tempMaxC) : '--'}°
                </Text>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

export default WeatherWidget;

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Manager schedule settings (Requirement 8.3/8.4) — the controls that make the
 * AI schedule optimiser world-class:
 *
 * - **Weather**: toggle + a default location used when an event has none.
 * - **Travel time**: toggle + travel mode + an optional Google Maps API key for
 *   accurate geocoding & Distance Matrix routing (degrades to keyless OSM/OSRM,
 *   then a straight-line estimate, when no key is set) + an optional home/base
 *   location used as the first trip origin of each day.
 *
 * All values persist through `manager.update-settings`. The API key is stored
 * locally in `manager-data.json` like the rest of the document (never uploaded).
 *
 * Renderer-only. No Node.js APIs.
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Input, Message, Modal, Select, Switch } from '@arco-design/web-react';
import type { ManagerSettings, TravelMode } from '@process/manager/managerTypes';
import type { UseManagerStore } from '../useManagerStore';

const Option = Select.Option;

const TRAVEL_MODES: readonly TravelMode[] = ['driving', 'transit', 'bicycling', 'walking'];

const ManagerSettingsModal: React.FC<{ store: UseManagerStore; onClose: () => void }> = ({ store, onClose }) => {
  const { t } = useTranslation();
  const s = store.data.settings;

  const [weatherEnabled, setWeatherEnabled] = useState(s.weatherEnabled);
  const [defaultLocation, setDefaultLocation] = useState(s.defaultLocation ?? '');
  const [travelTimeEnabled, setTravelTimeEnabled] = useState(s.travelTimeEnabled);
  const [travelMode, setTravelMode] = useState<TravelMode>(s.travelMode);
  const [homeLocation, setHomeLocation] = useState(s.homeLocation ?? '');
  const [googleMapsApiKey, setGoogleMapsApiKey] = useState(s.googleMapsApiKey ?? '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const patch: Partial<ManagerSettings> = {
        weatherEnabled,
        defaultLocation: defaultLocation.trim() || null,
        travelTimeEnabled,
        travelMode,
        homeLocation: homeLocation.trim() || null,
        googleMapsApiKey: googleMapsApiKey.trim() || null,
      };
      const ok = await store.run(() => store.client.updateSettings({ patch }));
      if (ok) {
        Message.success(t('manager.settings.saved'));
        onClose();
      } else {
        Message.error(t('manager.settings.saveFailed'));
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      visible
      title={t('manager.settings.title')}
      onCancel={onClose}
      onOk={() => void save()}
      okText={t('manager.settings.save')}
      cancelText={t('manager.settings.cancel')}
      confirmLoading={saving}
      style={{ width: 540 }}
    >
      <div className='flex flex-col gap-18px'>
        {/* Weather */}
        <section className='flex flex-col gap-10px'>
          <div className='flex items-center justify-between'>
            <div className='text-14px font-[600] text-t-primary'>{t('manager.settings.weatherTitle')}</div>
            <Switch checked={weatherEnabled} onChange={setWeatherEnabled} />
          </div>
          <div className='text-12px text-t-tertiary'>{t('manager.settings.weatherDesc')}</div>
          {weatherEnabled && (
            <div>
              <div className='text-12px text-t-secondary mb-4px'>{t('manager.settings.defaultLocation')}</div>
              <Input
                value={defaultLocation}
                onChange={setDefaultLocation}
                placeholder={t('manager.settings.locationPlaceholder')}
                allowClear
              />
            </div>
          )}
        </section>

        <div className='h-1px bg-arco-2' />

        {/* Travel time */}
        <section className='flex flex-col gap-10px'>
          <div className='flex items-center justify-between'>
            <div className='text-14px font-[600] text-t-primary'>{t('manager.settings.travelTitle')}</div>
            <Switch checked={travelTimeEnabled} onChange={setTravelTimeEnabled} />
          </div>
          <div className='text-12px text-t-tertiary'>{t('manager.settings.travelDesc')}</div>
          {travelTimeEnabled && (
            <div className='flex flex-col gap-10px'>
              <div className='flex gap-12px'>
                <div className='flex-1'>
                  <div className='text-12px text-t-secondary mb-4px'>{t('manager.settings.travelMode')}</div>
                  <Select value={travelMode} onChange={setTravelMode}>
                    {TRAVEL_MODES.map((m) => (
                      <Option key={m} value={m}>
                        {t(`manager.settings.mode.${m}`)}
                      </Option>
                    ))}
                  </Select>
                </div>
                <div className='flex-1'>
                  <div className='text-12px text-t-secondary mb-4px'>{t('manager.settings.homeLocation')}</div>
                  <Input
                    value={homeLocation}
                    onChange={setHomeLocation}
                    placeholder={t('manager.settings.locationPlaceholder')}
                    allowClear
                  />
                </div>
              </div>
              <div>
                <div className='text-12px text-t-secondary mb-4px'>{t('manager.settings.googleKey')}</div>
                <Input.Password
                  value={googleMapsApiKey}
                  onChange={setGoogleMapsApiKey}
                  placeholder={t('manager.settings.googleKeyPlaceholder')}
                  allowClear
                />
                <div className='text-11px text-t-tertiary mt-2px'>{t('manager.settings.googleKeyHint')}</div>
              </div>
            </div>
          )}
        </section>
      </div>
    </Modal>
  );
};

export default ManagerSettingsModal;

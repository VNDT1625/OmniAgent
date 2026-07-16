/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `AppearanceModal` — Notion-style "make it yours" controls for the Manager
 * workspace: accent colour, body font, base size, density, and an optional
 * tinted page background. Changes preview live (the page wrapper re-applies the
 * CSS variables) and persist through `manager.update-settings`.
 *
 * Renderer-only. Arco + UnoCSS + i18n. No Node.js APIs.
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Message, Modal, Radio, Slider, Switch } from '@arco-design/web-react';
import { Check } from '@icon-park/react';
import type { AccentColor, FontChoice, ManagerAppearance, ManagerSettings } from '@process/manager/managerTypes';
import type { UseManagerStore } from '../useManagerStore';
import { ACCENT_COLORS, FONT_CHOICES, accentSwatch } from './appearance';

const DEFAULT_APPEARANCE: ManagerAppearance = {
  accent: 'blue',
  font: 'default',
  density: 'comfortable',
  fontSize: 14,
  tintedBackground: false,
};

const AppearanceModal: React.FC<{ store: UseManagerStore; onClose: () => void }> = ({ store, onClose }) => {
  const { t } = useTranslation();
  const current = store.data.settings.appearance ?? DEFAULT_APPEARANCE;

  const [accent, setAccent] = useState<AccentColor>(current.accent);
  const [font, setFont] = useState<FontChoice>(current.font);
  const [density, setDensity] = useState<ManagerAppearance['density']>(current.density);
  const [fontSize, setFontSize] = useState<number>(current.fontSize);
  const [tintedBackground, setTinted] = useState<boolean>(current.tintedBackground);
  const [saving, setSaving] = useState(false);

  /** Persist the appearance. The page wrapper reads settings.appearance live. */
  const commit = async (next: ManagerAppearance): Promise<void> => {
    const patch: Partial<ManagerSettings> = { appearance: next };
    await store.run(() => store.client.updateSettings({ patch }));
  };

  // Live preview: persist on every change (cheap, local file) so the workspace
  // re-themes immediately behind the modal.
  const apply = (next: Partial<ManagerAppearance>) => {
    const merged: ManagerAppearance = { accent, font, density, fontSize, tintedBackground, ...next };
    if (next.accent !== undefined) setAccent(next.accent);
    if (next.font !== undefined) setFont(next.font);
    if (next.density !== undefined) setDensity(next.density);
    if (next.fontSize !== undefined) setFontSize(next.fontSize);
    if (next.tintedBackground !== undefined) setTinted(next.tintedBackground);
    void commit(merged);
  };

  const save = async () => {
    setSaving(true);
    try {
      await commit({ accent, font, density, fontSize, tintedBackground });
      Message.success(t('manager.appearance.saved'));
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      visible
      title={t('manager.appearance.title')}
      onCancel={onClose}
      onOk={() => void save()}
      okText={t('manager.appearance.done')}
      cancelText={t('manager.appearance.cancel')}
      confirmLoading={saving}
      style={{ width: 520 }}
    >
      <div className='flex flex-col gap-18px'>
        {/* Accent */}
        <section className='flex flex-col gap-8px'>
          <div className='text-13px font-[600] text-t-primary'>{t('manager.appearance.accent')}</div>
          <div className='flex items-center gap-10px flex-wrap'>
            {ACCENT_COLORS.map((c) => (
              <span
                key={c}
                onClick={() => apply({ accent: c })}
                className='size-28px rd-full cursor-pointer flex items-center justify-center transition-transform hover:scale-110'
                style={{
                  background: accentSwatch(c),
                  outline: accent === c ? '2px solid var(--color-text-1)' : 'none',
                  outlineOffset: 2,
                }}
                title={t(`manager.appearance.color.${c}`)}
              >
                {accent === c && <Check theme='outline' size='15' fill='#fff' />}
              </span>
            ))}
          </div>
        </section>

        {/* Font */}
        <section className='flex flex-col gap-8px'>
          <div className='text-13px font-[600] text-t-primary'>{t('manager.appearance.font')}</div>
          <Radio.Group type='button' value={font} onChange={(v) => apply({ font: v })}>
            {FONT_CHOICES.map((f) => (
              <Radio key={f} value={f}>
                {t(`manager.appearance.fontChoice.${f}`)}
              </Radio>
            ))}
          </Radio.Group>
        </section>

        {/* Base size */}
        <section className='flex flex-col gap-8px'>
          <div className='flex items-center justify-between'>
            <div className='text-13px font-[600] text-t-primary'>{t('manager.appearance.fontSize')}</div>
            <span className='text-12px text-t-tertiary'>{fontSize}px</span>
          </div>
          <Slider value={fontSize} min={13} max={18} step={1} onChange={(v) => apply({ fontSize: v as number })} />
        </section>

        {/* Density */}
        <section className='flex flex-col gap-8px'>
          <div className='text-13px font-[600] text-t-primary'>{t('manager.appearance.density')}</div>
          <Radio.Group type='button' value={density} onChange={(v) => apply({ density: v })}>
            <Radio value='comfortable'>{t('manager.appearance.comfortable')}</Radio>
            <Radio value='compact'>{t('manager.appearance.compact')}</Radio>
          </Radio.Group>
        </section>

        {/* Tinted background */}
        <section className='flex items-center justify-between'>
          <div>
            <div className='text-13px font-[600] text-t-primary'>{t('manager.appearance.tinted')}</div>
            <div className='text-12px text-t-tertiary'>{t('manager.appearance.tintedDesc')}</div>
          </div>
          <Switch checked={tintedBackground} onChange={(v) => apply({ tintedBackground: v })} />
        </section>
      </div>
    </Modal>
  );
};

export default AppearanceModal;

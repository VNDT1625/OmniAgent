/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ResourceMode } from '@process/resource/leaseTypes';
import { Radio } from '@arco-design/web-react';
import { SettingTwo } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import SectionCard from './SectionCard';

/**
 * Mode switch between the two coordinator modes (criterion 5.2):
 * - `detailed` — the user edits every limit (budget controls become editable).
 * - `suggest`  — the coordinator self-balances (budget controls are read-only).
 *
 * Rendered as an Arco `Radio.Group` in button style so both options and their
 * descriptions stay visible.
 */
const ModeSelector: React.FC<{
  mode: ResourceMode;
  onChange: (mode: ResourceMode) => void;
  disabled?: boolean;
}> = ({ mode, onChange, disabled }) => {
  const { t } = useTranslation();

  const options: { value: ResourceMode; label: string; desc: string }[] = [
    { value: 'detailed', label: t('resource.mode.detailed'), desc: t('resource.mode.detailedDesc') },
    { value: 'suggest', label: t('resource.mode.suggest'), desc: t('resource.mode.suggestDesc') },
  ];

  return (
    <SectionCard icon={<SettingTwo theme='outline' size='18' />} title={t('resource.mode.title')}>
      <Radio.Group
        type='button'
        value={mode}
        disabled={disabled}
        onChange={(value) => onChange(value as ResourceMode)}
        className='mb-12px'
      >
        {options.map((opt) => (
          <Radio key={opt.value} value={opt.value}>
            {opt.label}
          </Radio>
        ))}
      </Radio.Group>
      <p className='m-0 text-12px text-t-tertiary leading-snug'>
        {mode === 'detailed' ? t('resource.mode.detailedDesc') : t('resource.mode.suggestDesc')}
      </p>
    </SectionCard>
  );
};

export default ModeSelector;

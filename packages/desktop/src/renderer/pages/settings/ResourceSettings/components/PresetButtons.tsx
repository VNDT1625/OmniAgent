/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ApplicablePreset, ResourcePreset } from '@process/resource/leaseTypes';
import { Button, Space, Tag } from '@arco-design/web-react';
import { BatteryWorking, GameThree, Lightning } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { APPLICABLE_PRESETS, presetLabelKey } from '../constants';
import SectionCard from './SectionCard';

const PRESET_ICON: Record<ApplicablePreset, React.ReactNode> = {
  saver: <BatteryWorking theme='outline' size='16' />,
  balanced: <GameThree theme='outline' size='16' />,
  performance: <Lightning theme='outline' size='16' />,
};

/**
 * Quick-level preset buttons (criterion 5.3): saver / balanced / performance.
 *
 * The button matching the currently-active preset is highlighted; a `custom`
 * preset (manual edits) highlights none and is shown as a tag in the header.
 */
const PresetButtons: React.FC<{
  current: ResourcePreset;
  onApply: (preset: ApplicablePreset) => void;
  disabled?: boolean;
}> = ({ current, onApply, disabled }) => {
  const { t } = useTranslation();

  const currentLabel =
    current === 'custom' ? t('resource.preset.custom') : t(presetLabelKey(current as ApplicablePreset));

  return (
    <SectionCard
      icon={<Lightning theme='outline' size='18' />}
      title={t('resource.preset.title')}
      subtitle={t('resource.preset.subtitle')}
      extra={
        <Tag bordered size='small'>
          {t('resource.preset.current')}: {currentLabel}
        </Tag>
      }
    >
      <Space wrap size='medium'>
        {APPLICABLE_PRESETS.map((preset) => {
          const active = current === preset;
          return (
            <Button
              key={preset}
              type={active ? 'primary' : 'secondary'}
              disabled={disabled}
              icon={PRESET_ICON[preset]}
              onClick={() => onApply(preset)}
            >
              {t(presetLabelKey(preset))}
            </Button>
          );
        })}
      </Space>
    </SectionCard>
  );
};

export default PresetButtons;

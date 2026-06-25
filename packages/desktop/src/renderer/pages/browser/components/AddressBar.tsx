/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Input, Tooltip } from '@arco-design/web-react';
import { Down, Left, Refresh, Right, Translate, Up } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Address / URL bar for the embedded browser tab (criterion 1.1).
 *
 * Submitting navigates the active tab; the field is treated as a URL or, when it
 * is not URL-like, a web search query (see `normalizeUrl`). Back / forward /
 * reload buttons sit before the field (like any browser). The field's trailing
 * affordance is the Vietnamese-subtitle toggle (criterion 1.6) — the old, redundant
 * "Go" arrow is gone since Enter already submits. A chevron toggles the agent
 * controls row above, to keep the bar compact like a real browser.
 */
const AddressBar: React.FC<{
  /** The URL currently loaded in the active tab, used to seed the field. */
  currentUrl: string;
  disabled?: boolean;
  subtitlesEnabled: boolean;
  /** Whether the agent-controls row above is expanded. */
  controlsExpanded: boolean;
  onSubmit: (input: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: () => void;
  onToggleSubtitles: (enabled: boolean) => void;
  onToggleControls: () => void;
}> = ({
  currentUrl,
  disabled,
  subtitlesEnabled,
  controlsExpanded,
  onSubmit,
  onBack,
  onForward,
  onReload,
  onToggleSubtitles,
  onToggleControls,
}) => {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(currentUrl);

  // Keep the field in sync when the active tab navigates on its own.
  useEffect(() => {
    setDraft(currentUrl);
  }, [currentUrl]);

  const submit = () => {
    const value = draft.trim();
    if (value.length === 0) return;
    onSubmit(value);
  };

  return (
    <div className='flex items-center gap-6px w-full'>
      <Tooltip content={t('browser.address.back')} position='bottom'>
        <Button
          shape='circle'
          type='secondary'
          disabled={disabled}
          aria-label={t('browser.address.back')}
          icon={<Left theme='outline' size='15' />}
          onClick={onBack}
        />
      </Tooltip>
      <Tooltip content={t('browser.address.forward')} position='bottom'>
        <Button
          shape='circle'
          type='secondary'
          disabled={disabled}
          aria-label={t('browser.address.forward')}
          icon={<Right theme='outline' size='15' />}
          onClick={onForward}
        />
      </Tooltip>
      <Tooltip content={t('browser.address.reload')} position='bottom'>
        <Button
          shape='circle'
          type='secondary'
          disabled={disabled}
          aria-label={t('browser.address.reload')}
          icon={<Refresh theme='outline' size='15' />}
          onClick={onReload}
        />
      </Tooltip>

      <Input
        className='flex-1'
        value={draft}
        allowClear
        disabled={disabled}
        placeholder={t('browser.address.placeholder')}
        onChange={setDraft}
        onPressEnter={submit}
        suffix={
          <Tooltip
            content={subtitlesEnabled ? t('browser.subtitle_overlay.disable') : t('browser.subtitle_overlay.enable')}
            position='bottom'
          >
            <Button
              type='text'
              size='mini'
              disabled={disabled}
              aria-label={
                subtitlesEnabled ? t('browser.subtitle_overlay.disable') : t('browser.subtitle_overlay.enable')
              }
              icon={
                <Translate
                  theme={subtitlesEnabled ? 'filled' : 'outline'}
                  size='15'
                  className={subtitlesEnabled ? 'text-primary' : ''}
                />
              }
              onClick={() => onToggleSubtitles(!subtitlesEnabled)}
            />
          </Tooltip>
        }
      />

      <Tooltip
        content={controlsExpanded ? t('browser.toolbar.collapseControls') : t('browser.toolbar.expandControls')}
        position='bottom'
      >
        <Button
          shape='circle'
          type='secondary'
          aria-label={controlsExpanded ? t('browser.toolbar.collapseControls') : t('browser.toolbar.expandControls')}
          icon={controlsExpanded ? <Up theme='outline' size='15' /> : <Down theme='outline' size='15' />}
          onClick={onToggleControls}
        />
      </Tooltip>
    </div>
  );
};

export default AddressBar;

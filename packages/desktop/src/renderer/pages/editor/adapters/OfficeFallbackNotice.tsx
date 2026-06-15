/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `OfficeFallbackNotice` — a slim strip shown above the lightweight fallback
 * editor when the full ONLYOFFICE editor could not open. It explains (briefly)
 * that a simpler editor is in use and offers to retry Office or configure the
 * Document Server. Office is always the default; this only appears after a
 * failure (Docker missing, server unreachable, runtime error).
 *
 * Renderer-only.
 */

import { Alert, Button, Space, Tooltip } from '@arco-design/web-react';
import { Refresh, SettingTwo } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';

type OfficeFallbackNoticeProps = {
  /** Raw failure reason from the Office editor (a `SERVER:<reason>` or message). */
  reason: string;
  onRetry: () => void;
  onSettings: () => void;
};

/** Map a fatal Office reason to a friendly, localized sentence. */
const describeReason = (reason: string, t: (key: string) => string): string => {
  const serverReason = reason.startsWith('SERVER:') ? reason.slice('SERVER:'.length) : null;
  if (serverReason) {
    // Known server reasons have dedicated copy; unknown ones get the generic line.
    const known = ['docker-missing', 'docker-stopped', 'start-failed', 'timeout'];
    if (known.includes(serverReason)) return t(`editor.onlyoffice.reason.${serverReason}`);
    // Unknown SERVER:<reason> — show the raw reason so it isn't hidden.
    return `${t('editor.office.fallbackGeneric')} (${serverReason})`;
  }
  // A runtime/editor error (e.g. the document failed to load in ONLYOFFICE —
  // oversized file, unsupported content). Surface the EXACT message so the user
  // (and we) can see why Office refused, instead of a vague generic line.
  const trimmed = reason.trim();
  if (trimmed.length > 0) {
    return `${t('editor.office.fallbackGeneric')} — ${trimmed}`;
  }
  return t('editor.office.fallbackGeneric');
};

const OfficeFallbackNotice: React.FC<OfficeFallbackNoticeProps> = ({ reason, onRetry, onSettings }) => {
  const { t } = useTranslation();
  return (
    <Alert
      type='warning'
      className='shrink-0'
      title={t('editor.office.fallbackTitle')}
      content={describeReason(reason, t)}
      action={
        <Space size={6}>
          <Button size='mini' type='text' icon={<Refresh theme='outline' size='13' />} onClick={onRetry}>
            {t('editor.office.retry')}
          </Button>
          <Tooltip content={t('editor.onlyoffice.settingsTitle')} mini>
            <Button
              size='mini'
              type='text'
              aria-label={t('editor.onlyoffice.settingsTitle')}
              icon={<SettingTwo theme='outline' size='13' />}
              onClick={onSettings}
            />
          </Tooltip>
        </Space>
      }
    />
  );
};

export default OfficeFallbackNotice;

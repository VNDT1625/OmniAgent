/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button } from '@arco-design/web-react';
import { Terminal } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Friendly "the terminal service is not wired yet" notice with a Retry button.
 * Shown when the Main-process bridge has not registered its channels (the
 * renderer's first probe times out).
 */
const BridgeNotice: React.FC<{ onRetry: () => void }> = ({ onRetry }) => {
  const { t } = useTranslation();
  return (
    <div className='flex flex-col items-center gap-12px py-56px text-center'>
      <span className='size-48px flex-center rd-full bg-fill-2 text-t-tertiary'>
        <Terminal theme='outline' size='24' />
      </span>
      <p className='m-0 max-w-420px text-13px text-t-secondary'>{t('terminal.bridgeUnavailable')}</p>
      <Button type='outline' size='small' onClick={onRetry}>
        {t('terminal.retry')}
      </Button>
    </div>
  );
};

export default BridgeNotice;

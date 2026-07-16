/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button } from '@arco-design/web-react';
import { Components, Refresh } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Friendly notice shown when the Main-process browser bridge has not answered
 * (not wired yet — Task 15.1). Mirrors how the Resource/Company pages degrade,
 * offering a retry rather than a blank or broken screen.
 */
const BridgeNotice: React.FC<{ onRetry: () => void }> = ({ onRetry }) => {
  const { t } = useTranslation();
  return (
    <div className='flex flex-col items-center justify-center gap-14px py-56px text-center'>
      <span className='size-48px flex-center rd-full bg-fill-2 text-t-tertiary'>
        <Components theme='outline' size='24' />
      </span>
      <p className='m-0 max-w-420px text-13px text-t-secondary'>{t('browser.bridgeUnavailable')}</p>
      <Button type='secondary' icon={<Refresh theme='outline' size='14' />} onClick={onRetry}>
        {t('browser.retry')}
      </Button>
    </div>
  );
};

export default BridgeNotice;

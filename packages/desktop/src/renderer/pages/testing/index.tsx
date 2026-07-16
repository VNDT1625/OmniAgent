/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Tabs } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import SettingsPageWrapper from '../settings/components/SettingsPageWrapper';
import CoreChatLab from './components/CoreChatLab';
import TestingPage from './TestingPage';

const TabPane = Tabs.TabPane;

/** Testing settings with a temporary parallel-core chat laboratory. */
const TestingSettings: React.FC = () => {
  const { t } = useTranslation();
  return (
    <SettingsPageWrapper>
      <Tabs defaultActiveTab='core-chat' className='h-full'>
        <TabPane key='core-chat' title={t('testing.core.tab')}>
          <CoreChatLab />
        </TabPane>
        <TabPane key='test-runs' title={t('testing.runnerTab')}>
          <TestingPage />
        </TabPane>
      </Tabs>
    </SettingsPageWrapper>
  );
};

export default TestingSettings;

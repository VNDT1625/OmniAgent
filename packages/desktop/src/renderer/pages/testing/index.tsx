/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import SettingsPageWrapper from '../settings/components/SettingsPageWrapper';
import TestingPage from './TestingPage';

/**
 * Multi-platform Testing settings page (Yêu cầu 2b). Registered at
 * `/settings/testing`; renders inside the shared settings chrome so it picks up
 * the settings navigation (mirrors BrowserSettings / CompanySettings).
 */
const TestingSettings: React.FC = () => {
  return (
    <SettingsPageWrapper>
      <TestingPage />
    </SettingsPageWrapper>
  );
};

export default TestingSettings;

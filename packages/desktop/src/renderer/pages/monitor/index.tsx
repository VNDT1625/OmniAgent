/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import SettingsPageWrapper from '../settings/components/SettingsPageWrapper';
import MonitorPage from './MonitorPage';

/**
 * Bug Monitor settings page (Yêu cầu 6). Registered at `/settings/monitor`;
 * renders inside the shared settings chrome (mirrors the other Tomni Agentic pages).
 */
const MonitorSettings: React.FC = () => {
  return (
    <SettingsPageWrapper>
      <MonitorPage />
    </SettingsPageWrapper>
  );
};

export default MonitorSettings;

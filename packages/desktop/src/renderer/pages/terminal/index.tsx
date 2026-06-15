/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import SettingsPageWrapper from '../settings/components/SettingsPageWrapper';
import TerminalPage from './TerminalPage';

/**
 * Terminal manager settings page. Registered at `/settings/terminal`; renders
 * inside the shared settings page chrome so it picks up the settings navigation
 * (mirrors BrowserSettings / CompanySettings).
 */
const TerminalSettings: React.FC = () => {
  return (
    <SettingsPageWrapper className='terminal-settings-wrapper' contentClassName='terminal-settings-content'>
      <TerminalPage />
    </SettingsPageWrapper>
  );
};

export default TerminalSettings;

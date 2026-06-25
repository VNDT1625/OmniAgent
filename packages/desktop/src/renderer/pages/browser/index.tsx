/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import SettingsPageWrapper from '../settings/components/SettingsPageWrapper';
import BrowserPage from './BrowserPage';

/**
 * Embedded Browser settings page (Requirement 1 — browser + web agent).
 * Registered at `/settings/browser`; renders inside the shared settings page
 * chrome so it picks up the settings navigation (mirrors CompanySettings /
 * ResourceSettings).
 */
const BrowserSettings: React.FC = () => {
  return (
    <SettingsPageWrapper className='browser-settings-wrapper' contentClassName='browser-settings-content'>
      <BrowserPage />
    </SettingsPageWrapper>
  );
};

export default BrowserSettings;

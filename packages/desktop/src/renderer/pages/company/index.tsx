/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import SettingsPageWrapper from '../settings/components/SettingsPageWrapper';
import CompanyPage from './CompanyPage';

/**
 * Agent Company settings page (Requirement 3 — multi-tier agent company).
 * Registered at `/settings/company`; renders inside the shared settings page
 * chrome so it picks up the settings navigation (mirrors ResourceSettings).
 */
const CompanySettings: React.FC = () => {
  return (
    <SettingsPageWrapper>
      <CompanyPage />
    </SettingsPageWrapper>
  );
};

export default CompanySettings;

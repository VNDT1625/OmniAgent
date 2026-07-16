/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import SettingsPageWrapper from '../components/SettingsPageWrapper';
import ResourceDashboard from './ResourceDashboard';

/**
 * Resource Dashboard settings page (Requirement 5 — anti-lag resource
 * management). Registered at `/settings/resource`; renders inside the shared
 * settings page chrome so it picks up the settings navigation.
 */
const ResourceSettings: React.FC = () => {
  return (
    <SettingsPageWrapper>
      <ResourceDashboard />
    </SettingsPageWrapper>
  );
};

export default ResourceSettings;

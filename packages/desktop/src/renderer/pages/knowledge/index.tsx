/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import SettingsPageWrapper from '../settings/components/SettingsPageWrapper';
import RealtimeKnowledgePage from './RealtimeKnowledgePage';

/**
 * Realtime Knowledge settings page (time-sensitive fact store inspector).
 * Registered at `/settings/knowledge`; renders inside the shared settings page
 * chrome so it picks up the settings navigation (mirrors CompanySettings).
 */
const RealtimeKnowledgeSettings: React.FC = () => {
  return (
    <SettingsPageWrapper>
      <RealtimeKnowledgePage />
    </SettingsPageWrapper>
  );
};

export default RealtimeKnowledgeSettings;

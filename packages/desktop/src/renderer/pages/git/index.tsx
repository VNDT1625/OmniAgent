/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Git settings entry (`/settings/git`). Hosts the real Git/GitHub manager inside
 * the shared settings chrome. Desktop-only — the git bridge is a native
 * Main-process service. Renderer-only.
 */

import React from 'react';
import SettingsPageWrapper from '../settings/components/SettingsPageWrapper';
import GitPage from './GitPage';

const GitSettings: React.FC = () => {
  return (
    <SettingsPageWrapper className='git-settings-wrapper' contentClassName='git-settings-content'>
      <GitPage />
    </SettingsPageWrapper>
  );
};

export default GitSettings;

/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import SettingsPageWrapper from '../settings/components/SettingsPageWrapper';
import NewsPage from './NewsPage';

/**
 * News aggregator settings page. Registered at `/settings/news`; renders
 * inside the shared settings page chrome so it picks up the settings navigation
 * (mirrors TerminalSettings / BrowserSettings).
 */
const NewsSettings: React.FC = () => {
  return (
    <SettingsPageWrapper className='news-settings-wrapper' contentClassName='news-settings-content'>
      <NewsPage />
    </SettingsPageWrapper>
  );
};

export default NewsSettings;

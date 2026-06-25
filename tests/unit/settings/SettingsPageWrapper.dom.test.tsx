/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getBuiltinSettingsNavItems } from '@/renderer/pages/settings/components/SettingsPageWrapper';
import { BUILTIN_TAB_IDS } from '@/renderer/pages/settings/components/SettingsSider';

describe('getBuiltinSettingsNavItems', () => {
  it('resolves every builtin settings tab to a navigation item', () => {
    const items = getBuiltinSettingsNavItems(true, (key) => key);

    expect(items.map((item) => item.id)).toEqual(BUILTIN_TAB_IDS);
  });
});

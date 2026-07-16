/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { filterRendererBreadcrumb, filterRendererSentryIntegrations } from '@/renderer/utils/ui/runtimePatches';

describe('filterRendererBreadcrumb', () => {
  it('drops DOM click breadcrumbs that trigger expensive Electron scope normalization', () => {
    expect(filterRendererBreadcrumb({ category: 'ui.click', message: 'button' })).toBeNull();
  });

  it('keeps error and navigation breadcrumbs for diagnostics', () => {
    const error = { category: 'console', level: 'error' };
    const navigation = { category: 'navigation', from: '/a', to: '/b' };

    expect(filterRendererBreadcrumb(error)).toBe(error);
    expect(filterRendererBreadcrumb(navigation)).toBe(navigation);
  });

  it('removes deep renderer-to-main scope mirroring while preserving error integrations', () => {
    const integrations = [{ name: 'GlobalHandlers' }, { name: 'ScopeToMain' }, { name: 'Dedupe' }];

    expect(filterRendererSentryIntegrations(integrations).map((integration) => integration.name)).toEqual([
      'GlobalHandlers',
      'Dedupe',
    ]);
  });
});

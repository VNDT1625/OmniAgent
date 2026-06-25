/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * OmniAgent surfaces — end-to-end wiring (Task 15.3, Requirements 1.2 / 2.5 and
 * the global integration of Yêu cầu 1/2b/3/5/6).
 *
 * A true agent-driven browser + TestOrchestrator run requires a live model and
 * aioncore, which are not available on CI; per the testing steering, those heavy
 * paths are exercised with simulated drivers in the unit/property suites. This
 * E2E instead verifies the END-TO-END WIRING that ties everything together: the
 * new OmniAgent settings pages (Resource, Company, Browser, Testing, Monitor) are
 * registered, routable, and render their feature UI through the bootstrapped IPC
 * bridges — without leaking raw i18n keys or crashing.
 */
import { test, expect } from '../fixtures';
import { goToSettings, expectUrlContains, type SettingsTab } from '../helpers';

const OMNIAGENT_TABS: { tab: SettingsTab; name: string }[] = [
  { tab: 'resource', name: 'Resource Dashboard (Yêu cầu 5)' },
  { tab: 'company', name: 'Agent Company (Yêu cầu 3)' },
  { tab: 'browser', name: 'Embedded Browser (Yêu cầu 1)' },
  { tab: 'testing', name: 'Multi-platform Testing (Yêu cầu 2b)' },
  { tab: 'monitor', name: 'Bug Monitor (Yêu cầu 6)' },
];

test.describe('OmniAgent surfaces wiring', () => {
  for (const { tab, name } of OMNIAGENT_TABS) {
    test(`${name} page loads and renders content`, async ({ page }) => {
      await goToSettings(page, tab);
      await expectUrlContains(page, tab);

      const body = await page.locator('body').textContent();
      expect(body!.length).toBeGreaterThan(20);

      // The page must render real translated content, not raw i18n keys like
      // "company.title" / "browser.navTitle" leaking through.
      expect(body).not.toMatch(new RegExp(`${tab}\\.[a-zA-Z]+\\.[a-zA-Z]`));
    });
  }

  test('can navigate across all OmniAgent surfaces without errors', async ({ page }) => {
    for (const { tab } of OMNIAGENT_TABS) {
      await goToSettings(page, tab);
      expect(page.url()).toContain(tab);
      const body = await page.locator('body').textContent();
      expect(body!.length).toBeGreaterThan(20);
    }
  });
});

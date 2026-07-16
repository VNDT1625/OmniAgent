/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { validateOfficeApiScript } from '@/common/types/office/officeApiScript';

describe('validateOfficeApiScript', () => {
  it('accepts bounded ONLYOFFICE Document Builder code and trims it', () => {
    expect(
      validateOfficeApiScript('  const document = Api.GetDocument(); return document ? "ok" : "missing";  ')
    ).toEqual({
      ok: true,
      code: 'const document = Api.GetDocument(); return document ? "ok" : "missing";',
    });
  });

  it('rejects scripts outside the Office API boundary', () => {
    expect(validateOfficeApiScript('return fetch("https://example.com")')).toEqual({
      ok: false,
      reason: 'network/browser APIs are not available in Office API scripts',
    });
    expect(validateOfficeApiScript('return require("node:fs")')).toEqual({
      ok: false,
      reason: 'Node.js APIs are not available in Office API scripts',
    });
    expect(validateOfficeApiScript('return window.localStorage.getItem("x")')).toEqual({
      ok: false,
      reason: 'browser globals are not available in Office API scripts',
    });
  });
});

/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { runUiAudit, type UiAuditReport } from '@/process/ide/uiAuditEngine';
import type { CdpWebContents } from '@/process/ide/quickTestTracer';

describe('runUiAudit', () => {
  it('executes the deterministic page audit and returns its report', async () => {
    const report: UiAuditReport = {
      score: 82,
      auditedAt: 123,
      url: 'http://localhost:3000/',
      elementCount: 42,
      findings: [],
      categoryScores: {
        contrast: 90,
        typography: 100,
        accessibility: 70,
        layout: 80,
        interaction: 70,
      },
    };
    const executeJavaScript = vi.fn(async () => report);
    const webContents = { executeJavaScript } as unknown as CdpWebContents;

    await expect(runUiAudit(webContents)).resolves.toEqual(report);
    expect(executeJavaScript).toHaveBeenCalledOnce();
    const script = executeJavaScript.mock.calls[0]?.[0] as string;
    expect(script).toContain('contrast.minimum');
    expect(script).toContain('interaction.target-size');
    expect(script).toContain('accessibility.form-label');
    expect(script).toContain('allElements.slice(0, 6000)');
    expect(script).toContain('findings.length >= MAX_FINDINGS');
  });

  it('rejects an invalid page-side result', async () => {
    const webContents = {
      executeJavaScript: vi.fn(async () => null),
    } as unknown as CdpWebContents;

    await expect(runUiAudit(webContents)).rejects.toThrow('UI audit did not return a report.');
  });
});

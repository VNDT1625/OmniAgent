/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the Office-editor chat guidance builder: the canonical MCP
 * server name, embedding the open file path, and idempotent appending.
 */

import { describe, expect, it } from 'vitest';
import {
  OFFICE_EDITOR_MCP_NAME,
  buildOfficeEditorRules,
  withOfficeEditorRules,
} from '@/renderer/pages/studio/hooks/officeEditorGuidance';

describe('officeEditorGuidance', () => {
  it('exposes the canonical Office-editor server name', () => {
    expect(OFFICE_EDITOR_MCP_NAME).toBe('aionui-office-editor');
  });

  it('embeds the open file path in the rules', () => {
    const rules = buildOfficeEditorRules('/docs/report.docx');
    expect(rules).toContain('/docs/report.docx');
    expect(rules).toContain('Document editor (you can edit the open file live)');
    expect(rules).toContain('office_read_document');
  });

  it('directs agents to use live Office tools for PPTX edits and verify changes', () => {
    const rules = buildOfficeEditorRules('/docs/deck.pptx');

    expect(rules).toContain('PPTX files');
    expect(rules).toContain('Api.GetPresentation()');
    expect(rules).toContain('Production deck/doc quality bar');
    expect(rules).toContain('visual system, clear hierarchy');
    expect(rules).toContain('generated or user-provided images');
    expect(rules).toContain('office_review_premium_quality');
    expect(rules).toContain('If it lists required improvements, revise');
    expect(rules).toContain('Never edit the open `.docx`, `.xlsx`, or `.pptx` by shelling out');
    expect(rules).toContain('verify the result with `office_read_document`');
  });

  it('appends the block when there are no existing rules', () => {
    const built = buildOfficeEditorRules('/a.docx');
    expect(withOfficeEditorRules(undefined, '/a.docx')).toBe(built);
    expect(withOfficeEditorRules('', '/a.docx')).toBe(built);
  });

  it('preserves existing rules and appends the block once (idempotent)', () => {
    const existing = 'You are a helpful agent.';
    const once = withOfficeEditorRules(existing, '/a.docx');
    expect(once.startsWith(existing)).toBe(true);
    expect(once).toContain('Document editor (you can edit the open file live)');

    const twice = withOfficeEditorRules(once, '/a.docx');
    expect(twice).toBe(once.trim());
    expect(twice.match(/Document editor \(you can edit the open file live\)/g)?.length).toBe(1);
  });
});

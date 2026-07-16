/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for the soul composer + default soul templates (spec
 * agent-company-pipeline, Requirement 1): the workflow lives in each role's
 * soul, derived from its role kind + responsibilities + direct reports + rules.
 */

import { describe, expect, it } from 'vitest';
import type { CompanyStructure, RoleNode } from '@/process/company/companyOrchestrator';
import { composeSoul, directReportsOf, findRoleNode } from '@/renderer/pages/company/pipeline/soulComposer';
import { defaultSoulForRole, ensureSoulHasWorkflow, soulHasWorkflow } from '@/process/company/soulTemplates';

const president: RoleNode = {
  id: 'co:president',
  role: 'president',
  name: 'President',
  children: [
    { id: 'co:head:be', role: 'division-head', name: 'Backend Lead', responsibilities: 'APIs', children: [] },
    { id: 'co:head:fe', role: 'division-head', name: 'Frontend Lead', responsibilities: 'UI', children: [] },
  ],
};

describe('composeSoul', () => {
  it('embeds the president workflow and lists ONLY direct reports', () => {
    const soul = composeSoul({
      companyName: 'IT',
      node: president,
      directReports: directReportsOf(president),
      rules: ['Always test'],
    });
    expect(soul).toContain('President');
    expect(soul).toContain('WORKFLOW');
    expect(soul).toContain('Backend Lead');
    expect(soul).toContain('Frontend Lead');
    expect(soul).toContain('co:head:be');
    expect(soul).toContain('Always test');
  });

  it('a worker with no reports gets the executor workflow and a no-reports note', () => {
    const worker: RoleNode = { id: 'co:worker:0', role: 'worker', name: 'Dev', children: [] };
    const soul = composeSoul({ companyName: 'IT', node: worker, directReports: [], rules: [] });
    expect(soul).toContain('Dev');
    expect(soul.toLowerCase()).toContain('no direct reports');
    expect(soul.toLowerCase()).toContain('execute it for real');
    // The workflow is binding (mandatory administrative process).
    expect(soul).toContain('MANDATORY');
  });
});

describe('soulTemplates defaults', () => {
  it('default souls contain the required workflow sections', () => {
    for (const role of ['president', 'division-head', 'worker'] as const) {
      const soul = defaultSoulForRole(role, { companyName: 'IT', roleName: 'X' });
      expect(soulHasWorkflow(soul)).toBe(true);
    }
  });

  it('ensureSoulHasWorkflow keeps a good soul and replaces a thin one', () => {
    const good = '## Identity\nYou are X.\n## Workflow\n1. Do the thing properly with enough detail.';
    expect(ensureSoulHasWorkflow(good, 'worker', { companyName: 'IT', roleName: 'X' })).toBe(good);
    const replaced = ensureSoulHasWorkflow('too short', 'worker', { companyName: 'IT', roleName: 'X' });
    expect(soulHasWorkflow(replaced)).toBe(true);
  });
});

describe('findRoleNode', () => {
  it('finds a nested node and returns null for unknown', () => {
    const structure: CompanyStructure = { companyId: 'co', root: president };
    expect(findRoleNode(structure, 'co:head:fe')?.name).toBe('Frontend Lead');
    expect(findRoleNode(structure, 'ghost')).toBeNull();
  });
});

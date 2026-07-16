/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  analyzeRequirements,
  classifyEars,
  parseRequirements,
  validateRequirements,
} from '@/common/spec/earsRequirements';

describe('classifyEars', () => {
  it('classifies the five EARS patterns', () => {
    expect(classifyEars('The system SHALL persist the entry.')).toBe('ubiquitous');
    expect(classifyEars('WHEN a fix is verified, THEN the system SHALL store an entry.')).toBe('event');
    expect(classifyEars('WHILE indexing, the system SHALL show progress.')).toBe('state');
    expect(classifyEars('IF the entry is a duplicate, THEN the system SHALL dedupe it.')).toBe('unwanted');
    expect(classifyEars('WHERE cloud sync is enabled, the system SHALL upload entries.')).toBe('optional');
  });

  it('returns unknown when no normative verb is present', () => {
    expect(classifyEars('The system stores the entry.')).toBe('unknown');
  });
});

describe('parseRequirements', () => {
  const md = [
    '# Feature Requirements',
    '',
    '## R1 Capture experience',
    'As a developer, I want fixes captured, so that they are reused.',
    '',
    '### Acceptance Criteria',
    '- WHEN a fix is verified, THEN the system SHALL store an ExperienceEntry.',
    '- IF the entry duplicates an existing one, THEN the system SHALL dedupe.',
    '',
    '## R2 Retrieve experience',
    '- The system SHALL rank entries by similarity.',
    '',
    '## Non-Goals',
    '- No cloud sync in phase 1.',
  ].join('\n');

  it('parses requirements with ids, titles, user stories and criteria', () => {
    const reqs = parseRequirements(md);
    expect(reqs.map((r) => r.id)).toEqual(['R1', 'R2']);
    expect(reqs[0].title).toBe('Capture experience');
    expect(reqs[0].userStory).toContain('As a developer');
    expect(reqs[0].criteria).toHaveLength(2);
    expect(reqs[0].criteria[0].pattern).toBe('event');
    expect(reqs[0].criteria[1].pattern).toBe('unwanted');
    expect(reqs[1].criteria[0].pattern).toBe('ubiquitous');
  });

  it('does not treat boilerplate sections as requirements', () => {
    const reqs = parseRequirements(md);
    expect(reqs.some((r) => /non-goals/i.test(r.title))).toBe(false);
  });

  it('auto-numbers requirements without explicit ids', () => {
    const reqs = parseRequirements(['# Title', '', '## First thing', '- The system SHALL do X.'].join('\n'));
    expect(reqs[0].id).toBe('R1');
    expect(reqs[0].title).toBe('First thing');
  });
});

describe('validateRequirements', () => {
  it('errors when there are no requirements', () => {
    const diags = validateRequirements([]);
    expect(diags.some((d) => d.code === 'requirements.empty' && d.severity === 'error')).toBe(true);
  });

  it('warns about requirements without criteria and non-normative criteria', () => {
    const reqs = parseRequirements(
      ['# T', '', '## R1 Empty req', '', '## R2 Weak', '- The system stores the entry.'].join('\n')
    );
    const diags = validateRequirements(reqs);
    expect(diags.some((d) => d.code === 'requirement.noCriteria')).toBe(true);
    expect(diags.some((d) => d.code === 'criterion.noShall')).toBe(true);
  });

  it('flags duplicate ids', () => {
    const reqs = parseRequirements(
      ['# T', '', '## R1 One', '- The system SHALL a.', '', '## R1 Two', '- The system SHALL b.'].join('\n')
    );
    const diags = validateRequirements(reqs);
    expect(diags.some((d) => d.code === 'requirement.duplicateId')).toBe(true);
  });
});

describe('analyzeRequirements', () => {
  it('counts ears-compliant requirements', () => {
    const md = [
      '# T',
      '',
      '## R1 Good',
      '- WHEN x, THEN the system SHALL y.',
      '',
      '## R2 Weak',
      '- The system stores it.',
    ].join('\n');
    const analysis = analyzeRequirements(md);
    expect(analysis.counts.total).toBe(2);
    expect(analysis.counts.withCriteria).toBe(2);
    expect(analysis.counts.earsCompliant).toBe(1);
  });
});

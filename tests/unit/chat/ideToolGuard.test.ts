/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Unit tests for the PURE Strict IDE Mode tool guard. These lock the core
 * decision: under Strict IDE Mode every non-`ide_*` tool call is denied, and
 * the whitelist (ide_/mtui/team_/db_ + the IDE MCP servers) is allowed. Default
 * is DENY so an unidentifiable tool can never slip through.
 */

import { describe, expect, it } from 'vitest';
import {
  buildRemapReason,
  evaluateStrictModeConfirmation,
  evaluateStrictModePermission,
  isAllowedIdeTool,
  isToolCallAllowedInStrictMode,
  pickRejectOption,
  resolveRemapTarget,
  type GuardPermissionOption,
} from '@/common/chat/approval/ideToolGuard';

const OPTIONS: GuardPermissionOption[] = [
  { option_id: 'allow', name: 'Allow', kind: 'allow_once' },
  { option_id: 'reject', name: 'Reject', kind: 'reject_once' },
];

describe('isAllowedIdeTool', () => {
  it('allows public ide_*, mtui, team_, db_ tools and hides internal compatibility tools', () => {
    expect(isAllowedIdeTool('ide_search')).toBe(true);
    expect(isAllowedIdeTool('IDE_Read')).toBe(true);
    expect(isAllowedIdeTool('ide_grep')).toBe(false);
    expect(isAllowedIdeTool('ide_glob')).toBe(false);
    expect(isAllowedIdeTool('mtui')).toBe(true);
    expect(isAllowedIdeTool('team_write_file')).toBe(true);
    expect(isAllowedIdeTool('db_query')).toBe(true);
  });

  it('denies a backend native tool', () => {
    expect(isAllowedIdeTool('Bash')).toBe(false);
    expect(isAllowedIdeTool('Write')).toBe(false);
    expect(isAllowedIdeTool('Edit')).toBe(false);
    expect(isAllowedIdeTool('Read')).toBe(false);
    expect(isAllowedIdeTool('')).toBe(false);
    expect(isAllowedIdeTool(undefined)).toBe(false);
  });
});

describe('isToolCallAllowedInStrictMode', () => {
  it('allows when the MCP server is the built-in IDE plane', () => {
    expect(isToolCallAllowedInStrictMode({ raw_input: { server: 'aionui-ide' } })).toBe(true);
  });

  it('denies direct internal-only tools even from the built-in IDE MCP server', () => {
    expect(isToolCallAllowedInStrictMode({ raw_input: { server: 'aionui-ide', tool_name: 'ide_grep' } })).toBe(false);
    expect(isToolCallAllowedInStrictMode({ raw_input: { server: 'aionui-ide', tool_name: 'ide_glob' } })).toBe(false);
  });

  it('allows when any candidate name matches the whitelist', () => {
    expect(isToolCallAllowedInStrictMode({ title: 'ide_map' })).toBe(true);
    expect(isToolCallAllowedInStrictMode({ raw_input: { tool_name: 'mtui' } })).toBe(true);
  });

  it('denies a shell/edit tool', () => {
    expect(isToolCallAllowedInStrictMode({ title: 'Bash', raw_input: { command: 'ls -la' } })).toBe(false);
    expect(isToolCallAllowedInStrictMode({ title: 'Write' })).toBe(false);
  });

  it('denies an unidentifiable tool by default', () => {
    expect(isToolCallAllowedInStrictMode({})).toBe(false);
    expect(isToolCallAllowedInStrictMode(undefined)).toBe(false);
  });
});

describe('pickRejectOption', () => {
  it('prefers reject_once', () => {
    expect(pickRejectOption(OPTIONS)?.option_id).toBe('reject');
  });

  it('returns null when no options', () => {
    expect(pickRejectOption([])).toBeNull();
    expect(pickRejectOption(undefined)).toBeNull();
  });
});

describe('evaluateStrictModePermission', () => {
  it('does nothing when strict mode is off', () => {
    const d = evaluateStrictModePermission(false, { title: 'Bash' }, OPTIONS);
    expect(d.deny).toBe(false);
    expect(d.reason).toBe('strict-mode-off');
  });

  it('allows an ide_* tool even when strict mode is on', () => {
    const d = evaluateStrictModePermission(true, { title: 'ide_search' }, OPTIONS);
    expect(d.deny).toBe(false);
  });

  it('denies a native tool and returns the reject option id', () => {
    const d = evaluateStrictModePermission(true, { title: 'Bash' }, OPTIONS);
    expect(d.deny).toBe(true);
    expect(d.rejectOptionId).toBe('reject');
    expect(d.reason).toContain('Bash');
  });

  it('denies but yields null reject id when no reject option exists', () => {
    const d = evaluateStrictModePermission(true, { title: 'Bash' }, [
      { option_id: 'allow', name: 'Allow', kind: 'allow_once' },
    ]);
    expect(d.deny).toBe(true);
    expect(d.rejectOptionId).toBeNull();
  });
});

describe('evaluateStrictModeConfirmation (aionrs legacy shape)', () => {
  it('allows an ide_* tool identified by title', () => {
    const d = evaluateStrictModeConfirmation(true, {
      title: 'ide_search',
      options: [{ label: 'Reject', value: 'reject' }],
    });
    expect(d.deny).toBe(false);
  });

  it('denies a shell tool and returns the reject option value', () => {
    const d = evaluateStrictModeConfirmation(true, {
      title: 'Bash',
      command_type: 'npm',
      options: [
        { label: 'Allow', value: 'allow' },
        { label: 'Reject', value: 'reject' },
      ],
    });
    expect(d.deny).toBe(true);
    expect(d.rejectKey).toBe('reject');
  });

  it('is a no-op when strict mode is off', () => {
    const d = evaluateStrictModeConfirmation(false, { title: 'Bash' });
    expect(d.deny).toBe(false);
  });
});

describe('resolveRemapTarget', () => {
  it('maps grep/rg → ide_search', () => {
    expect(resolveRemapTarget({ title: 'grep' })).toBe('ide_search');
    expect(resolveRemapTarget({ raw_input: { command: 'rg -n foo src/' } })).toBe('ide_search');
  });

  it('maps glob/find/ls → ide_glob', () => {
    expect(resolveRemapTarget({ title: 'Glob' })).toBe('ide_glob');
    expect(resolveRemapTarget({ raw_input: { command: 'find . -name "*.ts"' } })).toBe('ide_glob');
  });

  it('maps bash/shell → ide_command', () => {
    expect(resolveRemapTarget({ title: 'Bash' })).toBe('ide_command');
    expect(resolveRemapTarget({ raw_input: { command: 'bash -c "echo hi"' } })).toBe('ide_command');
  });

  it('maps cat/read → ide_read_file and a path-qualified binary', () => {
    expect(resolveRemapTarget({ raw_input: { command: '/usr/bin/cat file.txt' } })).toBe('ide_read_file');
    expect(resolveRemapTarget({ title: 'Read' })).toBe('ide_read_file');
  });

  it('maps write/edit → team_* tools', () => {
    expect(resolveRemapTarget({ title: 'Write' })).toBe('team_write_file');
    expect(resolveRemapTarget({ title: 'Edit' })).toBe('team_edit_file');
  });

  it('returns null for an unknown tool', () => {
    expect(resolveRemapTarget({ title: 'frobnicate' })).toBeNull();
    expect(resolveRemapTarget(undefined)).toBeNull();
  });
});

describe('buildRemapReason', () => {
  it('produces the mandatory-remap message for a known tool', () => {
    const msg = buildRemapReason({ title: 'grep' });
    expect(msg).toContain('grep');
    expect(msg).toContain('ide_search');
    expect(msg).toContain('Strict IDE Mode');
    expect(msg).toContain('chuyển');
  });

  it('falls back to a generic message for an unknown tool', () => {
    const msg = buildRemapReason({ title: 'frobnicate' });
    expect(msg).toContain('tool native');
  });
});

describe('evaluateStrictModePermission — remap reason', () => {
  it('denies grep and the reason points at ide_search', () => {
    const d = evaluateStrictModePermission(true, { title: 'grep' }, [
      { option_id: 'reject', name: 'Reject', kind: 'reject_once' },
    ]);
    expect(d.deny).toBe(true);
    expect(d.reason).toContain('ide_search');
  });
});

/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NewSessionMeta } from '@agentclientprotocol/claude-agent-acp';

export const STRICT_IDE_DISALLOWED_TOOLS = [
  'Read',
  'Read0',
  'Grep',
  'Grep0',
  'Glob',
  'Glob0',
  'Bash',
  'Bash0',
  'Write',
  'Write0',
  'Edit',
  'Edit0',
  'NotebookEdit',
  'NotebookEdit0',
  'ApplyPatch',
  'StrReplace',
  'Sed',
  'Awk',
  'Cat',
  'Ls',
  'Find',
  'Execute',
  'RunTerminalCmd',
] as const;

type SessionParams = {
  _meta?: NewSessionMeta;
};

/** Merge the mandatory native-tool deny list into every Claude ACP session path. */
export function enforceStrictIdeToolPolicy<T extends SessionParams>(params: T): T {
  const meta = params._meta ?? {};
  const claudeCode = meta.claudeCode ?? {};
  const options = claudeCode.options ?? {};
  const disallowedTools = Array.from(new Set([...(options.disallowedTools ?? []), ...STRICT_IDE_DISALLOWED_TOOLS]));

  return {
    ...params,
    _meta: {
      ...meta,
      claudeCode: {
        ...claudeCode,
        options: {
          ...options,
          disallowedTools,
        },
      },
    },
  };
}

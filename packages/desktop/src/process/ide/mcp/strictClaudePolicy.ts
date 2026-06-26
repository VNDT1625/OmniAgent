/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NewSessionMeta } from '@agentclientprotocol/claude-agent-acp';

export const STRICT_IDE_DISALLOWED_TOOLS = ['Read', 'Grep', 'Glob', 'Bash', 'Write', 'Edit', 'NotebookEdit'] as const;

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

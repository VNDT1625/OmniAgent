/**
 * Transport-neutral CLI routing for background surfaces.
 *
 * `cli:<targetId>` is executed directly through Tomny Core adapters. The legacy
 * AionCore REST conversation and backend WebSocket are deliberately not used.
 */

import type { AgentChat, ChatMessageInput } from '@process/browser/webAgentRunner';
import { parseCliModelId } from './cliModelId';
import {
  createDirectCliAgentDriver,
  type DirectCliAgentDriver,
  type DirectCliExecutionContext,
} from './directCliAgent';
import type { CliAgentDriver } from './cliAgentDriver';
import { normalizeChatMessagesForMarkdown } from './markdownMessageNormalizer';

let sharedDriver: DirectCliAgentDriver | null = null;
const contextualDrivers = new Map<string, DirectCliAgentDriver>();

const getDriver = (context?: DirectCliExecutionContext): CliAgentDriver => {
  if (!context) {
    if (!sharedDriver) sharedDriver = createDirectCliAgentDriver();
    return sharedDriver;
  }
  const key = JSON.stringify([context.workspace ?? '', context.surface ?? '', context.permissionMode ?? 'read-only']);
  const existing = contextualDrivers.get(key);
  if (existing) return existing;
  const created = createDirectCliAgentDriver({}, context);
  contextualDrivers.set(key, created);
  return created;
};

/**
 * Route CLI model ids to direct Tomny Core adapters while provider ids keep
 * using the caller's existing provider implementation.
 */
export const withCliAgent = (
  inner: AgentChat,
  driver?: CliAgentDriver,
  context?: DirectCliExecutionContext
): AgentChat => {
  return async ({ model, messages, signal }) => {
    const normalizedMessages = await normalizeChatMessagesForMarkdown(messages as ChatMessageInput[]);
    const cli = parseCliModelId(model);
    if (!cli) return inner({ model, messages: normalizedMessages, signal });
    return (driver ?? getDriver(context)).run({
      agentId: cli.agentId,
      modelId: cli.modelId,
      messages: normalizedMessages,
      signal,
    });
  };
};

/** Dispose direct adapter processes and clear detection/session caches. */
export const __resetSharedCliDriver = (): void => {
  const active = [sharedDriver, ...contextualDrivers.values()].filter(
    (driver): driver is DirectCliAgentDriver => driver !== null
  );
  sharedDriver = null;
  contextualDrivers.clear();
  for (const driver of active) void driver.dispose();
};

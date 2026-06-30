/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  applyEnvironmentSettings,
  ClaudeAcpAgent,
  loadManagedSettings,
  runAcp,
} from '@agentclientprotocol/claude-agent-acp';
import { enforceStrictIdeToolPolicy } from './strictClaudePolicy';

function installStrictSessionPolicy(): void {
  const prototype = ClaudeAcpAgent.prototype;
  const newSession = prototype.newSession;
  const loadSession = prototype.loadSession;
  const resumeSession = prototype.resumeSession;
  const forkSession = prototype.unstable_forkSession;

  prototype.newSession = function (params) {
    return newSession.call(this, enforceStrictIdeToolPolicy(params));
  };
  prototype.loadSession = function (params) {
    return loadSession.call(this, enforceStrictIdeToolPolicy(params));
  };
  prototype.resumeSession = function (params) {
    return resumeSession.call(this, enforceStrictIdeToolPolicy(params));
  };
  prototype.unstable_forkSession = function (params) {
    return forkSession.call(this, enforceStrictIdeToolPolicy(params));
  };
}

const managedSettings = loadManagedSettings();
if (managedSettings) applyEnvironmentSettings(managedSettings);

console.log = console.error;
console.info = console.error;
console.warn = console.error;
console.debug = console.error;

installStrictSessionPolicy();
const { connection, agent } = runAcp();

async function shutdown(): Promise<void> {
  await agent.dispose().catch((error: unknown) => {
    console.error('Strict Claude ACP cleanup failed:', error);
  });
  process.exit(0);
}

connection.closed.then(shutdown);
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.stdin.resume();

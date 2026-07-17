/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CoreScheduleRunInput, CoreScheduleRunner } from './types';

export type ScheduledCoreRuntimeEvent = {
  requestId: string;
  type: 'permission' | 'completed' | 'error' | 'cancelled' | string;
  text?: string;
  permissionId?: string;
  tool?: string;
};

export type ScheduledCoreRuntimeStart = {
  requestId: string;
  targetId: string;
  prompt: string;
  workspace: string;
  modelKey?: string;
  permissionMode: 'read-only' | 'workspace-write' | 'full-access';
  sessionId?: string;
  companyId?: string;
  contextIdentity: {
    surface: string;
    agentId: string;
    personalId: string;
    permissionScopes: string[];
    capabilityGrants: string[];
    availableCapabilities: string[];
    modelCapabilities: string[];
  };
};

/** Structural port implemented by the Main-process runtime bootstrap/event multiplexer. */
export type ScheduledCoreRuntimePort = {
  start(input: ScheduledCoreRuntimeStart): { requestId: string; sessionId: string };
  cancel(requestId: string): Promise<boolean>;
  resolvePermission(permissionId: string, approved: boolean): Promise<boolean>;
  subscribe(listener: (event: ScheduledCoreRuntimeEvent) => void): () => void;
};

export type DirectScheduledCoreRuntime = {
  start(
    requestId: string,
    targetId: string,
    prompt: string,
    workspace: string,
    modelKey: string | undefined,
    permissionMode: 'read-only' | 'workspace-write' | 'full-access',
    sessionId: string | undefined,
    companyId: string | undefined,
    contextIdentity: ScheduledCoreRuntimeStart['contextIdentity']
  ): { requestId: string; sessionId: string };
  cancel(requestId: string): Promise<boolean>;
  resolvePermission(permissionId: string, approved: boolean): Promise<boolean>;
};

/** Bind the existing positional ExperimentalCoreRuntime API without changing that runtime. */
export const bindScheduledCoreRuntime = (
  runtime: DirectScheduledCoreRuntime,
  subscribe: ScheduledCoreRuntimePort['subscribe']
): ScheduledCoreRuntimePort => ({
  start: (input) =>
    runtime.start(
      input.requestId,
      input.targetId,
      input.prompt,
      input.workspace,
      input.modelKey,
      input.permissionMode,
      input.sessionId,
      input.companyId,
      input.contextIdentity
    ),
  cancel: (requestId) => runtime.cancel(requestId),
  resolvePermission: (permissionId, approved) => runtime.resolvePermission(permissionId, approved),
  subscribe,
});

const scopeAllowsTool = (scopes: readonly string[], tool: string): boolean =>
  scopes.some(
    (scope) => scope === '*' || scope === tool || (scope.endsWith('.*') && tool.startsWith(scope.slice(0, -1)))
  );

/** Convert the direct Tomny runtime event stream into the scheduler's awaitable runner contract. */
export const createScheduledCoreRuntimeRunner = (port: ScheduledCoreRuntimePort): CoreScheduleRunner => ({
  run(input: CoreScheduleRunInput): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        input.signal.removeEventListener('abort', abort);
        unsubscribe();
        if (error) reject(error);
        else resolve();
      };
      const abort = (): void => {
        void port.cancel(input.runId);
        finish(new Error('The scheduled core run was cancelled.'));
      };
      const unsubscribe = port.subscribe((event) => {
        if (event.requestId !== input.runId || settled) return;
        if (event.type === 'permission') {
          if (!event.permissionId) {
            void port.cancel(input.runId);
            finish(new Error('Scheduled core emitted a permission request without an id.'));
            return;
          }
          const approved =
            input.target.unattendedPermissionPolicy === 'allow-granted' &&
            Boolean(event.tool) &&
            scopeAllowsTool(input.target.permissionScopes, event.tool ?? '');
          void Promise.resolve(port.resolvePermission(event.permissionId, approved))
            .then((resolved) => {
              if (resolved) return;
              void port.cancel(input.runId);
              finish(new Error('Scheduled permission request expired before it could be resolved.'));
            })
            .catch((error) => {
              void port.cancel(input.runId);
              finish(error instanceof Error ? error : new Error(String(error)));
            });
          return;
        }
        if (event.type === 'completed') finish();
        else if (event.type === 'error') finish(new Error(event.text || 'Scheduled core run failed.'));
        else if (event.type === 'cancelled') finish(new Error(event.text || 'Scheduled core run was cancelled.'));
      });

      input.signal.addEventListener('abort', abort, { once: true });
      if (input.signal.aborted) {
        abort();
        return;
      }
      try {
        const started = port.start({
          requestId: input.runId,
          targetId: input.target.targetId,
          prompt: input.target.prompt,
          workspace: input.target.workspace,
          modelKey: input.target.modelKey,
          permissionMode: input.target.permissionMode,
          sessionId: input.target.sessionId,
          companyId: input.target.companyId,
          contextIdentity: {
            surface: input.target.surface,
            agentId: input.target.agentId,
            personalId: input.target.personalId,
            permissionScopes: [...input.target.permissionScopes],
            capabilityGrants: [...input.target.capabilityGrants],
            availableCapabilities: [...input.target.availableCapabilities],
            modelCapabilities: [...input.target.modelCapabilities],
          },
        });

        if (started.requestId !== input.runId) {
          throw new Error('Scheduled core runtime returned a mismatched request id.');
        }
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  },
});

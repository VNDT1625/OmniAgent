/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CoreScheduledTaskService } from './service';
import type { CoreScheduleAuditEvent, CoreScheduleDraft, CoreScheduledTask } from './types';

/** Serializable Main-process contract ready to register on the project IPC bridge. */
export type CoreScheduledTaskIpcHandlers = {
  list(): Promise<CoreScheduledTask[]>;
  get(input: { id: string }): Promise<CoreScheduledTask | undefined>;
  save(input: { draft: CoreScheduleDraft }): Promise<CoreScheduledTask>;
  remove(input: { id: string }): Promise<void>;
  runNow(input: { id: string }): Promise<void>;
  cancel(input: { id: string }): Promise<boolean>;
  listAudit(input: { taskId?: string }): Promise<CoreScheduleAuditEvent[]>;
};

/** Keep IPC registration thin: validation and behavior stay in the direct-core service. */
export const createCoreScheduledTaskIpcHandlers = (
  service: CoreScheduledTaskService
): CoreScheduledTaskIpcHandlers => ({
  list: () => service.list(),
  get: ({ id }) => service.get(id),
  save: ({ draft }) => service.save(draft),
  remove: ({ id }) => service.remove(id),
  runNow: ({ id }) => service.runNow(id),
  cancel: ({ id }) => service.cancel(id),
  listAudit: ({ taskId }) => service.listAudit(taskId),
});

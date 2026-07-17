/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CoreScheduleAuditEvent, CoreScheduledTask, CoreScheduleStore } from './types';

type PersistedState = { version: 1; tasks: CoreScheduledTask[]; audit: CoreScheduleAuditEvent[] };
const EMPTY_STATE: PersistedState = { version: 1, tasks: [], audit: [] };
const MAX_AUDIT_EVENTS = 10_000;
const clone = <T>(value: T): T => structuredClone(value);

export class MemoryCoreScheduleStore implements CoreScheduleStore {
  protected tasks = new Map<string, CoreScheduledTask>();
  protected audit: CoreScheduleAuditEvent[] = [];

  public async initialize(): Promise<void> {}
  public async list(): Promise<CoreScheduledTask[]> {
    return [...this.tasks.values()].map(clone).toSorted((left, right) => right.updatedAt - left.updatedAt);
  }
  public async get(id: string): Promise<CoreScheduledTask | undefined> {
    const task = this.tasks.get(id);
    return task ? clone(task) : undefined;
  }
  public async save(task: CoreScheduledTask): Promise<void> {
    this.tasks.set(task.id, clone(task));
  }
  public async remove(id: string): Promise<void> {
    this.tasks.delete(id);
  }
  public async appendAudit(event: CoreScheduleAuditEvent): Promise<void> {
    this.audit.push(clone(event));
    if (this.audit.length > MAX_AUDIT_EVENTS) this.audit.splice(0, this.audit.length - MAX_AUDIT_EVENTS);
  }
  public async listAudit(taskId?: string): Promise<CoreScheduleAuditEvent[]> {
    const events = taskId ? this.audit.filter((event) => event.taskId === taskId) : this.audit;
    return events.map(clone);
  }
}

/** Atomic JSON persistence for schedules and their bounded audit trail. */
export class JsonCoreScheduleStore extends MemoryCoreScheduleStore {
  private writeQueue = Promise.resolve();

  public constructor(private readonly filePath: string) {
    super();
  }

  public override async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<PersistedState>;
      if (parsed.version === 1 && Array.isArray(parsed.tasks) && Array.isArray(parsed.audit)) {
        this.tasks = new Map(parsed.tasks.map((task) => [task.id, clone(task)]));
        this.audit = parsed.audit.slice(-MAX_AUDIT_EVENTS).map(clone);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await this.flush(EMPTY_STATE);
    }
  }

  public override async save(task: CoreScheduledTask): Promise<void> {
    await super.save(task);
    await this.flush();
  }
  public override async remove(id: string): Promise<void> {
    await super.remove(id);
    await this.flush();
  }
  public override async appendAudit(event: CoreScheduleAuditEvent): Promise<void> {
    await super.appendAudit(event);
    await this.flush();
  }

  private async flush(initial?: PersistedState): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const state: PersistedState = initial ?? { version: 1, tasks: await this.list(), audit: await this.listAudit() };
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
      await rename(temporaryPath, this.filePath);
    });
    await this.writeQueue;
  }
}

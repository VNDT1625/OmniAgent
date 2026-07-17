/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ExperimentalPermissionMode } from './experimentalCoreProtocol';

export type CoreSessionStatus = 'idle' | 'running' | 'completed' | 'interrupted' | 'error' | 'cancelled';
export type CoreSessionMessage = { role: 'user' | 'assistant'; text: string; timestamp: number };
export type CoreSessionTransition = {
  fromTargetId: string;
  toTargetId: string;
  fromModelKey?: string;
  toModelKey?: string;
  timestamp: number;
};

export type CoreSessionCheckpoint = {
  id: string;
  parentId?: string;
  targetId: string;
  workspace: string;
  modelKey?: string;
  companyId?: string;
  surface?: string;
  agentId?: string;
  personalId?: string;
  permissionScopes?: string[];
  capabilityGrants?: string[];
  availableCapabilities?: string[];
  modelCapabilities?: string[];
  permissionMode: ExperimentalPermissionMode;
  status: CoreSessionStatus;
  createdAt: number;
  updatedAt: number;
  messages: CoreSessionMessage[];
  transitions?: CoreSessionTransition[];
  lastError?: string;
};

export type CoreSessionStore = {
  initialize: () => Promise<void>;
  list: () => Promise<CoreSessionCheckpoint[]>;
  get: (sessionId: string) => Promise<CoreSessionCheckpoint | undefined>;
  save: (checkpoint: CoreSessionCheckpoint) => Promise<void>;
  replaceAll: (checkpoints: CoreSessionCheckpoint[]) => Promise<void>;
  fork: (sessionId: string, forkId: string, timestamp: number) => Promise<CoreSessionCheckpoint>;
};

const SECRET_REDACTORS: ReadonlyArray<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\bsk-[a-z0-9_-]{12,}\b/giu, replacement: '[REDACTED]' },
  { pattern: /\bghp_[a-z0-9]{20,}\b/giu, replacement: '[REDACTED]' },
  { pattern: /\b(Bearer\s+)[a-z0-9._~+/-]+=*/giu, replacement: '$1[REDACTED]' },
  {
    pattern: /\b(api[_-]?key|token|secret|password)\s*[:=]\s*([^\s,;]+)/giu,
    replacement: '$1[REDACTED]',
  },
];

export const redactCheckpointText = (text: string): string =>
  SECRET_REDACTORS.reduce((value, redactor) => value.replace(redactor.pattern, redactor.replacement), text);

const clone = (checkpoint: CoreSessionCheckpoint): CoreSessionCheckpoint => structuredClone(checkpoint);

export class MemoryCoreSessionStore implements CoreSessionStore {
  protected readonly checkpoints = new Map<string, CoreSessionCheckpoint>();

  public async initialize(): Promise<void> {
    const now = Date.now();
    for (const checkpoint of this.checkpoints.values()) {
      if (checkpoint.status !== 'running') continue;
      checkpoint.status = 'interrupted';
      checkpoint.updatedAt = now;
    }
  }

  public async list(): Promise<CoreSessionCheckpoint[]> {
    return [...this.checkpoints.values()].map(clone).toSorted((left, right) => right.updatedAt - left.updatedAt);
  }

  public async get(sessionId: string): Promise<CoreSessionCheckpoint | undefined> {
    const checkpoint = this.checkpoints.get(sessionId);
    return checkpoint ? clone(checkpoint) : undefined;
  }

  public async save(checkpoint: CoreSessionCheckpoint): Promise<void> {
    this.checkpoints.set(checkpoint.id, clone(checkpoint));
  }

  public async replaceAll(checkpoints: CoreSessionCheckpoint[]): Promise<void> {
    const ids = new Set<string>();
    for (const checkpoint of checkpoints) {
      if (!checkpoint.id.trim() || ids.has(checkpoint.id))
        throw new Error('Core session bundle contains duplicate ids.');
      ids.add(checkpoint.id);
    }
    this.checkpoints.clear();
    for (const checkpoint of checkpoints) this.checkpoints.set(checkpoint.id, clone(checkpoint));
  }

  public async fork(sessionId: string, forkId: string, timestamp: number): Promise<CoreSessionCheckpoint> {
    const source = this.checkpoints.get(sessionId);
    if (!source) throw new Error(`Core session not found: ${sessionId}`);
    const forked: CoreSessionCheckpoint = {
      ...clone(source),
      id: forkId,
      parentId: source.id,
      status: 'idle',
      createdAt: timestamp,
      updatedAt: timestamp,
      lastError: undefined,
    };
    await this.save(forked);
    return forked;
  }
}

export class JsonCoreSessionStore extends MemoryCoreSessionStore {
  private writeQueue = Promise.resolve();

  public constructor(private readonly filePath: string) {
    super();
  }

  public override async initialize(): Promise<void> {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed: unknown = JSON.parse(await readFile(this.filePath, 'utf8'));
      if (Array.isArray(parsed)) {
        for (const checkpoint of parsed) {
          if (checkpoint && typeof checkpoint === 'object' && typeof (checkpoint as { id?: unknown }).id === 'string') {
            this.checkpoints.set((checkpoint as CoreSessionCheckpoint).id, checkpoint as CoreSessionCheckpoint);
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await super.initialize();
    await this.flush();
  }

  public override async save(checkpoint: CoreSessionCheckpoint): Promise<void> {
    const safeCheckpoint = clone(checkpoint);
    safeCheckpoint.messages = safeCheckpoint.messages.map((message) => ({
      ...message,
      text: redactCheckpointText(message.text),
    }));
    if (safeCheckpoint.lastError) safeCheckpoint.lastError = redactCheckpointText(safeCheckpoint.lastError);
    await super.save(safeCheckpoint);
    await this.flush();
  }

  public override async replaceAll(checkpoints: CoreSessionCheckpoint[]): Promise<void> {
    const previous = await super.list();
    const safeCheckpoints = checkpoints.map((checkpoint) => {
      const safe = clone(checkpoint);
      safe.messages = safe.messages.map((message) => ({ ...message, text: redactCheckpointText(message.text) }));
      if (safe.lastError) safe.lastError = redactCheckpointText(safe.lastError);
      return safe;
    });
    await super.replaceAll(safeCheckpoints);
    try {
      await this.flush();
    } catch (error) {
      await super.replaceAll(previous);
      throw error;
    }
  }

  private async flush(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
      await writeFile(temporaryPath, JSON.stringify(await this.list(), null, 2), 'utf8');
      await rename(temporaryPath, this.filePath);
    });
    await this.writeQueue;
  }
}

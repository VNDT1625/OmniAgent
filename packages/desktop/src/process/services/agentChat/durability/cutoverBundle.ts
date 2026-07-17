/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';

import { sanitizeContextDocument, type ContextStore } from '@process/agentRuntime/contextStore';
import type { ContextDocument } from '@process/agentRuntime/contextTypes';
import type { CoreSessionCheckpoint, CoreSessionStore } from '@process/experimentalCore/sessionCheckpointStore';
import type { PermissionStateRepository, PermissionStoreState } from '@process/services/agentChat/permission';

import { validateDurableEventChain } from './eventStore';
import type { DurableAgentEvent, DurableEventStore } from './types';

const FORMAT = 'tomny-core-cutover';
const SCHEMA_VERSION = 1;
const MAX_SECTION_RECORDS = 100_000;
const RAW_SECRET_PATTERNS: ReadonlyArray<RegExp> = [
  /\b(?:sk|rk|pk)-[a-z0-9_-]{12,}\b/iu,
  /\bghp_[a-z0-9]{20,}\b/iu,
  /\bBearer\s+[a-z0-9._~+/-]+=*\b/iu,
  /\b(?:api[_-]?key|password|token|credential)\s*[:=]\s*[^\s,;]+/iu,
];

export type CoreCutoverPayload = {
  sessions: CoreSessionCheckpoint[];
  events: DurableAgentEvent[];
  context: ContextDocument;
  permissions: PermissionStoreState;
};

export type CoreCutoverBundle = {
  format: typeof FORMAT;
  schemaVersion: typeof SCHEMA_VERSION;
  bundleId: string;
  exportedAt: number;
  sourceCoreVersion: string;
  payload: CoreCutoverPayload;
  checksum: string;
};

export type CoreCutoverSectionPort<T> = {
  read(): Promise<T>;
  replace(value: T): Promise<void>;
};

export type CoreCutoverPorts = {
  sessions: CoreCutoverSectionPort<CoreSessionCheckpoint[]>;
  events: CoreCutoverSectionPort<DurableAgentEvent[]>;
  context: CoreCutoverSectionPort<ContextDocument>;
  permissions: CoreCutoverSectionPort<PermissionStoreState>;
};

export type CoreCutoverImportResult = {
  rollbackBundle: CoreCutoverBundle;
  imported: { sessions: number; events: number; agents: number; people: number; grants: number };
};

const clone = <T>(value: T): T => structuredClone(value);

const checksumInput = (bundle: Omit<CoreCutoverBundle, 'checksum'>): string => JSON.stringify(bundle);
const checksum = (bundle: Omit<CoreCutoverBundle, 'checksum'>): string =>
  createHash('sha256').update(checksumInput(bundle)).digest('hex');

const assertNoRawSecretsOrBytes = (value: unknown, path = 'payload'): void => {
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    throw new Error(`Cutover bundle cannot contain bytes at ${path}.`);
  }
  if (typeof value === 'string') {
    if (RAW_SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
      throw new Error(`Cutover bundle cannot contain raw secrets at ${path}.`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRawSecretsOrBytes(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (
    record.type === 'Buffer' &&
    Array.isArray(record.data) &&
    record.data.every((item) => Number.isInteger(item) && Number(item) >= 0 && Number(item) <= 255)
  ) {
    throw new Error(`Cutover bundle cannot contain encoded bytes at ${path}.`);
  }
  for (const [key, item] of Object.entries(record)) assertNoRawSecretsOrBytes(item, `${path}.${key}`);
};

const assertRecordArray = (value: unknown, name: string): void => {
  if (!Array.isArray(value) || value.length > MAX_SECTION_RECORDS) {
    throw new Error(`Cutover ${name} section is invalid or too large.`);
  }
};

const validatePayload = (payload: CoreCutoverPayload): CoreCutoverPayload => {
  if (!payload || typeof payload !== 'object') throw new Error('Cutover payload is invalid.');
  assertRecordArray(payload.sessions, 'sessions');
  assertRecordArray(payload.events, 'events');
  const sessionIds = new Set<string>();
  for (const session of payload.sessions) {
    if (
      !session ||
      typeof session !== 'object' ||
      typeof session.id !== 'string' ||
      !session.id.trim() ||
      sessionIds.has(session.id) ||
      !Array.isArray(session.messages)
    ) {
      throw new Error('Cutover sessions section contains an invalid or duplicate record.');
    }
    sessionIds.add(session.id);
  }
  validateDurableEventChain(payload.events);
  const context = sanitizeContextDocument(payload.context);
  if (
    !payload.permissions ||
    payload.permissions.version !== 1 ||
    !Array.isArray(payload.permissions.grants) ||
    !Array.isArray(payload.permissions.audit) ||
    payload.permissions.grants.length > MAX_SECTION_RECORDS ||
    payload.permissions.audit.length > MAX_SECTION_RECORDS
  ) {
    throw new Error('Cutover permissions section is invalid or too large.');
  }
  assertNoRawSecretsOrBytes(payload);
  return {
    sessions: clone(payload.sessions),
    events: clone(payload.events),
    context,
    permissions: clone(payload.permissions),
  };
};

const bundleWithoutChecksum = (
  payload: CoreCutoverPayload,
  sourceCoreVersion: string,
  now: number,
  bundleId: string
): Omit<CoreCutoverBundle, 'checksum'> => ({
  format: FORMAT,
  schemaVersion: SCHEMA_VERSION,
  bundleId,
  exportedAt: now,
  sourceCoreVersion,
  payload: validatePayload(payload),
});

export const parseCoreCutoverBundle = (text: string): CoreCutoverBundle => {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object') throw new Error('Cutover bundle envelope is invalid.');
  const candidate = parsed as Partial<CoreCutoverBundle>;
  if (
    candidate.format !== FORMAT ||
    candidate.schemaVersion !== SCHEMA_VERSION ||
    typeof candidate.bundleId !== 'string' ||
    !candidate.bundleId.trim() ||
    typeof candidate.exportedAt !== 'number' ||
    !Number.isSafeInteger(candidate.exportedAt) ||
    candidate.exportedAt < 0 ||
    typeof candidate.sourceCoreVersion !== 'string' ||
    !candidate.sourceCoreVersion.trim() ||
    typeof candidate.checksum !== 'string' ||
    !candidate.payload
  ) {
    throw new Error('Cutover bundle envelope is invalid.');
  }
  const base = bundleWithoutChecksum(
    candidate.payload,
    candidate.sourceCoreVersion,
    candidate.exportedAt,
    candidate.bundleId
  );
  if (checksum(base) !== candidate.checksum) throw new Error('Cutover bundle integrity check failed.');
  return { ...base, checksum: candidate.checksum };
};

export const serializeCoreCutoverBundle = (bundle: CoreCutoverBundle): string =>
  `${JSON.stringify(parseCoreCutoverBundle(JSON.stringify(bundle)), null, 2)}\n`;

export class CoreCutoverService {
  public constructor(
    private readonly ports: CoreCutoverPorts,
    private readonly options: {
      now?: () => number;
      createId?: () => string;
      sourceCoreVersion?: string;
    } = {}
  ) {}

  public async exportBundle(
    sourceCoreVersion = this.options.sourceCoreVersion ?? 'tomny-core'
  ): Promise<CoreCutoverBundle> {
    const payload = await this.snapshot();
    return this.createBundle(payload, sourceCoreVersion);
  }

  public verify(bundle: CoreCutoverBundle): CoreCutoverBundle {
    return parseCoreCutoverBundle(JSON.stringify(bundle));
  }

  public async importBundle(bundle: CoreCutoverBundle): Promise<CoreCutoverImportResult> {
    const incoming = this.verify(bundle);
    const previous = await this.snapshot();
    const rollbackBundle = this.createBundle(previous, 'tomny-core-rollback');
    const steps = [
      {
        apply: (): Promise<void> => this.ports.sessions.replace(clone(incoming.payload.sessions)),
        rollback: (): Promise<void> => this.ports.sessions.replace(clone(previous.sessions)),
      },
      {
        apply: (): Promise<void> => this.ports.events.replace(clone(incoming.payload.events)),
        rollback: (): Promise<void> => this.ports.events.replace(clone(previous.events)),
      },
      {
        apply: (): Promise<void> => this.ports.context.replace(clone(incoming.payload.context)),
        rollback: (): Promise<void> => this.ports.context.replace(clone(previous.context)),
      },
      {
        apply: (): Promise<void> => this.ports.permissions.replace(clone(incoming.payload.permissions)),
        rollback: (): Promise<void> => this.ports.permissions.replace(clone(previous.permissions)),
      },
    ];
    let applied = 0;
    try {
      for (const step of steps) {
        await step.apply();
        applied += 1;
      }
    } catch (error) {
      const rollbackFailures: string[] = [];
      for (let index = applied - 1; index >= 0; index -= 1) {
        try {
          await steps[index].rollback();
        } catch (rollbackError) {
          rollbackFailures.push(rollbackError instanceof Error ? rollbackError.message : String(rollbackError));
        }
      }
      const detail = rollbackFailures.length ? ` Rollback failures: ${rollbackFailures.join('; ')}` : '';
      throw new Error(
        `Core cutover import failed and ${rollbackFailures.length ? 'rollback was incomplete' : 'was rolled back'}: ${
          error instanceof Error ? error.message : String(error)
        }.${detail}`
      );
    }
    return {
      rollbackBundle,
      imported: {
        sessions: incoming.payload.sessions.length,
        events: incoming.payload.events.length,
        agents: incoming.payload.context.agents.length,
        people: incoming.payload.context.people.length,
        grants: incoming.payload.permissions.grants.length,
      },
    };
  }

  private async snapshot(): Promise<CoreCutoverPayload> {
    const [sessions, events, context, permissions] = await Promise.all([
      this.ports.sessions.read(),
      this.ports.events.read(),
      this.ports.context.read(),
      this.ports.permissions.read(),
    ]);
    return validatePayload({ sessions, events, context, permissions });
  }

  private createBundle(payload: CoreCutoverPayload, sourceCoreVersion: string): CoreCutoverBundle {
    const base = bundleWithoutChecksum(
      payload,
      sourceCoreVersion,
      this.options.now?.() ?? Date.now(),
      this.options.createId?.() ?? randomUUID()
    );
    return { ...base, checksum: checksum(base) };
  }
}

export const createCoreCutoverPorts = (input: {
  sessionStore: CoreSessionStore;
  eventStore: DurableEventStore;
  contextStore: ContextStore;
  permissionRepository: PermissionStateRepository;
}): CoreCutoverPorts => {
  const exportContext = input.contextStore.exportDocument;
  const replaceContext = input.contextStore.replaceDocument;
  if (!exportContext || !replaceContext) throw new Error('Context store does not support durable cutover.');
  return {
    sessions: {
      read: () => input.sessionStore.list(),
      replace: (sessions) => input.sessionStore.replaceAll(sessions),
    },
    events: {
      read: () => input.eventStore.query(),
      replace: (events) => input.eventStore.replaceAll(events),
    },
    context: {
      read: () => exportContext(),
      replace: (context) => replaceContext(context),
    },
    permissions: {
      read: () => input.permissionRepository.load(),
      replace: (permissions) => input.permissionRepository.save(permissions),
    },
  };
};

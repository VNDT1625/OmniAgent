/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CoreTelemetryEvent, CoreTelemetrySink } from './types';

const GENESIS_HASH = '0'.repeat(64);

type TelemetryEnvelope = {
  sequence: number;
  previousHash: string;
  hash: string;
  event: CoreTelemetryEvent;
};

const envelopeHash = (sequence: number, previousHash: string, event: CoreTelemetryEvent): string =>
  createHash('sha256').update(JSON.stringify({ sequence, previousHash, event })).digest('hex');

const parseValidPrefix = (text: string): TelemetryEnvelope[] => {
  const valid: TelemetryEnvelope[] = [];
  let expectedSequence = 1;
  let previousHash = GENESIS_HASH;
  for (const line of text.split(/\r?\n/u).filter(Boolean)) {
    try {
      const envelope = JSON.parse(line) as TelemetryEnvelope;
      if (
        envelope.sequence !== expectedSequence ||
        envelope.previousHash !== previousHash ||
        envelope.hash !== envelopeHash(envelope.sequence, envelope.previousHash, envelope.event)
      ) {
        break;
      }
      valid.push(envelope);
      expectedSequence += 1;
      previousHash = envelope.hash;
    } catch {
      break;
    }
  }
  return valid;
};

export class MemoryCoreTelemetrySink implements CoreTelemetrySink {
  private readonly events: CoreTelemetryEvent[] = [];

  public async initialize(): Promise<void> {}

  public async append(event: CoreTelemetryEvent): Promise<void> {
    this.events.push(structuredClone(event));
  }

  public async query(
    filter: { runId?: string; sessionId?: string; limit?: number } = {}
  ): Promise<CoreTelemetryEvent[]> {
    const matching = this.events.filter(
      (event) =>
        (!filter.runId || event.runId === filter.runId) && (!filter.sessionId || event.sessionId === filter.sessionId)
    );
    return structuredClone(filter.limit ? matching.slice(-Math.max(0, filter.limit)) : matching);
  }
}

/** Append-only, hash-chained telemetry with valid-prefix recovery after a crash or partial write. */
export class JsonlCoreTelemetrySink implements CoreTelemetrySink {
  private initialized = false;
  private envelopes: TelemetryEnvelope[] = [];
  private pending: Promise<void> = Promise.resolve();

  public constructor(private readonly filePath: string) {}

  public async initialize(): Promise<void> {
    if (this.initialized) return;
    await mkdir(path.dirname(this.filePath), { recursive: true });
    let text = '';
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    this.envelopes = parseValidPrefix(text);
    const canonical = this.serialize();
    if (canonical !== text) await this.replaceFile(canonical);
    this.initialized = true;
  }

  public async append(event: CoreTelemetryEvent): Promise<void> {
    await this.initialize();
    const operation = this.pending.then(async () => {
      const previous = this.envelopes.at(-1);
      const sequence = (previous?.sequence ?? 0) + 1;
      const previousHash = previous?.hash ?? GENESIS_HASH;
      const envelope: TelemetryEnvelope = {
        sequence,
        previousHash,
        hash: envelopeHash(sequence, previousHash, event),
        event: structuredClone(event),
      };
      this.envelopes.push(envelope);
      try {
        await this.replaceFile(this.serialize());
      } catch (error) {
        this.envelopes.pop();
        throw error;
      }
    });
    this.pending = operation.catch((): void => undefined);
    return operation;
  }

  public async query(
    filter: { runId?: string; sessionId?: string; limit?: number } = {}
  ): Promise<CoreTelemetryEvent[]> {
    await this.initialize();
    await this.pending;
    const matching = this.envelopes
      .map(({ event }) => event)
      .filter(
        (event) =>
          (!filter.runId || event.runId === filter.runId) && (!filter.sessionId || event.sessionId === filter.sessionId)
      );
    return structuredClone(filter.limit ? matching.slice(-Math.max(0, filter.limit)) : matching);
  }

  private serialize(): string {
    return this.envelopes.length > 0 ? `${this.envelopes.map((item) => JSON.stringify(item)).join('\n')}\n` : '';
  }

  private async replaceFile(content: string): Promise<void> {
    const temporaryPath = `${this.filePath}.tmp`;
    await writeFile(temporaryPath, content, { encoding: 'utf8', mode: 0o600 });
    await rename(temporaryPath, this.filePath);
    await chmod(this.filePath, 0o600).catch((): void => undefined);
  }
}

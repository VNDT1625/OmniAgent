/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Main-process wiring for the Realtime Knowledge service singleton.
 *
 * Assembles the store (facts.json), the vector index (persisted alongside as
 * index.json, atomic tmp+rename), the verification guardrail and the service
 * facade. The embedder is resolved from the user's configured embedding model
 * with a local hashing fallback ({@link resolveRtkEmbedder}), so semantic lookup
 * works even before a model is configured.
 *
 * The research pipeline (network refresh) is intentionally left unwired: in this
 * build the AGENT is the crawler — it gathers evidence with its own web/browser
 * tools and calls `rtk_record`, and RTK enforces the verification guardrail. A
 * researcher can be injected later to enable autonomous `rtk_refresh` /
 * scheduled refresh without touching this contract.
 *
 * Process boundary: Main-process (Node.js / Electron) module. No DOM APIs.
 */

import { app } from 'electron';
import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { createRtkStore } from './realtime/rtkStore';
import { createRtkVectorIndex, type IRtkVectorIndex, type RtkVectorIndexData } from './realtime/rtkVectorIndex';
import { createVerificationService } from './realtime/verificationService';
import { createRtkService, type IRtkService } from './realtime/rtkService';
import { resolveRtkEmbedder } from './rtkEmbedder';

/** Directory holding the RTK store + vector index. */
const resolveRtkDir = (): string => path.join(app.getPath('userData'), 'knowledge', 'realtime');

const INDEX_FILE = 'index.json';

const isFileNotFound = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';

/** Load the persisted vector index document, or `null` when absent/corrupt. */
const loadIndexData = async (dir: string): Promise<RtkVectorIndexData | null> => {
  try {
    const raw = await fsp.readFile(path.join(dir, INDEX_FILE), 'utf-8');
    return JSON.parse(raw) as RtkVectorIndexData;
  } catch (error) {
    if (isFileNotFound(error)) return null;
    return null;
  }
};

/** Persist the vector index atomically (tmp then rename). */
const persistIndexData = async (dir: string, data: RtkVectorIndexData): Promise<void> => {
  await fsp.mkdir(dir, { recursive: true });
  const target = path.join(dir, INDEX_FILE);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(data), 'utf-8');
  await fsp.rename(tmp, target);
};

let servicePromise: Promise<IRtkService> | undefined;
let indexRef: IRtkVectorIndex | undefined;

/**
 * Resolve the process-wide Realtime Knowledge service (built once on first use).
 *
 * @returns The shared {@link IRtkService}.
 */
export const getRtkService = (): Promise<IRtkService> => {
  if (servicePromise) return servicePromise;
  servicePromise = (async (): Promise<IRtkService> => {
    const dir = resolveRtkDir();
    const store = createRtkStore({ rootDir: dir });
    const embedder = await resolveRtkEmbedder();
    const index = createRtkVectorIndex(embedder, await loadIndexData(dir));
    indexRef = index;
    const verifier = createVerificationService();
    return createRtkService({
      store,
      index,
      verifier,
      persistIndex: (data) => persistIndexData(dir, data),
    });
  })();
  return servicePromise;
};

/** Reset the cached singleton (tests). */
export const resetRtkService = (): void => {
  servicePromise = undefined;
  indexRef = undefined;
};

/** The live index (for diagnostics/tests); undefined until the service is built. */
export const getRtkVectorIndex = (): IRtkVectorIndex | undefined => indexRef;

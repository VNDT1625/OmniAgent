/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { chmod, copyFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { validateAdapterCatalog } from './verify';
import type { AdapterCatalogDocument, CatalogVerificationOptions } from './types';

/** Active/previous/pin store. It never downloads a catalog and can roll back to the last valid revision. */
export class AdapterCatalogStore {
  private initialized: Promise<void> | undefined;

  public constructor(
    private readonly activePath: string,
    private readonly previousPath = `${activePath}.previous`,
    private readonly pinPath = `${activePath}.pin`
  ) {}

  public async load(options: CatalogVerificationOptions = {}): Promise<AdapterCatalogDocument | undefined> {
    await this.ensureDirectory();
    const pinned = await this.readPin();
    const candidates = [this.activePath, this.previousPath];
    const texts = await Promise.all(
      candidates.map(async (candidatePath) => {
        try {
          return await readFile(candidatePath, 'utf8');
        } catch {
          return undefined;
        }
      })
    );
    for (const text of texts) {
      if (!text) continue;
      try {
        const document = validateAdapterCatalog(JSON.parse(text) as unknown, options);
        if (pinned && document.revision !== pinned) continue;
        return document;
      } catch {
        // Continue to the last-known-good copy. Details are intentionally not exposed to renderer diagnostics.
      }
    }
    return undefined;
  }

  public async activate(document: AdapterCatalogDocument, options: CatalogVerificationOptions = {}): Promise<void> {
    validateAdapterCatalog(document, options);
    await this.ensureDirectory();
    try {
      const currentText = await readFile(this.activePath, 'utf8');
      validateAdapterCatalog(JSON.parse(currentText) as unknown, options);
      await copyFile(this.activePath, this.previousPath);
      await chmod(this.previousPath, 0o600).catch((): void => undefined);
    } catch (error) {
      if (
        (error as NodeJS.ErrnoException).code !== 'ENOENT' &&
        !(error instanceof SyntaxError) &&
        !(error instanceof Error && error.name === 'AdapterCatalogError')
      )
        throw error;
    }
    const temporary = `${this.activePath}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    await rename(temporary, this.activePath);
    await chmod(this.activePath, 0o600).catch((): void => undefined);
  }

  public async pin(revision?: string): Promise<void> {
    await this.ensureDirectory();
    if (!revision) {
      await unlink(this.pinPath).catch((): void => undefined);
      return;
    }
    await writeFile(this.pinPath, revision.trim(), { encoding: 'utf8', mode: 0o600 });
    await chmod(this.pinPath, 0o600).catch((): void => undefined);
  }

  private async readPin(): Promise<string | undefined> {
    try {
      const value = (await readFile(this.pinPath, 'utf8')).trim();
      return value || undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
  }

  private async ensureDirectory(): Promise<void> {
    if (!this.initialized) {
      this.initialized = mkdir(path.dirname(this.activePath), { recursive: true }).then((): void => undefined);
    }
    await this.initialized;
  }
}

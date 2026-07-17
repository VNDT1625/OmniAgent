/**
 * @license
 * Copyright 2025 AionUi (github.com/VNDT1625/OmniAgent)
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserWindow } from 'electron';
import { startBrowserControl } from '@process/browser/browserControlWiring';
import { startOfficeEditor } from '@process/editor/officeEditorMcpWiring';
import { buildIdeServer } from '@process/ide/mcp/ideMcpWiring';
import { startIdeMcpHost } from '@process/ide/mcp/ideMcpHost';
import { startMusic } from '@process/music/musicMcpWiring';
import type { CoreMcpServer } from './adapters';

export type SurfaceCapabilityHostFactory = () => Promise<CoreMcpServer>;

/** Dynamic host registry: adding a future surface does not require adapter changes. */
export class ElectronSurfaceCapabilityHosts {
  private readonly factories = new Map<string, SurfaceCapabilityHostFactory>();
  private readonly active = new Map<string, Promise<CoreMcpServer>>();

  public register(serverName: string, factory: SurfaceCapabilityHostFactory, replace = false): void {
    const name = serverName.trim();
    if (!name) throw new Error('Capability server name cannot be empty.');
    if (!replace && this.factories.has(name)) throw new Error(`Capability host ${name} is already registered.`);
    this.factories.set(name, factory);
    if (replace) this.active.delete(name);
  }

  public async resolve(serverNames: string[]): Promise<CoreMcpServer[]> {
    const unique = [...new Set(serverNames.map((name) => name.trim()).filter(Boolean))];
    return Promise.all(
      unique.map(async (name) => {
        const factory = this.factories.get(name);
        if (!factory) throw new Error(`The selected surface requires unavailable capability host ${name}.`);
        let started = this.active.get(name);
        if (!started) {
          started = factory().catch((error) => {
            this.active.delete(name);
            throw error;
          });
          this.active.set(name, started);
        }
        return started;
      })
    );
  }
}

/** Built-in Main-process capability providers; plugins may register additional names later. */
export const createElectronSurfaceCapabilityHosts = (): ElectronSurfaceCapabilityHosts => {
  const registry = new ElectronSurfaceCapabilityHosts();
  registry.register('aionui-ide', async () => {
    const host = await startIdeMcpHost({ buildServer: buildIdeServer });
    return { name: 'aionui-ide', url: host.url };
  });
  registry.register('aionui-browser-control', async () => {
    const host = await startBrowserControl(() => BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]);
    return { name: 'aionui-browser-control', url: host.url };
  });
  registry.register('aionui-office-editor', async () => {
    const host = await startOfficeEditor();
    return { name: 'aionui-office-editor', url: host.url };
  });
  registry.register('aionui-music', async () => {
    const host = await startMusic();
    return { name: 'aionui-music', url: host.url };
  });
  return registry;
};

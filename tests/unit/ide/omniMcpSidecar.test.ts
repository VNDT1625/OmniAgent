/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const root = process.cwd();
const read = (rel: string): string => readFileSync(path.join(root, rel), 'utf-8');

describe('Omni MCP sidecar smoke checks', () => {
  it('declares standalone package scripts', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['omni:mcp']).toBe('node scripts/omni-mcp-sidecar.cjs start');
    expect(pkg.scripts['omni:rescue']).toBe('node scripts/omni-mcp-sidecar.cjs rescue');
    expect(pkg.scripts['omni:doctor']).toBe('node scripts/omni-mcp-sidecar.cjs doctor');
    expect(pkg.scripts['omni:mcp:health']).toBe('node scripts/omni-mcp-sidecar.cjs health');
  });

  it('keeps the standalone sidecar free of renderer and Electron imports', () => {
    const sidecar = read('packages/desktop/src/process/ide/mcp/omniMcpSidecar.ts');
    const nodeWiring = read('packages/desktop/src/process/ide/mcp/omniNodeWiring.ts');
    const combined = `${sidecar}\n${nodeWiring}`;
    expect(combined).not.toMatch(/from ['"]electron['"]|require\(['"]electron['"]\)/);
    expect(combined).not.toContain('/renderer/');
    expect(combined).not.toContain('@renderer');
    expect(combined).not.toContain('@arco-design/web-react');
    expect(combined).not.toContain('react');
  });

  it('documents the rescue workflow and stop command', () => {
    const doc = read('docs/RESCUE_MCP.md');
    expect(doc).toContain('bun run omni:rescue');
    expect(doc).toContain('bun run omni:mcp:health');
    expect(doc).toContain('node scripts/omni-mcp-sidecar.cjs stop');
    expect(doc).toContain('does not rename `.aionui`');
  });
});

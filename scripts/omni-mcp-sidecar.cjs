#!/usr/bin/env node
/*
 * Standalone Omni MCP/IDE sidecar shim.
 * Keeps package scripts independent from the Electron build output.
 */

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const target = path.join(root, 'packages', 'desktop', 'src', 'process', 'ide', 'mcp', 'omniMcpSidecar.ts');
const args = ['x', 'tsx', target, ...process.argv.slice(2)];

const run = (command, commandArgs) =>
  spawnSync(command, commandArgs, {
    cwd: root,
    env: process.env,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
let result = run('bun', args);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 0);

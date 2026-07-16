#!/usr/bin/env node

const path = require('path');
const packageJson = require('../../../package.json');
const { prepareTomnyCore } = require('./prepare-tomny-core.js');

try {
  prepareTomnyCore({
    projectRoot: path.resolve(__dirname, '../../..'),
    platform: process.env.AIONUI_BACKEND_PLATFORM || process.platform,
    arch: process.env.AIONUI_BACKEND_ARCH || process.arch,
    version: packageJson.tomnyCoreVersion,
    commit: packageJson.tomnyCoreCommit,
  });
} catch (error) {
  console.error('Failed to prepare Tomny Core:', error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

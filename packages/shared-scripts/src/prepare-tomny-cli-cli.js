const path = require('path');
const packageJson = require('../../../package.json');
const { prepareTomnyCli } = require('./prepare-tomny-cli');

const projectRoot = path.resolve(__dirname, '../../..');

prepareTomnyCli({
  projectRoot,
  platform: process.platform,
  arch: process.arch,
  version: packageJson.tomnyCliVersion,
  commit: packageJson.tomnyCliCommit,
});

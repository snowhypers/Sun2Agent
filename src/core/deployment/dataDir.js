'use strict';

const os = require('node:os');
const path = require('node:path');

function getDataDir() {
  return path.resolve(process.env.SUN2AGENT_DATA_DIR || path.join(os.homedir(), '.sun2agent'));
}

module.exports = { getDataDir };

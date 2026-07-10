#!/usr/bin/env node

const { startChat } = require('../src/chat');
const { deleteConfig } = require('../src/config');

const args = process.argv.slice(2);

// Support CLI args too: sun2agent delete
if (args[0] === 'delete') {
  deleteConfig();
  console.log('Config deleted. Run "npm uninstall -g sun2agent" to fully remove.');
  process.exit(0);
}

startChat();
#!/usr/bin/env node

const args = process.argv.slice(2);

// Support CLI args too: sun2agent delete
if (args[0] === 'delete') {
  const { deleteConfig } = require('../src/config');
  deleteConfig();
  console.log('Config deleted. Run "npm uninstall -g sun2agent" to fully remove.');
  process.exit(0);
}

// sun2agent sandbox enable|disable|status — these manage Docker itself, so
// they always run on the HOST, never inside the container.
if (args[0] === 'sandbox') {
  const sandbox = require('../src/sandbox');
  const action = args[1];
  if (action === 'enable') {
    sandbox.enableSandbox();
  } else if (action === 'disable') {
    sandbox.disableSandbox();
  } else if (action === 'status') {
    sandbox.printSandboxStatus();
  } else {
    console.log('Usage: sun2agent sandbox [enable|disable|status]');
  }
  process.exit(0);
}

// Already inside the Docker sandbox (SUN2AGENT_SANDBOX=1 was set by the outer
// `docker run`)? Start the agent directly — never wrap again (no docker-in-
// docker, no infinite re-entry loop).
if (process.env.SUN2AGENT_SANDBOX === '1') {
  const { startChat } = require('../src/chat');
  startChat();
} else {
  // Host launcher: read the saved config and decide where the agent runs.
  // Enabled  -> the ENTIRE app re-executes inside the sandbox container
  //             (runInSandbox hard-fails if Docker is down — no silent
  //             fallback to host execution).
  // Disabled -> run directly on the host, exactly as before.
  const { loadConfig } = require('../src/config');
  const config = loadConfig();
  if (config.sandbox && config.sandbox.enabled && config.sandbox.mode === 'docker') {
    const { runInSandbox } = require('../src/sandbox');
    runInSandbox();
  } else {
    const { startChat } = require('../src/chat');
    startChat();
  }
}
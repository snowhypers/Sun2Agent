// Built-in Playwright browser MCP. It stays disconnected until /browser is
// requested and uses an isolated profile that is discarded on disconnect.

const path = require('path');
const registry = require('./registry');

const NAME = 'browser';

function reservedNameError() {
  return `"${NAME}" is reserved for Sun2Agent's built-in browser tools`;
}

function createServer() {
  const packageJson = require.resolve('@playwright/mcp/package.json');
  const cli = path.join(path.dirname(packageJson), 'cli.js');
  return {
    name: NAME,
    type: 'stdio',
    command: process.execPath,
    args: [cli, '--browser', 'chrome', '--isolated', '--no-webmcp'],
    env: {},
    builtin: true,
    connectTimeoutMs: 30000
  };
}

function isReservedUserServer(server) {
  return Boolean(server && server.name === NAME && !server.builtin);
}

async function connect(connectServer) {
  if (registry.has(NAME)) await registry.closeAndDelete(NAME);
  try {
    const server = createServer();
    const tools = await connectServer(server);
    return { name: NAME, type: server.type, ok: true, toolCount: tools.length, tools };
  } catch (error) {
    return { name: NAME, type: 'stdio', ok: false, error: error.message };
  }
}

function isConnected() {
  return registry.has(NAME);
}

async function disconnect() {
  await registry.closeAndDelete(NAME);
}

module.exports = {
  NAME,
  createServer,
  reservedNameError,
  isReservedUserServer,
  connect,
  isConnected,
  disconnect
};

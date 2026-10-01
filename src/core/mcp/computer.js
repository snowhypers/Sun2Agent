// Opt-in native desktop control. Never bypass the Docker sandbox.
const registry = require('./registry');
const NAME = 'computer';
const PACKAGE = require('../../../package.json').builtinMcpPackages.computer;
let vision = false;
function setVision(enabled) { vision = enabled === true; }
function usesVision() { return isConnected() && vision; }

function createServer() {
  return {
    name: NAME, type: 'stdio', command: 'npx',
    args: ['-y', PACKAGE],
    env: {}, builtin: true, connectTimeoutMs: 30000
  };
}
function reservedNameError() { return '"computer" is reserved for Sun2Agent desktop tools'; }
function isReservedUserServer(server) { return server?.name === NAME && !server.builtin; }
function isConnected() { return registry.has(NAME); }
async function disconnect() { vision = false; await registry.closeAndDelete(NAME); }
async function connect(connectServer, signal) {
  if (isConnected()) return { ok: true, name: NAME };
  try {
    const tools = await connectServer(createServer(), signal);
    return { ok: true, name: NAME, tools, toolCount: tools.length };
  } catch (error) {
    await disconnect();
    return { ok: false, name: NAME, error: error.message };
  }
}
module.exports = { NAME, createServer, reservedNameError, isReservedUserServer, isConnected, connect, disconnect, setVision, usesVision };

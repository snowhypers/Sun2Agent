// MCP connection registry: tracks the live client + transport + tools for
// every server connected in the current chat session, and exposes the
// read-only views the rest of the app needs (active name, tag, OpenAI spec,
// connection signature, etc.).
//
// This module owns *state*; transports/ owns *how to connect*; index.js
// owns the public orchestration API (connectAll, callTool, etc.).

// name -> { client, transport, tools, type }
const connections = new Map();

// Sanitize into a valid OpenAI function name: [a-zA-Z0-9_-], max 64 chars.
function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

// ----- mutation (called from transports/connectors in index.js) ----------

function set(serverName, entry) {
  connections.set(serverName, entry);
}

function deleteByName(serverName) {
  connections.delete(serverName);
}

async function closeAndDelete(serverName) {
  const entry = connections.get(serverName);
  if (!entry) return;
  try {
    await entry.client.close();
  } catch (_) {
    /* ignore */
  }
  connections.delete(serverName);
}

// Close every live connection and clear the map. Errors per-client are
// swallowed: we are tearing down, not surfacing.
async function disconnectAll() {
  for (const [, c] of connections) {
    try {
      await c.client.close();
    } catch (_) {
      /* ignore */
    }
  }
  connections.clear();
}

// ----- read-only views ---------------------------------------------------

// Name of the currently active server (or null). With single-server
// connections this is just the one connected server.
function getActiveName() {
  const it = connections.keys().next();
  return it.done ? null : it.value;
}

// Tag shown under the input box: null when nothing is connected, the single
// server name when one is connected, or "allMcps" when several are.
function getTag() {
  const n = connections.size;
  if (n === 0) return null;
  if (n === 1) return connections.keys().next().value;
  return 'allMcps';
}

// Stable signature of what is connected, for detecting changes (e.g. to reset
// chat context when the connected set changes).
function getConnectionSignature() {
  return [...connections.keys()].sort().join(',');
}

// Snapshot of what is connected right now (for the "Connect MCP" list view).
function getConnections() {
  return [...connections.entries()].map(([name, c]) => ({
    name,
    type: c.type,
    tools: c.tools.map((t) => t.name)
  }));
}

function connectedCount() {
  return connections.size;
}

function get(serverName) {
  return connections.get(serverName);
}

function has(serverName) {
  return connections.has(serverName);
}

// All connected tools as OpenAI/NIM function specs, plus a routing map so a
// returned tool_call name can be traced back to (server, originalToolName).
function getOpenAiTools() {
  const specs = [];
  const routes = new Map(); // fullName -> { server, tool }
  for (const [server, c] of connections) {
    for (const t of c.tools) {
      const fullName = sanitize(`${server}__${t.name}`);
      routes.set(fullName, { server, tool: t.name });
      specs.push({
        type: 'function',
        function: {
          name: fullName,
          description: t.description || `${t.name} (from ${server})`,
          parameters: t.inputSchema || { type: 'object', properties: {} }
        }
      });
    }
  }
  return { specs, routes };
}

module.exports = {
  // mutation
  set,
  deleteByName,
  closeAndDelete,
  disconnectAll,
  // read-only
  getActiveName,
  getTag,
  getConnectionSignature,
  getConnections,
  connectedCount,
  get,
  has,
  getOpenAiTools
};

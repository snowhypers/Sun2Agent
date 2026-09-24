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

// Name of the currently active user server (or the built-in server when it is
// the only connection). Built-ins do not change which user MCP is selected.
function getActiveName() {
  const userNames = [...connections]
    .filter(([, connection]) => !connection.builtin)
    .map(([name]) => name);
  if (userNames.length > 0) return userNames[0];
  const it = connections.keys().next();
  return it.done ? null : it.value;
}

// Tag shown under the input box. Workspace keeps its existing quiet behavior
// beside a user MCP; browser is always shown so browser control is visible.
function getTag() {
  const userNames = [...connections]
    .filter(([, connection]) => !connection.builtin)
    .map(([name]) => name);
  const builtinNames = [...connections]
    .filter(([, connection]) => connection.builtin)
    .map(([name]) => name);
  const browserConnected = builtinNames.includes('browser');
  if (userNames.length === 1) {
    return browserConnected ? `browser @${userNames[0]}` : userNames[0];
  }
  if (userNames.length > 1) {
    return browserConnected ? 'browser @allMcps' : 'allMcps';
  }
  if (builtinNames.length === 1) return builtinNames[0];
  if (builtinNames.length > 1) return builtinNames.join(' @');
  return null;
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
    builtin: Boolean(c.builtin),
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
      routes.set(fullName, {
        server,
        tool: t.name,
        annotations: t.annotations || {}
      });
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

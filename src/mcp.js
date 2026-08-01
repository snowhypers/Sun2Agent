// MCP client manager.
//
// Connects sun2Agent to MCP servers defined in mcp.json (local stdio or
// remote http/sse), keeps the live connections for the current chat session,
// exposes their tools to the model in OpenAI "function" format, and routes
// tool calls back to the right server.
//
// The @modelcontextprotocol/sdk is ESM-only, so it is pulled in with dynamic
// import() from this CommonJS module (safe on Node 18+).

const { getServers } = require('./mcpconfig');
const { version: VERSION } = require('../package.json');
const guardrails = require('../guardrails');

// name -> { client, transport, tools, type }
const connections = new Map();

// Lazily import the SDK pieces once.
let sdk = null;
async function loadSdk() {
  if (sdk) return sdk;
  const [{ Client }, { StdioClientTransport }, { StreamableHTTPClientTransport }, { SSEClientTransport }, { CallToolResultSchema }] =
    await Promise.all([
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/client/stdio.js'),
      import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
      import('@modelcontextprotocol/sdk/client/sse.js'),
      import('@modelcontextprotocol/sdk/types.js')
    ]);
  sdk = { Client, StdioClientTransport, StreamableHTTPClientTransport, SSEClientTransport, CallToolResultSchema };
  return sdk;
}

function buildTransport(s, S) {
  const headers = s.headers && Object.keys(s.headers).length ? s.headers : undefined;
  switch (s.type) {
    case 'stdio':
      if (!s.command) throw new Error('stdio server needs a "command"');
      return new S.StdioClientTransport({
        command: s.command,
        args: s.args,
        // Inherit the parent env so PATH etc. resolve, then layer overrides.
        env: { ...process.env, ...s.env }
      });
    case 'http':
    case 'https':
    case 'streamable-http':
    case 'remote': // alias used by some other MCP clients
      if (!s.url) throw new Error('http server needs a "url"');
      return new S.StreamableHTTPClientTransport(new URL(s.url), {
        requestInit: headers ? { headers } : undefined
      });
    case 'sse':
      if (!s.url) throw new Error('sse server needs a "url"');
      return new S.SSEClientTransport(new URL(s.url), {
        requestInit: headers ? { headers } : undefined
      });
    default:
      throw new Error(`unknown server type "${s.type}"`);
  }
}

// Connect a single server definition and record its tools. Throws on failure.
async function connectServer(s) {
  // A stdio server runs a real command — vet it before spawning anything.
  const verdict = guardrails.validateServer(s);
  if (!verdict.ok) throw new Error(verdict.reason);

  const S = await loadSdk();
  const transport = buildTransport(s, S);
  const client = new S.Client({ name: 'sun2agent', version: VERSION }, { capabilities: {} });
  await client.connect(transport);
  const { tools } = await client.listTools();
  connections.set(s.name, { client, transport, tools: tools || [], type: s.type });
  return tools || [];
}

// Connect every server in mcp.json. Returns per-server results so the caller
// can show which connected and which failed without aborting on one bad entry.
async function connectFromConfig() {
  const servers = getServers();
  const results = [];
  for (const s of servers) {
    // Reconnect cleanly if it was already connected.
    if (connections.has(s.name)) {
      try {
        await connections.get(s.name).client.close();
      } catch (_) {
        /* ignore */
      }
      connections.delete(s.name);
    }
    try {
      const tools = await connectServer(s);
      results.push({ name: s.name, type: s.type, ok: true, toolCount: tools.length, tools });
    } catch (e) {
      results.push({ name: s.name, type: s.type, ok: false, error: e.message });
    }
  }
  return results;
}

// Connect ONLY the named server, disconnecting any others first, so that a
// single MCP server is active in the chat at a time. Returns a result object.
async function connectSelected(name) {
  await disconnectAll();
  const server = getServers().find((s) => s.name === name);
  if (!server) throw new Error(`server "${name}" is not defined in mcp.json`);
  try {
    const tools = await connectServer(server);
    return { name, type: server.type, ok: true, toolCount: tools.length, tools };
  } catch (e) {
    return { name, type: server.type, ok: false, error: e.message };
  }
}

// Connect ALL servers in mcp.json at once (multi-server mode), disconnecting
// anything currently connected first. Returns per-server results.
async function connectAll() {
  await disconnectAll();
  const servers = getServers();
  const results = [];
  for (const s of servers) {
    try {
      const tools = await connectServer(s);
      results.push({ name: s.name, type: s.type, ok: true, toolCount: tools.length, tools });
    } catch (e) {
      results.push({ name: s.name, type: s.type, ok: false, error: e.message });
    }
  }
  return results;
}

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

// Sanitize into a valid OpenAI function name: [a-zA-Z0-9_-], max 64 chars.
function sanitize(name) {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
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

// Execute a tool call routed by getOpenAiTools() and return a text result.
// `signal` is an optional AbortSignal so a long tool call can be cancelled.
async function callTool(routes, fullName, args, signal) {
  const route = routes.get(fullName);
  if (!route) throw new Error(`no MCP tool named "${fullName}"`);
  const conn = connections.get(route.server);
  if (!conn) throw new Error(`server "${route.server}" is not connected`);

  // Guardrails: command -> network -> filesystem, over every argument the
  // model supplied. Refusing here means the tool never runs at all.
  const verdict = guardrails.validateToolCall(route.tool, args);
  if (!verdict.ok) throw new Error(verdict.reason);
  // Use client.request() directly instead of client.callTool(): callTool()
  // rejects responses from servers that declare an outputSchema but return
  // only text content (spec-strict). Real-world servers often do exactly
  // that, so be lenient like most other MCP clients.
  const S = await loadSdk();
  const result = await conn.client.request(
    { method: 'tools/call', params: { name: route.tool, arguments: args || {} } },
    S.CallToolResultSchema,
    signal ? { signal } : undefined
  );
  // Flatten MCP content blocks to plain text for the model.
  if (Array.isArray(result.content) && result.content.length) {
    return result.content
      .map((b) => (b.type === 'text' ? b.text : JSON.stringify(b)))
      .join('\n');
  }
  // Servers may return structured output with no text blocks.
  if (result.structuredContent) return JSON.stringify(result.structuredContent);
  return JSON.stringify(result);
}

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



module.exports = {
  connectFromConfig,
  connectSelected,
  connectAll,
  getActiveName,
  getTag,
  getConnectionSignature,
  getConnections,
  connectedCount,
  getOpenAiTools,
  callTool,
  disconnectAll
};
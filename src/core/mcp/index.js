// MCP client manager — public API.
//
// Connects sun2Agent to MCP servers defined in mcp.json (local stdio or
// remote http/sse), keeps the live connections for the current chat session,
// exposes their tools to the model in OpenAI "function" format, and routes
// tool calls back to the right server.
//
// This file is the orchestrator. Supporting concerns are split by purpose:
// concern is one short read:
//
//   ./registry.js     state: live connections + read-only views
//                     (getOpenAiTools, getTag, getConnectionSignature, …)
//   ./transports.js   how a connection is built (stdio / http / sse),
//                     including the safe child-env allowlist for stdio
//   ./workspace.js    built-in filesystem MCP lifecycle and workspace policy
//   ./index.js        (this file) connect/disconnect orchestration and the
//                     guarded tool-call dispatch (guardrails + HITL +
//                     observability tracing, in that order)
//
// The @modelcontextprotocol/sdk is ESM-only, so it is pulled in with dynamic
// import() from ./transports.js.

const { getServers } = require('./config');
const { version: VERSION } = require('../../../package.json');
const guardrails = require('../guardrails');
const observability = require('../observability');
const hitl = require('../hitl/mcpApproval');
const registry = require('./registry');
const { loadSdk, buildTransport } = require('./transports');
const workspace = require('./workspace');

const DEFAULT_MCP_CONNECTION_TIMEOUT_MS = 20000;

function connectionTimeoutMs(server) {
  const perServer = Number(server && server.connectTimeoutMs);
  if (Number.isFinite(perServer) && perServer > 0) return Math.floor(perServer);
  const globalTimeout = Number(process.env.SUN2AGENT_MCP_CONNECT_TIMEOUT_MS);
  if (Number.isFinite(globalTimeout) && globalTimeout > 0) return Math.floor(globalTimeout);
  return DEFAULT_MCP_CONNECTION_TIMEOUT_MS;
}

function connectionTimeoutError(server, timeout) {
  return new Error(`MCP connection to "${server.name}" timed out after ${timeout}ms.`);
}

// Connect a single server definition and record its tools. Throws on failure.
async function connectServer(s) {
  if (workspace.isReservedUserServer(s)) {
    throw new Error(workspace.reservedNameError());
  }
  // A stdio server runs a real command — vet it before spawning anything.
  const verdict = guardrails.validateServer(s);
  if (!verdict.ok) throw new Error(verdict.reason);

  const S = await loadSdk();
  const transport = buildTransport(s, S);
  const client = new S.Client({ name: 'sun2agent', version: VERSION }, { capabilities: {} });
  const timeout = connectionTimeoutMs(s);
  let timer;
  try {
    const { tools } = await Promise.race([
      (async () => {
        const requestOptions = { timeout, maxTotalTimeout: timeout };
        await client.connect(transport, requestOptions);
        return client.listTools(undefined, requestOptions);
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(connectionTimeoutError(s, timeout)), timeout);
      })
    ]);
    const listedTools = tools || [];
    const localTools = s.builtin
      ? workspace.getLocalTools().filter(
          (localTool) => !listedTools.some((tool) => tool.name === localTool.name)
        )
      : [];
    const availableTools = [...listedTools, ...localTools];
    registry.set(s.name, {
      client,
      transport,
      tools: availableTools,
      type: s.type,
      builtin: Boolean(s.builtin)
    });
    return availableTools;
  } catch (error) {
    try { await client.close(); } catch (_) { /* best-effort timeout cleanup */ }
    if (/timed?\s*out|timeout/i.test(String(error && error.message))) {
      throw connectionTimeoutError(s, timeout);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function connectWorkspace(root = process.cwd()) {
  return workspace.connect(root, connectServer);
}

async function disconnectUserServers() {
  return workspace.disconnectUserServers();
}

function hasUserConnections() {
  return workspace.hasUserConnections();
}

function isWorkspaceConnected() {
  return workspace.isConnected();
}

async function disconnectWorkspace() {
  return workspace.disconnect();
}

// Connect every server in mcp.json. Returns per-server results so the caller
// can show which connected and which failed without aborting on one bad entry.
async function connectFromConfig() {
  const servers = getServers();
  return Promise.all(servers.map(async (s) => {
    if (workspace.isReservedUserServer(s)) {
      return {
        name: s.name,
        type: s.type,
        ok: false,
        error: workspace.reservedNameError()
      };
    }
    // Reconnect cleanly if it was already connected.
    if (registry.has(s.name)) await registry.closeAndDelete(s.name);
    try {
      const tools = await connectServer(s);
      return { name: s.name, type: s.type, ok: true, toolCount: tools.length, tools };
    } catch (e) {
      return { name: s.name, type: s.type, ok: false, error: e.message };
    }
  }));
}

// Connect ONLY the named server, disconnecting any others first, so that a
// single MCP server is active in the chat at a time. Returns a result object.
async function connectSelected(name) {
  await disconnectUserServers();
  const server = getServers().find((s) => s.name === name);
  if (!server) throw new Error(`server "${name}" is not defined in mcp.json`);
  try {
    const tools = await connectServer(server);
    return { name, type: server.type, ok: true, toolCount: tools.length, tools };
  } catch (e) {
    return { name, type: server.type, ok: false, error: e.message };
  }
}

// Connect ALL user-configured servers in mcp.json at once while preserving the
// built-in workspace connection. Returns per-server results.
async function connectAll() {
  await disconnectUserServers();
  const servers = getServers();
  return Promise.all(servers.map(async (s) => {
    try {
      const tools = await connectServer(s);
      return { name: s.name, type: s.type, ok: true, toolCount: tools.length, tools };
    } catch (e) {
      return { name: s.name, type: s.type, ok: false, error: e.message };
    }
  }));
}

// Execute a tool call routed by getOpenAiTools() and return a text result.
// `signal` is an optional AbortSignal so a long tool call can be cancelled.
async function callTool(routes, fullName, args, signal) {
  const route = routes.get(fullName);
  if (!route) throw new Error(`no MCP tool named "${fullName}"`);
  const conn = registry.get(route.server);
  if (!conn) throw new Error(`server "${route.server}" is not connected`);

  // Guardrails: command -> network -> filesystem, over every argument the
  // model supplied. Refusing here means the tool never runs at all.
  const verdict = guardrails.validateToolCall(route.tool, args);
  if (!verdict.ok) throw new Error(verdict.reason);

  // Human-in-the-Loop: the call is blocked unless a human approves it. This
  // sits at the execution boundary (after guardrails, before the tool runs) —
  // outside the LLM/ReAct logic — so every proposed call is vetted here.
  const approved = await hitl.checkApproval({
    server: route.server,
    tool: route.tool,
    args: args || {},
    annotations: route.annotations
  });
  if (!approved) {
    return (
      `MCP call to "${route.tool}" was NOT executed — a human declined ` +
      `approval. Tell the user which call was blocked and why the task ` +
      `could not proceed as proposed.`
    );
  }

  // The actual MCP tool execution, wrapped by LangSmith tracing when enabled.
  // Tool args, routing, and the guardrail verdict above are unchanged.
  return observability.traceTool(async () => {
    if (route.server === workspace.NAME && workspace.isLocalTool(route.tool)) {
      return workspace.callLocalTool(route.tool, args);
    }
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
  }, { toolName: route.tool, server: route.server, args });
}

module.exports = {
  WORKSPACE_NAME: workspace.NAME,
  workspaceServer: workspace.createServer,
  connectWorkspace,
  isWorkspaceConnected,
  disconnectWorkspace,
  disconnectUserServers,
  hasUserConnections,
  connectFromConfig,
  connectSelected,
  connectAll,
  getActiveName: registry.getActiveName,
  getTag: registry.getTag,
  getConnectionSignature: registry.getConnectionSignature,
  getConnections: registry.getConnections,
  connectedCount: registry.connectedCount,
  getOpenAiTools: registry.getOpenAiTools,
  callTool,
  disconnectAll: registry.disconnectAll
};

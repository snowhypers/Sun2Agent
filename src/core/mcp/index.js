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
//   ../filesystem/    built-in filesystem MCP lifecycle and workspace policy
//   ../browser/       opt-in isolated Playwright MCP lifecycle
//   ../computer/      opt-in native desktop MCP lifecycle
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
const filesystem = require('../filesystem');
const browser = require('../browser');
const computer = require('../computer');
const telegramPolicy = require('./telegramPolicy');

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
async function connectServer(s, signal) {
  if (signal?.aborted) throw new Error('Connection cancelled');
  if (computer.isReservedUserServer(s)) throw new Error(computer.reservedNameError());
  if (filesystem.isReservedUserServer(s)) {
    throw new Error(filesystem.reservedNameError());
  }
  if (browser.isReservedUserServer(s)) {
    throw new Error(browser.reservedNameError());
  }
  // A stdio server runs a real command — vet it before spawning anything.
  const verdict = guardrails.validateServer(s);
  if (!verdict.ok) throw new Error(verdict.reason);

  const S = await loadSdk();
  const transport = buildTransport(s, S);
  const client = new S.Client({ name: 'sun2agent', version: VERSION }, { capabilities: {} });
  const timeout = connectionTimeoutMs(s);
  let timer;
  let onAbort;
  const cancelled = new Promise((_, reject) => {
    onAbort = () => reject(new Error('Connection cancelled'));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
  try {
    const { tools } = await Promise.race([
      cancelled,
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
    const localTools = s.name === filesystem.NAME
      ? filesystem.getLocalTools().filter(
          (localTool) => !listedTools.some((tool) => tool.name === localTool.name)
        )
      : s.name === computer.NAME
        ? computer.getLocalTools().filter(
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
    signal?.removeEventListener('abort', onAbort);
  }
}

async function connectWorkspace(root = process.cwd()) {
  return filesystem.connect(root, connectServer);
}

async function disconnectUserServers() {
  return filesystem.disconnectUserServers();
}

function hasUserConnections() {
  return filesystem.hasUserConnections();
}

function isWorkspaceConnected() {
  return filesystem.isConnected();
}

async function disconnectWorkspace() {
  return filesystem.disconnect();
}

async function connectBrowser() {
  return browser.connect(connectServer);
}

function isBrowserConnected() {
  return browser.isConnected();
}

async function disconnectBrowser() {
  return browser.disconnect();
}

// Connect every server in mcp.json. Returns per-server results so the caller
// can show which connected and which failed without aborting on one bad entry.
async function connectFromConfig() {
  const servers = getServers();
  return Promise.all(servers.map(async (s) => {
    if (computer.isReservedUserServer(s)) {
      return { name: s.name, type: s.type, ok: false, error: computer.reservedNameError() };
    }
    if (filesystem.isReservedUserServer(s)) {
      return {
        name: s.name,
        type: s.type,
        ok: false,
        error: filesystem.reservedNameError()
      };
    }
    if (browser.isReservedUserServer(s)) {
      return {
        name: s.name,
        type: s.type,
        ok: false,
        error: browser.reservedNameError()
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

function getTelegramTools() {
  const connectedRemotes = new Set(registry.getConnections()
    .filter((connection) => !connection.builtin &&
      ['http', 'https', 'streamable-http', 'remote', 'sse'].includes(connection.type))
    .map((connection) => connection.name));
  const allowedServers = new Set(getServers()
    .filter((server) => connectedRemotes.has(server.name) && telegramPolicy.isRemoteServer(server))
    .map((server) => server.name));
  const { specs, routes } = registry.getOpenAiTools();
  const safeRoutes = new Map([...routes].filter(([, route]) =>
    allowedServers.has(route.server) && telegramPolicy.isReadOnlyTool(route)));
  return { specs: specs.filter((spec) => safeRoutes.has(spec.function.name)), routes: safeRoutes };
}

async function callTelegramTool(name, args, signal) {
  const { routes } = getTelegramTools();
  if (!routes.has(name)) throw new Error(`Tool "${name}" is unavailable in Telegram.`);
  return callTool(routes, name, args, signal, { telegramReadOnly: true });
}

// Execute a tool call routed by getOpenAiTools() and return a text result.
// `signal` is an optional AbortSignal so a long tool call can be cancelled.
async function callTool(routes, fullName, args, signal, options = {}) {
  const route = routes.get(fullName);
  if (!route) throw new Error(`no MCP tool named "${fullName}"`);
  const conn = registry.get(route.server);
  if (!conn) throw new Error(`server "${route.server}" is not connected`);
  if (options.telegramReadOnly && !getTelegramTools().routes.has(fullName)) {
    throw new Error(`Tool "${fullName}" is unavailable in Telegram.`);
  }

  // Guardrails: command -> network -> filesystem, over every argument the
  // model supplied. Refusing here means the tool never runs at all.
  const verdict = guardrails.validateToolCall(route.tool, args);
  if (!verdict.ok) throw new Error(verdict.reason);

  // Human-in-the-Loop: the call is blocked unless a human approves it. This
  // sits at the execution boundary (after guardrails, before the tool runs) —
  // outside the LLM/ReAct logic — so every proposed call is vetted here.
  const approved = options.telegramReadOnly || await hitl.checkApproval({
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
  if (signal?.aborted) throw new Error('Tool call cancelled before execution');

  // The actual MCP tool execution, wrapped by LangSmith tracing when enabled.
  // Tool args, routing, and the guardrail verdict above are unchanged.
  return observability.traceTool(async () => {
    if (route.server === filesystem.NAME && filesystem.isLocalTool(route.tool)) {
      return filesystem.callLocalTool(route.tool, { ...args, signal });
    }
    if (route.server === computer.NAME && computer.isLocalTool(route.tool)) {
      return computer.callLocalTool(route.tool, args, signal);
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
    const formatted = require('./toolResult').formatToolResult(result, options.includeImages === true);
    if (result.isError === true) {
      throw new Error('MCP tool reported an error: ' +
        (typeof formatted === 'string' ? formatted : formatted.text));
    }
    if (route.server === filesystem.NAME && result.isError !== true &&
        (route.tool === 'write_file' || route.tool === 'edit_file')) {
      const verified = await filesystem.verifyJavaTestWrite(route.tool, args);
      if (verified) return `${formatted}\n${verified}`;
    }
    return formatted;
  }, { toolName: route.tool, server: route.server, args });
}

module.exports = {
  computerServer: computer.createServer,
  connectComputer: (signal) => computer.connect(connectServer, signal),
  isComputerConnected: computer.isConnected,
  disconnectComputer: computer.disconnect,
  WORKSPACE_NAME: filesystem.NAME,
  workspaceServer: filesystem.createServer,
  connectWorkspace,
  isWorkspaceConnected,
  disconnectWorkspace,
  BROWSER_NAME: browser.NAME,
  browserServer: browser.createServer,
  connectBrowser,
  isBrowserConnected,
  disconnectBrowser,
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
  getTelegramTools,
  callTelegramTool,
  callTool,
  disconnectAll: registry.disconnectAll
};

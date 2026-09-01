// MCP client manager — public API.
//
// Connects sun2Agent to MCP servers defined in mcp.json (local stdio or
// remote http/sse), keeps the live connections for the current chat session,
// exposes their tools to the model in OpenAI "function" format, and routes
// tool calls back to the right server.
//
// This file is the orchestrator. It is split across three files so each
// concern is one short read:
//
//   ./registry.js     state: live connections + read-only views
//                     (getOpenAiTools, getTag, getConnectionSignature, …)
//   ./transports.js   how a connection is built (stdio / http / sse),
//                     including the safe child-env allowlist for stdio
//   ./index.js        (this file) connect/disconnect orchestration and the
//                     guarded tool-call dispatch (guardrails + HITL +
//                     observability tracing, in that order)
//
// The @modelcontextprotocol/sdk is ESM-only, so it is pulled in with dynamic
// import() from ./transports.js (safe on Node 18+).

const { getServers } = require('./config');
const { version: VERSION } = require('../../../package.json');
const guardrails = require('../guardrails');
const observability = require('../observability');
const hitl = require('../hitl/mcpApproval');
const registry = require('./registry');
const { loadSdk, buildTransport } = require('./transports');

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
  registry.set(s.name, { client, transport, tools: tools || [], type: s.type });
  return tools || [];
}

// Connect every server in mcp.json. Returns per-server results so the caller
// can show which connected and which failed without aborting on one bad entry.
async function connectFromConfig() {
  const servers = getServers();
  const results = [];
  for (const s of servers) {
    // Reconnect cleanly if it was already connected.
    if (registry.has(s.name)) await registry.closeAndDelete(s.name);
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
  await registry.disconnectAll();
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
  await registry.disconnectAll();
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
    args: args || {}
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

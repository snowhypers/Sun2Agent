// Opt-in native desktop control. Never bypass the Docker sandbox.
const registry = require('../mcp/registry');
const { loadSdk } = require('../mcp/transports');
const { setTimeout: delay } = require('node:timers/promises');
const NAME = 'computer';
const PACKAGE = require('../../../package.json').builtinMcpPackages.computer;
const LOCAL_TOOLS = [
  {
    name: 'sun2agent_wait_for_window',
    description: 'Wait locally for a window belonging to an app. Use once after opening an app instead of repeated wait/list_windows calls. If no window appears, stop repeating the same check.',
    inputSchema: { type: 'object', properties: {
      bundle_id: { type: 'string', description: 'Target app bundle ID' },
      timeout_ms: { type: 'integer', minimum: 0, maximum: 10000, default: 10000 }
    }, required: ['bundle_id'], additionalProperties: false }
  },
  {
    name: 'sun2agent_search_tools',
    description: 'Find additional computer tools by name or purpose when the visible tools cannot perform the task. This only discovers tool schemas; execution still uses guardrails and HITL.',
    inputSchema: { type: 'object', properties: {
      query: { type: 'string', description: 'Tool name or purpose, such as fill_form or run_script' }
    }, required: ['query'], additionalProperties: false }
  }
];
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

function getLocalTools() { return LOCAL_TOOLS; }
function isLocalTool(name) { return LOCAL_TOOLS.some((tool) => tool.name === name); }

function searchToolNames(query) {
  const terms = String(query || '').toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const tools = registry.get(NAME)?.tools || [];
  return tools.filter((tool) => !isLocalTool(tool.name))
    .map((tool) => {
      const name = tool.name.toLowerCase();
      const description = String(tool.description || '').toLowerCase();
      const score = name.includes(terms.join('_')) ? 3
        : terms.every((term) => name.includes(term)) ? 2
          : terms.every((term) => `${name} ${description}`.includes(term)) ? 1 : 0;
      return { name: tool.name, description: String(tool.description || '').slice(0, 180), score };
    })
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, 8);
}

async function callLocalTool(name, args = {}, signal) {
  if (name === 'sun2agent_search_tools') {
    const matches = searchToolNames(args.query);
    return matches.length ? JSON.stringify(matches.map(({ name, description }) => ({ name, description })))
      : 'No matching computer tools. Refine the query or explain the limitation.';
  }
  if (name !== 'sun2agent_wait_for_window') throw new Error(`unknown computer tool "${name}"`);
  const bundleId = args.bundle_id;
  if (typeof bundleId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/.test(bundleId)) {
    throw new Error('a valid app bundle_id is required');
  }
  const timeout = Number.isInteger(args.timeout_ms) ? Math.max(0, Math.min(10000, args.timeout_ms)) : 10000;
  const conn = registry.get(NAME);
  if (!conn?.client) throw new Error('computer tools are not connected');
  const S = await loadSdk();
  const deadline = Date.now() + timeout;
  do {
    if (signal?.aborted) throw new Error('Window wait cancelled');
    const requestTimeout = Math.max(1, Math.min(3000, deadline - Date.now()));
    const result = await conn.client.request(
      { method: 'tools/call', params: { name: 'list_windows', arguments: { bundle_id: bundleId } } },
      S.CallToolResultSchema,
      { timeout: requestTimeout, maxTotalTimeout: requestTimeout, ...(signal ? { signal } : {}) }
    );
    const raw = result.content?.find((part) => part.type === 'text')?.text || '';
    if (result.isError) throw new Error(raw || 'Window inspection failed');
    let windows;
    try { windows = JSON.parse(raw).windows; } catch (_) { throw new Error('Window inspection returned invalid data'); }
    if (!Array.isArray(windows)) throw new Error('Window inspection returned no window list');
    if (windows.length) return `Window ready for ${bundleId}: ${JSON.stringify(windows.slice(0, 3))}`;
    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(300, remaining), undefined, { signal });
  } while (Date.now() < deadline);
  return `No window appeared for ${bundleId} within ${timeout}ms. Do not repeat the same wait; use a different approach or report the limitation.`;
}

module.exports = { NAME, createServer, reservedNameError, isReservedUserServer, isConnected, connect, disconnect, setVision, usesVision, getLocalTools, isLocalTool, searchToolNames, callLocalTool };

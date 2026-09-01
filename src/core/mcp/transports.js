// Transport-construction helpers for MCP servers.
//
// Three transports are supported: stdio (spawn a child process), streamable
// HTTP, and SSE. The right one is picked from the server's `type` field in
// mcp.json. Each helper takes the pre-loaded SDK pieces so the caller can
// amortize the dynamic-import cost.
//
// Security notes (stdio only — the HTTP transports talk to a URL the user
// trusts as much as they trust their own mcp.json):
//   - The host process's environment is sanitized before being passed to
//     child servers. API keys / AWS creds / LangSmith secrets never leak.
//   - The stdio command is wrapped through the sandbox when the user has
//     Docker sandboxing enabled.

// The MCP SDK is ESM-only; load it once via dynamic import (Node 18+).
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

// Exact-match safe vars (no prefix) and prefix-match groups. LANG matches
// only "LANG" — not "LANGSMITH_*" — which is correct because LangSmith
// keys must never reach child MCP processes.
const SAFE_ENV = new Set([
  'PATH', 'HOME', 'LANG', 'TERM', 'TMPDIR', 'SHELL', 'USER',
  'PYTHONPATH', 'PYTHONHOME'
]);
const SAFE_ENV_PREFIXES = ['LC_', 'NODE_', 'NPM_', 'XDG_'];

function safeChildEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (SAFE_ENV.has(key) || SAFE_ENV_PREFIXES.some((p) => key.startsWith(p))) {
      env[key] = value;
    }
  }
  return env;
}

// stdio: spawn a child process. When the Docker sandbox is enabled, the
// command is wrapped through the sandbox module so the child runs inside an
// isolated container with the project at /workspace. Guardrails have already
// vetted s.command/s.args in connectServer().
function buildStdio(s, S) {
  if (!s.command) throw new Error('stdio server needs a "command"');
  const sandbox = require('../sandbox');
  const wrapped = sandbox.wrapStdioCommand(s.command, s.args);
  return new S.StdioClientTransport({
    command: wrapped.command,
    args: wrapped.args,
    // Inherit the parent env so PATH etc. resolve, then layer overrides.
    env: { ...safeChildEnv(), ...s.env }
  });
}

// Streamable HTTP. `headers` (if any) are passed through on every request.
function buildHttp(s, S) {
  if (!s.url) throw new Error('http server needs a "url"');
  const headers = s.headers && Object.keys(s.headers).length ? s.headers : undefined;
  return new S.StreamableHTTPClientTransport(new URL(s.url), {
    requestInit: headers ? { headers } : undefined
  });
}

// Legacy SSE transport. Same headers handling as HTTP.
function buildSse(s, S) {
  if (!s.url) throw new Error('sse server needs a "url"');
  const headers = s.headers && Object.keys(s.headers).length ? s.headers : undefined;
  return new S.SSEClientTransport(new URL(s.url), {
    requestInit: headers ? { headers } : undefined
  });
}

// Dispatch: pick the right transport from the server definition. Throws on
// unknown types so connectServer() surfaces a clear error to the user.
function buildTransport(s, S) {
  switch (s.type) {
    case 'stdio':
      return buildStdio(s, S);
    case 'http':
    case 'https':
    case 'streamable-http':
    case 'remote': // alias used by some other MCP clients
      return buildHttp(s, S);
    case 'sse':
      return buildSse(s, S);
    default:
      throw new Error(`unknown server type "${s.type}"`);
  }
}

module.exports = { loadSdk, buildTransport };

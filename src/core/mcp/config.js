const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

// mcp.json lives next to config.json in ~/.sun2agent/
const CONFIG_DIR = path.join(os.homedir(), '.sun2agent');
const MCP_FILE = path.join(CONFIG_DIR, 'mcp.json');

// Template written on first use. `mcpServers` is what actually gets loaded;
// `_examples` is ignored by the loader and only exists to show the 3 formats
// a user can add: local stdio, remote http(s), and remote SSE.
const TEMPLATE = {
  mcpServers: {},
  _examples: {
    'local-stdio-server': {
      type: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
      env: {}
    },
    'remote-http-server': {
      type: 'http',
      url: 'https://your-server.example.com/mcp'
    },
    'remote-sse-server': {
      type: 'sse',
      url: 'https://your-server.example.com/sse'
    }
  }
};

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

// Create mcp.json with the template if it does not exist yet.
function ensureMcpConfig() {
  ensureConfigDir();
  if (!fs.existsSync(MCP_FILE)) {
    // mcp.json can hold API keys (headers / URLs) — create it owner-only (0600).
    fs.writeFileSync(MCP_FILE, JSON.stringify(TEMPLATE, null, 2), { mode: 0o600 });
  }
  try {
    fs.chmodSync(MCP_FILE, 0o600); // keep it owner-only even if it pre-existed
  } catch (e) {
    /* best effort */
  }
  return MCP_FILE;
}

function getMcpFilePath() {
  return MCP_FILE;
}

// Read and parse mcp.json. Returns { mcpServers: {...} } (never throws).
function loadMcpConfig() {
  ensureMcpConfig();
  try {
    const raw = JSON.parse(fs.readFileSync(MCP_FILE, 'utf-8'));
    if (!raw.mcpServers || typeof raw.mcpServers !== 'object') raw.mcpServers = {};
    return raw;
  } catch (e) {
    return { mcpServers: {}, _parseError: e.message };
  }
}

// Infer a transport type when the user did not set one explicitly.
function inferType(def) {
  if (def.type) return String(def.type).toLowerCase();
  if (def.transport) return String(def.transport).toLowerCase();
  if (def.command) return 'stdio';
  if (def.url) return 'http';
  return 'stdio';
}

// Normalize mcpServers into a flat list the client can act on directly.
// Servers with "enabled": false are skipped.
function getServers() {
  const cfg = loadMcpConfig();
  return Object.entries(cfg.mcpServers)
    .filter(([, def]) => def.enabled !== false)
    .map(([name, def]) => ({
      name,
      type: inferType(def),
      command: def.command,
      args: def.args || [],
      env: def.env || {},
      url: def.url,
      headers: def.headers || {}
    }));
}

// Open mcp.json in the user's editor so they can add/edit servers by hand.
// Uses $EDITOR/$VISUAL when set, otherwise the OS default text handler.
// Returns true if an editor command was launched.
function openMcpConfig() {
  ensureMcpConfig();
  const editor = process.env.VISUAL || process.env.EDITOR;
  let cmd;
  let args;
  if (editor) {
    cmd = editor;
    args = [MCP_FILE];
  } else if (process.platform === 'darwin') {
    cmd = 'open';
    args = ['-t', MCP_FILE]; // open in default text editor
  } else if (process.platform === 'win32') {
    cmd = 'notepad';
    args = [MCP_FILE];
  } else {
    cmd = 'xdg-open';
    args = [MCP_FILE];
  }
  const res = spawnSync(cmd, args, { stdio: 'inherit' });
  return !res.error;
}

module.exports = {
  MCP_FILE,
  ensureMcpConfig,
  getMcpFilePath,
  loadMcpConfig,
  getServers,
  openMcpConfig
};

// Built-in workspace filesystem MCP.
//
// When enabled with /workspace, access is scoped to the directory where
// Sun2Agent started. It is kept separate from user-configured MCP servers so
// /mcp can connect and disconnect those servers independently.

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const registry = require('./registry');

const NAME = 'workspace';
let activeRoot = null;

const LOCAL_TOOLS = [
  {
    name: 'delete_file',
    description:
      'Permanently delete exactly one file inside the connected workspace. ' +
      'The action cannot be undone. Never substitute a similarly named file.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Exact path of the file to delete' }
      },
      required: ['path'],
      additionalProperties: false
    }
  },
  {
    name: 'delete_directory',
    description:
      'Permanently delete exactly one directory inside the connected workspace. ' +
      'Set recursive=true only when the user asked to remove a non-empty directory. ' +
      'The workspace root can never be deleted.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Exact path of the directory to delete' },
        recursive: {
          type: 'boolean',
          default: false,
          description: 'Whether to permanently remove the directory and all its contents'
        }
      },
      required: ['path'],
      additionalProperties: false
    }
  }
];

function reservedNameError() {
  return `"${NAME}" is reserved for Sun2Agent's built-in workspace tools`;
}

function createServer(root = process.cwd()) {
  const resolvedRoot = fs.realpathSync(path.resolve(root));
  if (resolvedRoot === path.parse(resolvedRoot).root) {
    throw new Error('refusing to expose the filesystem root as a workspace');
  }
  return {
    name: NAME,
    type: 'stdio',
    command: process.execPath,
    args: [
      require.resolve('@modelcontextprotocol/server-filesystem/dist/index.js'),
      resolvedRoot
    ],
    env: {},
    builtin: true
  };
}

function isReservedUserServer(server) {
  return Boolean(server && server.name === NAME && !server.builtin);
}

async function connect(root, connectServer) {
  if (registry.has(NAME)) await registry.closeAndDelete(NAME);
  activeRoot = null;
  try {
    const server = createServer(root);
    const tools = await connectServer(server);
    activeRoot = server.args.at(-1);
    return { name: NAME, type: server.type, ok: true, toolCount: tools.length, tools };
  } catch (error) {
    return { name: NAME, type: 'stdio', ok: false, error: error.message };
  }
}

async function disconnectUserServers() {
  const userConnections = registry.getConnections().filter((item) => !item.builtin);
  await Promise.all(userConnections.map((item) => registry.closeAndDelete(item.name)));
}

function hasUserConnections() {
  return registry.getConnections().some((item) => !item.builtin);
}

function isConnected() {
  return registry.has(NAME);
}

async function disconnect() {
  await registry.closeAndDelete(NAME);
  activeRoot = null;
}

function getLocalTools() {
  return LOCAL_TOOLS;
}

function isLocalTool(name) {
  return LOCAL_TOOLS.some((tool) => tool.name === name);
}

function isInside(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function resolveDeleteTarget(inputPath) {
  if (!activeRoot) throw new Error('/workspace is not connected');
  if (typeof inputPath !== 'string' || !inputPath.trim()) {
    throw new Error('an exact path is required');
  }

  const root = await fsp.realpath(activeRoot);
  const target = path.resolve(root, inputPath.trim());
  if (target === root) throw new Error('refusing to delete the workspace root');
  if (!isInside(root, target)) throw new Error('refusing to delete outside the workspace');

  // Resolve the parent to stop a symlinked directory from escaping the
  // workspace. The final item itself may be a symlink; unlinking that link is
  // safe and does not touch its target.
  const realParent = await fsp.realpath(path.dirname(target));
  if (!isInside(root, realParent)) throw new Error('refusing to delete outside the workspace');
  return path.join(realParent, path.basename(target));
}

async function callLocalTool(name, args = {}) {
  const target = await resolveDeleteTarget(args.path);
  const stat = await fsp.lstat(target);

  if (name === 'delete_file') {
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      throw new Error('path is a directory; use delete_directory instead');
    }
    await fsp.unlink(target);
    return `Permanently deleted file ${target}`;
  }

  if (name === 'delete_directory') {
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('path is not a directory; use delete_file instead');
    }
    if (args.recursive === true) await fsp.rm(target, { recursive: true, force: false });
    else await fsp.rmdir(target);
    return `Permanently deleted directory ${target}`;
  }

  throw new Error(`unknown workspace tool "${name}"`);
}

module.exports = {
  NAME,
  createServer,
  reservedNameError,
  isReservedUserServer,
  connect,
  disconnectUserServers,
  hasUserConnections,
  isConnected,
  disconnect,
  getLocalTools,
  isLocalTool,
  callLocalTool
};

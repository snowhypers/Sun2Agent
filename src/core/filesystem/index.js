// Built-in workspace filesystem MCP.
//
// Access is scoped to the directory where Sun2Agent started. It is kept
// separate from user-configured MCP servers so
// /mcp can connect and disconnect those servers independently.

const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const childProcess = require('child_process');
const registry = require('../mcp/registry');

const NAME = 'workspace';
let activeRoot = null;

const LOCAL_TOOLS = [
  {
    name: 'run_maven_tests',
    description:
      'Run mvn test in the connected workspace when pom.xml exists. This executes project code, ' +
      'requires fresh human approval, and has a 2-minute limit. Use after writing Java tests.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
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
  if (!activeRoot) throw new Error('workspace tools are not connected');
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
  if (name === 'run_maven_tests') return runMavenTests(args.signal);
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

async function runMavenTests(signal) {
  if (!activeRoot) throw new Error('workspace tools are not connected');
  const pom = path.join(activeRoot, 'pom.xml');
  let stat;
  try { stat = await fsp.lstat(pom); } catch (_) { return 'Maven tests NOT RUN: no pom.xml at the workspace root.'; }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return 'Maven tests NOT RUN: pom.xml must be a regular file at the workspace root.';
  }

  // Fixed command and cwd only: never execute model-supplied shell text.
  // Maven may execute project code, so the dispatch boundary requires fresh
  // approval and the child receives no model/API credentials from this process.
  const isWindows = process.platform === 'win32';
  const command = isWindows ? (process.env.ComSpec || 'cmd.exe') : 'mvn';
  const argv = isWindows ? ['/d', '/s', '/c', 'mvn test'] : ['test'];
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SYSTEMROOT',
      'JAVA_HOME', 'TMPDIR', 'TEMP', 'LANG', 'LC_ALL']
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]])
  );
  return new Promise((resolve, reject) => {
    childProcess.execFile(command, argv, {
      cwd: activeRoot, env, signal, timeout: 120000, maxBuffer: 4 * 1024 * 1024
    }, (error, stdout, stderr) => {
      if (signal?.aborted) return reject(new Error('Maven tests cancelled'));
      const output = `${stdout || ''}\n${stderr || ''}`.trim().slice(-20000);
      if (!error) return resolve(`Maven tests PASSED.\n${output}`);
      if (error.code === 'ENOENT') return resolve('Maven tests NOT RUN: Maven is not installed or not on PATH.');
      if (error.killed) return resolve(`Maven tests NOT VERIFIED: process timed out or output limit was reached.\n${output}`);
      return resolve(`Maven tests FAILED (exit ${error.code || 'unknown'}).\n${output}`);
    });
  });
}

async function verifyJavaTestWrite(tool, args = {}) {
  if (!activeRoot || typeof args.path !== 'string') return '';
  const filePath = args.path.replace(/\\/g, '/');
  if (!/(?:^|\/)src\/test\/.*\.java$/i.test(filePath)) return '';
  const target = path.resolve(activeRoot, args.path);
  if (!isInside(activeRoot, target)) throw new Error('Java test path is outside the workspace');
  const realTarget = await fsp.realpath(target);
  if (!isInside(activeRoot, realTarget)) throw new Error('Java test path resolves outside the workspace');
  const contents = await fsp.readFile(realTarget, 'utf8');
  if (tool === 'write_file' && contents !== args.content) {
    throw new Error('Java test read-back did not match the requested content');
  }
  return `Verified Java test on disk: ${path.relative(activeRoot, realTarget)}`;
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
  callLocalTool,
  verifyJavaTestWrite
};

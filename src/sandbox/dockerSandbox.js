// Docker sandbox command wrapping.
//
// When the Docker sandbox is enabled, the ENTIRE Sun2Agent application — the
// ReAct loop, guardrails, LLM calls, and the MCP client — runs inside an
// isolated container. The current project is mounted at /workspace; the
// agent's own config (API key, mcp.json) is mounted at /root/.sun2agent so
// it can function. No host credentials (~/.ssh, ~/.aws) are ever mounted.
//
// The container needs network access because the NVIDIA NIM API is remote —
// an agent that cannot call its model is useless. Filesystem isolation,
// resource limits, and process isolation are the security value here; the
// guardrails still run inside the container exactly as on the host.

const path = require('path');
const os = require('os');
const fs = require('fs');

// The base image for the sandbox. node:20-slim has node + npx built in and is
// widely available. Configurable via config.sandbox.image.
const DEFAULT_IMAGE = 'node:20-slim';

// Isolation defaults for the full-agent container. Network is left enabled
// (required for the LLM API and remote MCP servers); memory/CPU are capped so
// a runaway agent cannot exhaust the host.
const AGENT_DOCKER_ARGS = ['--rm', '--memory=2g', '--cpus=2'];

// Legacy isolation defaults used by wrapCommand() (single stdio MCP server
// wrap). Kept for compatibility; inside the full-agent sandbox, MCP servers
// already run isolated and are spawned as plain child processes.
const DEFAULT_DOCKER_ARGS = ['--rm', '-i', '--network=none', '--memory=1g', '--cpus=2'];

// Marker env var set inside the sandbox container. The inner sun2agent
// process sees it and knows it is already isolated — so it must NOT try to
// wrap itself in Docker again (no docker-in-docker, no infinite loop).
const SANDBOX_ENV = { SUN2AGENT_SANDBOX: '1' };

// Where the installed sun2agent package lives on the host, regardless of
// whether it was installed globally, via npm link, or run from a checkout.
function defaultPackageRoot() {
  // <package>/src/sandbox/dockerSandbox.js -> <package>
  return path.resolve(__dirname, '..', '..');
}

// Named Docker volume used as /workspace when the agent is launched from the
// user's HOME directory. A Docker-managed volume gives the container a real,
// writable, persistent workspace without bind-mounting any part of the host
// home directory. Docker creates the volume automatically on first use and
// it starts empty.
const WORKSPACE_VOLUME = 'sun2agent-workspace';

// Resolve to a real absolute path (symlinks followed, .. collapsed) so `~`,
// `/Users/name`, and symlinked aliases of the same directory compare equal.
function realPath(p) {
  try {
    return fs.realpathSync(path.resolve(p));
  } catch (_) {
    return path.resolve(p); // path may not exist yet — best-effort resolve
  }
}

// True when dir is the user's HOME directory itself (NOT a subdirectory).
// Subdirectories of HOME are ordinary project directories and bind-mount
// normally; only HOME exactly triggers the Docker-managed volume fallback.
function isHomeDirectory(dir) {
  return realPath(dir || process.cwd()) === realPath(os.homedir());
}

// Only the filesystem root itself is refused — mounting `/` as /workspace
// would expose the entire host (system files, other users' homes) to the
// container. HOME is allowed: it never bind-mounts (see wrapAgentRun), it
// gets the Docker-managed workspace volume instead.
function isUnsafeProjectRoot(dir) {
  return realPath(dir || process.cwd()) === '/';
}

// Build the `docker run` invocation that executes the WHOLE agent inside the
// sandbox container. The inner `node /app/bin/sun2agent.js` re-enters the
// launcher, sees SUN2AGENT_SANDBOX=1, and starts the chat directly.
//
// Workspace selection:
//   project directory  →  bind mount:  -v <projectRoot>:/workspace
//   HOME directory     →  named volume: -v sun2agent-workspace:/workspace
//
//   wrapAgentRun()
//   → { command: 'docker', args: ['run', '--rm', '--memory=2g', '--cpus=2',
//        '-it',
//        '-v', '<packageRoot>:/app',
//        '-v', '<projectRoot>:/workspace'  |  'sun2agent-workspace:/workspace',
//        '-v', '<configDir>:/root/.sun2agent',
//        '-w', '/workspace',
//        '-e', 'SUN2AGENT_SANDBOX=1',
//        'node:20-slim', 'node', '/app/bin/sun2agent.js'] }
//
function wrapAgentRun(options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const packageRoot = options.packageRoot || defaultPackageRoot();
  const configDir = options.configDir || path.join(os.homedir(), '.sun2agent');
  const image = options.image || DEFAULT_IMAGE;
  // -it gives the TUI a real terminal; fall back to -i when piped (CI).
  const tty = process.stdout.isTTY ? ['-it'] : ['-i'];

  // Launched from HOME? NEVER bind-mount it — that would hand the container
  // every personal file and trigger Docker Desktop's share-home prompt.
  // /workspace becomes the Docker-managed volume instead: isolated, writable,
  // starts empty. Subdirectories of HOME (normal projects) bind-mount as usual.
  const homeWorkspace = isHomeDirectory(projectRoot);
  const workspaceMount = homeWorkspace
    ? `${WORKSPACE_VOLUME}:/workspace`
    : `${projectRoot}:/workspace`;

  // resume=true is set when relaunching after Docker went down mid-session:
  // the inner agent restores the saved conversation so the user continues
  // from where they were interrupted.
  const envArgs = [`SUN2AGENT_SANDBOX=${SANDBOX_ENV.SUN2AGENT_SANDBOX}`];
  if (options.resume) envArgs.push('SUN2AGENT_RESUME=1');

  return {
    command: 'docker',
    args: [
      'run',
      ...AGENT_DOCKER_ARGS,
      ...tty,
      '-v', `${packageRoot}:/app`,
      '-v', workspaceMount,
      '-v', `${configDir}:/root/.sun2agent`,
      '-w', '/workspace',
      ...envArgs.flatMap((e) => ['-e', e]),
      image,
      'node', '/app/bin/sun2agent.js'
    ],
    env: { ...SANDBOX_ENV, ...(options.resume ? { SUN2AGENT_RESUME: '1' } : {}) }
  };
}

// Wrap a single stdio command so it runs inside a Docker container.
// (Legacy path for running an individual MCP server in isolation.)
function wrapCommand(command, args, options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const image = options.image || DEFAULT_IMAGE;
  const cmdArgs = Array.isArray(args) ? args : [];

  return {
    command: 'docker',
    args: [
      'run',
      ...DEFAULT_DOCKER_ARGS,
      '-v', `${projectRoot}:/workspace`,
      '-w', '/workspace',
      image,
      command,
      ...cmdArgs
    ]
  };
}

module.exports = {
  wrapAgentRun,
  wrapCommand,
  defaultPackageRoot,
  isUnsafeProjectRoot,
  isHomeDirectory,
  realPath,
  WORKSPACE_VOLUME,
  DEFAULT_IMAGE,
  AGENT_DOCKER_ARGS,
  DEFAULT_DOCKER_ARGS,
  SANDBOX_ENV
};

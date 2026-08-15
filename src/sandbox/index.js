// Single interface for the Docker sandbox feature.
//
// bin/sun2agent.js and src/mcp.js import only this module. When the sandbox
// is disabled (default), the agent runs on the host exactly as before. When
// enabled, the launcher re-executes the ENTIRE application inside a Docker
// container — the agent loop, guardrails, LLM calls, and MCP client all run
// isolated, with only the project (/workspace) and the agent's own config
// visible.
//
// This module is independent of guardrails, AGENT.md, observability, and the
// agent loop. Security enforcement still happens in guardrails/ before any
// execution — inside the container exactly as on the host.

const { loadConfig, saveConfig } = require('../config');
const { isDockerInstalled, isDockerRunning, pullImage, ensureImage } = require('./docker');
const { wrapCommand, wrapAgentRun, defaultPackageRoot, isUnsafeProjectRoot, DEFAULT_IMAGE } = require('./dockerSandbox');

// True when the current process is already running inside the sandbox
// container (the inner `node /app/bin/sun2agent.js` invocation).
function inSandbox() {
  return process.env.SUN2AGENT_SANDBOX === '1';
}

// Read whether the sandbox is enabled from the saved config.
function isSandboxEnabled() {
  const config = loadConfig();
  return Boolean(config.sandbox && config.sandbox.enabled && config.sandbox.mode === 'docker');
}

// Current sandbox mode: 'docker' or 'host'.
function getSandboxMode() {
  const config = loadConfig();
  return config.sandbox && config.sandbox.mode === 'docker' ? 'docker' : 'host';
}

// Wrap a stdio MCP server command for the sandbox. Inside the full-agent
// sandbox the process is already isolated, so this is a pure pass-through.
// On the host with the sandbox enabled, it wraps the single command in
// `docker run` (legacy per-server isolation path).
function wrapStdioCommand(command, args) {
  if (inSandbox()) return { command, args }; // already inside the container
  if (!isSandboxEnabled()) return { command, args };
  const config = loadConfig();
  return wrapCommand(command, args, {
    image: config.sandbox && config.sandbox.image
  });
}

// Launch the ENTIRE Sun2Agent application inside the Docker sandbox. Called
// by bin/sun2agent.js on the host when config has sandbox enabled. Checks
// Docker first and hard-fails (never silently falls back to host execution),
// then spawns the container with the project at /workspace and inherits the
// terminal so the TUI works.
//
// If Docker goes down WHILE the agent is running, the container dies. Rather
// than dropping the user into a cryptic error, the launcher:
//   1. tells the user to start their Docker engine,
//   2. waits (polling) until Docker is back,
//   3. relaunches the container with SUN2AGENT_RESUME=1 so the inner agent
//      restores the saved conversation and continues where it left off.
function runInSandbox() {
  const chalk = require('chalk');
  const { spawn } = require('child_process');

  // Only the filesystem root itself is refused — mounting `/` would expose the
  // entire host (system files, other users' homes) to the container. Launching
  // from HOME is fine: wrapAgentRun gives it the Docker-managed workspace
  // volume, so no part of the host home directory is ever bind-mounted.
  if (isUnsafeProjectRoot()) {
    console.log(chalk.red('\n✗ Refusing to sandbox the filesystem root as a project.'));
    console.log(chalk.gray('\nThat would expose the entire host to the container.'));
    console.log(chalk.gray('cd into any directory first, then run sun2agent again.\n'));
    process.exit(1);
  }

  if (!isDockerInstalled()) {
    console.log(chalk.red('\n✗ Docker sandbox is enabled, but Docker is not installed.'));
    console.log(chalk.gray('\nInstall Docker Desktop or Docker Engine, or disable the sandbox:'));
    console.log(chalk.gray('  sun2agent sandbox disable\n'));
    process.exit(1);
  }
  if (!isDockerRunning()) {
    console.log(chalk.red('\nDocker sandbox is enabled, but Docker is not running.'));
    console.log(chalk.gray('\nPlease start Docker Desktop/Engine and run sun2agent again,'));
    console.log(chalk.gray('or run the agent on your host instead:'));
    console.log(chalk.gray('  sun2agent sandbox disable\n'));
    process.exit(1);
  }

  const config = loadConfig();
  const image = (config.sandbox && config.sandbox.image) || DEFAULT_IMAGE;
  if (!ensureImage(image)) {
    console.log(chalk.red(`\n✗ Failed to prepare the sandbox image ${image}.`));
    console.log(chalk.gray('Check your Docker setup and try again.\n'));
    process.exit(1);
  }

  launchSandboxContainer({ image, resume: false, chalk });
}

// Spawn the sandbox container and wire up the exit handling that detects a
// mid-session Docker outage. `resume` is true when this is a relaunch after
// Docker came back — the inner agent then restores the saved session.
function launchSandboxContainer({ image, resume, chalk }) {
  const { spawn } = require('child_process');
  const { command, args } = wrapAgentRun({ image, resume });
  if (!resume) {
    console.log(chalk.green('🐳 Docker sandbox active — the agent runs isolated in a container.\n'));
  } else {
    console.log(chalk.green('🐳 Docker is back — resuming your session in the sandbox.\n'));
  }
  const child = spawn(command, args, { stdio: 'inherit' });

  child.on('error', (e) => {
    console.log(chalk.red('\n✗ Failed to start the Docker sandbox: ' + e.message + '\n'));
    process.exit(1);
  });

  child.on('exit', (code, signal) => {
    // User-initiated stop: /exit (code 0) or Ctrl+C (SIGINT / 130 flows
    // through -it). Never restart on those — the user meant to quit.
    if (code === 0 || signal === 'SIGINT' || code === 130) process.exit(code || 0);

    // Unexpected exit. If Docker itself is down, the outage killed the
    // container — wait for the engine and relaunch with session resume.
    if (!isDockerRunning()) {
      console.log(chalk.yellow('\n⚠ Docker engine stopped — the sandbox session was interrupted.'));
      console.log(chalk.gray('Please start your Docker engine. The agent is waiting and will'));
      console.log(chalk.gray('continue from where it stopped as soon as Docker is running again.\n'));
      waitForDockerAndResume({ image, chalk });
      return;
    }

    // Docker is fine — the agent itself exited nonzero. Propagate the code.
    process.exit(code || 0);
  });
}

// Poll Docker until the engine is back, then relaunch the sandbox with
// SUN2AGENT_RESUME=1 so the conversation continues where it stopped.
function waitForDockerAndResume({ image, chalk }) {
  const { spawnSync } = require('child_process');
  const POLL_MS = 2000;
  const timer = setInterval(() => {
    let running = false;
    try {
      running = spawnSync('docker', ['info'], { stdio: 'pipe' }).status === 0;
    } catch (_) {
      running = false;
    }
    if (!running) return; // keep waiting
    clearInterval(timer);
    console.log(chalk.green('✓ Docker engine detected — restarting the sandbox...'));
    launchSandboxContainer({ image, resume: true, chalk });
  }, POLL_MS);
}

// Enable the Docker sandbox. Checks Docker is installed + running, prepares
// the image, and saves the config. Prints progress and exits on failure.
function enableSandbox() {
  const chalk = require('chalk');

  if (!isDockerInstalled()) {
    console.log(chalk.red('\n✗ Docker is not installed.'));
    console.log(chalk.gray('\nInstall Docker Desktop or Docker Engine, then run:'));
    console.log(chalk.gray('  sun2agent sandbox enable\n'));
    process.exit(1);
  }
  console.log(chalk.green('✓ Docker detected'));

  if (!isDockerRunning()) {
    console.log(chalk.red('\n✗ Docker is installed but not running.'));
    console.log(chalk.gray('\nStart Docker Desktop or the Docker daemon, then run:'));
    console.log(chalk.gray('  sun2agent sandbox enable\n'));
    process.exit(1);
  }

  const config = loadConfig();
  const image = (config.sandbox && config.sandbox.image) || DEFAULT_IMAGE;
  if (!ensureImage(image)) {
    console.log(chalk.red(`\n✗ Failed to pull ${image}.`));
    console.log(chalk.gray('Check your Docker setup and try again.\n'));
    process.exit(1);
  }
  console.log(chalk.green('✓ Sandbox ready'));

  config.sandbox = { enabled: true, mode: 'docker', image };
  saveConfig(config);
  console.log(chalk.green('✓ Docker sandbox enabled\n'));

  console.log(
    chalk.gray('The full agent now runs inside an isolated container:\n') +
    chalk.gray('- Your project is mounted at /workspace (the only project visible).\n') +
    chalk.gray('- Host credentials (~/.ssh, ~/.aws) are never mounted.\n') +
    chalk.gray('- Network stays on: the NVIDIA NIM API is remote, so it is required.\n') +
    chalk.gray('- Disable anytime with: sun2agent sandbox disable\n')
  );
}

// Disable the sandbox — the agent runs directly on the host again.
function disableSandbox() {
  const chalk = require('chalk');
  const config = loadConfig();
  config.sandbox = { enabled: false, mode: 'host', image: DEFAULT_IMAGE };
  saveConfig(config);
  console.log(chalk.green('✓ Docker sandbox disabled — the agent runs on your host.\n'));
}

// Print the current sandbox status.
function printSandboxStatus() {
  const chalk = require('chalk');
  const config = loadConfig();
  const enabled = config.sandbox && config.sandbox.enabled;
  const mode = getSandboxMode();

  console.log('');
  console.log(chalk.bold('Sandbox: ') + (mode === 'docker' ? 'Docker' : 'Host'));
  console.log(chalk.bold('Status:  ') + (enabled ? chalk.green('Enabled') : chalk.gray('Disabled')));
  if (mode === 'docker') {
    console.log(chalk.bold('Docker:  ') + (isDockerRunning() ? chalk.green('Running') : chalk.red('Not running')));
    if (config.sandbox && config.sandbox.image) {
      console.log(chalk.bold('Image:   ') + chalk.gray(config.sandbox.image));
    }
  }
  console.log('');
}

module.exports = {
  // Detection (re-exported)
  isDockerInstalled,
  isDockerRunning,
  pullImage,
  // Interface
  inSandbox,
  isSandboxEnabled,
  getSandboxMode,
  wrapStdioCommand,
  runInSandbox,
  enableSandbox,
  disableSandbox,
  printSandboxStatus,
  defaultPackageRoot,
  DEFAULT_IMAGE
};

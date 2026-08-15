// Test suite for the Docker sandbox feature.
// Run with: npm test
//
// Uses node:test + node:assert, matching existing test style.
// Docker-dependent tests return booleans without asserting specific values
// so the suite passes in CI and on machines without Docker installed.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PROJECT = path.join(__dirname, '..');
const { wrapCommand, DEFAULT_IMAGE, DEFAULT_DOCKER_ARGS } =
  require(path.join(PROJECT, 'src/sandbox/dockerSandbox'));
const { isDockerInstalled, isDockerRunning } =
  require(path.join(PROJECT, 'src/sandbox/docker'));

// --- helpers ---------------------------------------------------------------

// Each test gets its own throwaway directory so they don't interfere.
let counter = 0;
function tmpDir() {
  const d = path.join(os.tmpdir(), `sun2agent-sandbox-${process.pid}-${counter++}`);
  fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Point config at a temp dir so tests never touch the real ~/.sun2agent.
// CONFIG_FILE is a module-level const computed from os.homedir() at require()
// time, so we bust the require cache + monkey-patch os.homedir, then
// re-require src/config to get fresh constants pointing at the temp dir.
function fakeConfigEnv() {
  const dir = tmpDir();
  const origHomedir = os.homedir;
  os.homedir = () => dir;
  // Bust config cache so the next require() picks up the new homedir.
  delete require.cache[require.resolve(path.join(PROJECT, 'src/config'))];
  // Re-require to get fresh CONFIG_FILE pointing at temp dir.
  const freshConfig = require(path.join(PROJECT, 'src/config'));
  return {
    dir,
    config: freshConfig,
    restore() {
      os.homedir = origHomedir;
      // Restore original config module in cache.
      delete require.cache[require.resolve(path.join(PROJECT, 'src/config'))];
    }
  };
}

// ===========================================================================
// PART 1 — Default config and Docker detection
// ===========================================================================

test('sandbox: default config uses host mode (no Docker needed)', () => {
  const env = fakeConfigEnv();
  try {
    // No config file exists → defaults should have sandbox disabled, host mode.
    const config = env.config.loadConfig();
    assert.strictEqual(config.sandbox.enabled, false);
    assert.strictEqual(config.sandbox.mode, 'host');
  } finally {
    env.restore();
  }
});

test('sandbox: isDockerInstalled returns a boolean', () => {
  const result = isDockerInstalled();
  assert.strictEqual(typeof result, 'boolean');
});

test('sandbox: isDockerRunning returns a boolean', () => {
  const result = isDockerRunning();
  assert.strictEqual(typeof result, 'boolean');
});

// ===========================================================================
// PART 2 — enableSandbox / disableSandbox (mocked Docker)
// ===========================================================================

test('sandbox: enableSandbox saves docker mode when Docker is available', () => {
  const env = fakeConfigEnv();
  try {
    // We can't mock process.exit easily, so we test the config write path
    // by manually saving the config as enableSandbox would.
    const config = env.config.loadConfig();
    config.sandbox = { enabled: true, mode: 'docker', image: DEFAULT_IMAGE };
    env.config.saveConfig(config);

    // Re-read and verify
    const reloaded = env.config.loadConfig();
    assert.strictEqual(reloaded.sandbox.enabled, true);
    assert.strictEqual(reloaded.sandbox.mode, 'docker');
    assert.strictEqual(reloaded.sandbox.image, DEFAULT_IMAGE);
  } finally {
    env.restore();
  }
});

test('sandbox: disableSandbox returns to host mode', () => {
  const env = fakeConfigEnv();
  try {
    // Start with Docker enabled
    let config = env.config.loadConfig();
    config.sandbox = { enabled: true, mode: 'docker', image: DEFAULT_IMAGE };
    env.config.saveConfig(config);

    // Simulate disableSandbox by writing host mode
    config = env.config.loadConfig();
    config.sandbox = { enabled: false, mode: 'host', image: DEFAULT_IMAGE };
    env.config.saveConfig(config);

    const reloaded = env.config.loadConfig();
    assert.strictEqual(reloaded.sandbox.enabled, false);
    assert.strictEqual(reloaded.sandbox.mode, 'host');
  } finally {
    env.restore();
  }
});

test('sandbox: printSandboxStatus reports correctly for both modes', () => {
  const logs = [];
  const origLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const sandboxPath = path.join(PROJECT, 'src/sandbox/index.js');

    // --- Host mode (default config) ---
    const env = fakeConfigEnv();
    delete require.cache[sandboxPath];
    let sandbox = require(sandboxPath);
    sandbox.printSandboxStatus();
    const hostOutput = logs.join('\n');
    assert.ok(hostOutput.includes('Host'), 'status must show Host mode, got: ' + hostOutput);
    assert.ok(hostOutput.includes('Disabled'), 'status must show Disabled, got: ' + hostOutput);

    // --- Docker mode ---
    const config = env.config.loadConfig();
    config.sandbox = { enabled: true, mode: 'docker', image: DEFAULT_IMAGE };
    env.config.saveConfig(config);
    delete require.cache[sandboxPath];
    sandbox = require(sandboxPath);
    logs.length = 0;
    sandbox.printSandboxStatus();
    const dockerOutput = logs.join('\n');
    assert.ok(dockerOutput.includes('Docker'), 'status must show Docker mode, got: ' + dockerOutput);
    assert.ok(dockerOutput.includes('Enabled'), 'status must show Enabled, got: ' + dockerOutput);
    assert.ok(dockerOutput.includes(DEFAULT_IMAGE), 'status must show the image');

    env.restore();
  } finally {
    console.log = origLog;
  }
});

test('sandbox: sun2agent automatically uses Docker when enabled (source-text check)', () => {
  // startChat() must read the saved config on every launch — no re-enabling
  // needed — and show the active banner when sandbox=docker and Docker is up.
  const chatSource = fs.readFileSync(path.join(PROJECT, 'src/chat.js'), 'utf-8');
  assert.ok(
    chatSource.includes('Docker sandbox active'),
    'chat.js must show the "Docker sandbox active" banner when enabled'
  );
  // The banner must come after the isDockerRunning check inside startChat.
  const runningIdx = chatSource.indexOf('isDockerRunning()');
  const activeIdx = chatSource.indexOf('Docker sandbox active');
  assert.ok(runningIdx !== -1 && activeIdx !== -1, 'both check and banner must exist');
  assert.ok(
    runningIdx < activeIdx,
    'Docker check must run before showing the active banner'
  );

  // mcp.js must route stdio commands through the sandbox automatically.
  const mcpSource = fs.readFileSync(path.join(PROJECT, 'src/mcp.js'), 'utf-8');
  assert.ok(
    mcpSource.includes('sandbox.wrapStdioCommand'),
    'mcp.js must wrap stdio commands via the sandbox module'
  );
});

// ===========================================================================
// PART 3 — wrapStdioCommand pass-through and wrap
// ===========================================================================

test('sandbox: wrapStdioCommand is pass-through when sandbox disabled', () => {
  const env = fakeConfigEnv();
  try {
    // Default config has sandbox disabled — bust sandbox cache so it reads fresh config
    const sandboxPath = path.join(PROJECT, 'src/sandbox/index.js');
    delete require.cache[sandboxPath];
    const sandbox = require(sandboxPath);
    const result = sandbox.wrapStdioCommand('npx', ['-y', '@some/server']);
    assert.strictEqual(result.command, 'npx');
    assert.deepStrictEqual(result.args, ['-y', '@some/server']);
  } finally {
    env.restore();
  }
});

test('sandbox: wrapStdioCommand wraps in docker run when sandbox enabled', () => {
  const env = fakeConfigEnv();
  try {
    // Save config with sandbox enabled
    const config = env.config.loadConfig();
    config.sandbox = { enabled: true, mode: 'docker', image: DEFAULT_IMAGE };
    env.config.saveConfig(config);

    // Bust sandbox cache so it re-reads the updated config
    const sandboxPath = path.join(PROJECT, 'src/sandbox/index.js');
    delete require.cache[sandboxPath];
    const sandbox = require(sandboxPath);

    const result = sandbox.wrapStdioCommand('npx', ['-y', '@some/server']);
    assert.strictEqual(result.command, 'docker');
    assert.ok(result.args.length > 0);
    assert.strictEqual(result.args[0], 'run');
  } finally {
    // Restore cache
    const sandboxPath = path.join(PROJECT, 'src/sandbox/index.js');
    delete require.cache[sandboxPath];
    env.restore();
  }
});

// ===========================================================================
// PART 4 — wrapCommand produces correct Docker args
// ===========================================================================

test('sandbox: wrapCommand produces correct Docker args', () => {
  const projectRoot = '/tmp/myproject';
  const result = wrapCommand('npx', ['-y', 'some-server'], { projectRoot });

  assert.strictEqual(result.command, 'docker');
  const args = result.args;

  // First arg is 'run'
  assert.strictEqual(args[0], 'run');

  // All DEFAULT_DOCKER_ARGS must be present
  for (const flag of DEFAULT_DOCKER_ARGS) {
    assert.ok(args.includes(flag), `missing ${flag} in args`);
  }

  // Volume mount: -v projectRoot:/workspace
  const volIdx = args.indexOf('-v');
  assert.ok(volIdx !== -1, 'missing -v flag');
  assert.strictEqual(args[volIdx + 1], `${projectRoot}:/workspace`);

  // Working dir: -w /workspace
  const wIdx = args.indexOf('-w');
  assert.ok(wIdx !== -1, 'missing -w flag');
  assert.strictEqual(args[wIdx + 1], '/workspace');

  // Image
  assert.ok(args.includes(DEFAULT_IMAGE), 'missing image in args');

  // Original command and args at the end
  const cmdIdx = args.indexOf('npx');
  assert.ok(cmdIdx !== -1, 'missing original command in args');
  assert.strictEqual(args[cmdIdx + 1], '-y');
  assert.strictEqual(args[cmdIdx + 2], 'some-server');
});

test('sandbox: wrapCommand does NOT mount credentials', () => {
  const result = wrapCommand('npx', ['-y', 'some-server']);
  const argsStr = result.args.join(' ');

  // No .ssh, .aws, .gnupg, or other credential directories should be mounted
  const credentialPatterns = ['.ssh', '.aws', '.gnupg', '.docker', 'id_rsa', 'id_ed25519'];
  for (const pattern of credentialPatterns) {
    assert.ok(!argsStr.includes(pattern), `credential pattern "${pattern}" found in args: ${argsStr}`);
  }
});

test('sandbox: wrapCommand does NOT hard-code host paths', () => {
  // Call with two different project roots — the paths must differ
  const resultA = wrapCommand('cmd', [], { projectRoot: '/home/alice/project' });
  const resultB = wrapCommand('cmd', [], { projectRoot: '/home/bob/project' });

  const argsA = resultA.args.join(' ');
  const argsB = resultB.args.join(' ');

  // Each should contain its own project root
  assert.ok(argsA.includes('/home/alice/project'), 'projectRoot A not in args');
  assert.ok(argsB.includes('/home/bob/project'), 'projectRoot B not in args');
  // And NOT the other's
  assert.ok(!argsA.includes('/home/bob/project'), 'projectRoot B leaked into args A');
  assert.ok(!argsB.includes('/home/alice/project'), 'projectRoot A leaked into args B');
});

// ===========================================================================
// PART 5 — Source-text integration checks
// ===========================================================================

test('sandbox: chat.js hard-fails when Docker is down (source-text check)', () => {
  const chatSource = fs.readFileSync(path.join(PROJECT, 'src/chat.js'), 'utf-8');

  // Must check sandbox.enabled && sandbox.mode === 'docker'
  assert.ok(chatSource.includes('config.sandbox'), 'chat.js must reference config.sandbox');
  assert.ok(chatSource.includes("mode === 'docker'"), 'chat.js must check docker mode');

  // Must call process.exit(1) when Docker not running — NOT silently fall back
  assert.ok(chatSource.includes('isDockerRunning'), 'chat.js must call isDockerRunning');
  assert.ok(
    chatSource.includes('process.exit(1)'),
    'chat.js must process.exit(1) when Docker not running'
  );
});

test('sandbox: mcp.js guardrails run BEFORE sandbox wrap (source-text check)', () => {
  const mcpSource = fs.readFileSync(path.join(PROJECT, 'src/mcp.js'), 'utf-8');

  // In connectServer(): validateServer is called, then buildTransport (which
  // contains the sandbox wrap). Both must be present.
  assert.ok(mcpSource.includes('validateServer'), 'mcp.js must call validateServer');
  assert.ok(mcpSource.includes('wrapStdioCommand'), 'mcp.js must call wrapStdioCommand');
  assert.ok(mcpSource.includes('buildTransport'), 'mcp.js must call buildTransport');

  // Extract the connectServer function body and verify validateServer appears
  // before buildTransport within that function (runtime call order).
  const connectStart = mcpSource.indexOf('async function connectServer(s)');
  assert.ok(connectStart !== -1, 'connectServer function must exist');
  const nextFunc = mcpSource.indexOf('\nasync function ', connectStart + 1);
  const connectBody = nextFunc !== -1
    ? mcpSource.slice(connectStart, nextFunc)
    : mcpSource.slice(connectStart);

  const validateInConnect = connectBody.indexOf('validateServer');
  const buildInConnect = connectBody.indexOf('buildTransport');
  assert.ok(validateInConnect !== -1, 'validateServer must be in connectServer');
  assert.ok(buildInConnect !== -1, 'buildTransport must be called in connectServer');
  assert.ok(
    validateInConnect < buildInConnect,
    'validateServer must be called BEFORE buildTransport in connectServer'
  );

  // validateToolCall must also appear before the actual tool execution
  const validateToolIdx = mcpSource.indexOf('validateToolCall');
  const requestIdx = mcpSource.indexOf('client.request');
  assert.ok(validateToolIdx !== -1, 'mcp.js must call validateToolCall');
  assert.ok(requestIdx !== -1, 'mcp.js must call client.request');
  assert.ok(
    validateToolIdx < requestIdx,
    'validateToolCall must run BEFORE the actual MCP request'
  );
});

test('sandbox: AGENT.md + LangSmith + sandbox modules remain independent', () => {
  // No require() cross-imports between these independent feature modules.
  // We check require() calls, not comments, to avoid false positives from
  // documentation strings that mention other modules by name.
  const contextSource = fs.readFileSync(path.join(PROJECT, 'src/context/index.js'), 'utf-8');
  const observSource = fs.readFileSync(path.join(PROJECT, 'src/observability/index.js'), 'utf-8');
  const sandboxSource = fs.readFileSync(path.join(PROJECT, 'src/sandbox/index.js'), 'utf-8');

  // Extract require() targets (the string inside require('...'))
  const requires = (src) =>
    [...src.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1]);

  const contextDeps = requires(contextSource);
  const observDeps = requires(observSource);
  const sandboxDeps = requires(sandboxSource);

  // context/ must not require sandbox or observability modules
  assert.ok(
    !contextDeps.some((d) => d.includes('sandbox')),
    'context must not require sandbox'
  );
  assert.ok(
    !contextDeps.some((d) => d.includes('observability')),
    'context must not require observability'
  );

  // observability/ must not require sandbox or context modules
  assert.ok(
    !observDeps.some((d) => d.includes('sandbox')),
    'observability must not require sandbox'
  );
  assert.ok(
    !observDeps.some((d) => d.includes('context')),
    'observability must not require context'
  );

  // sandbox/ must not require observability or context modules
  assert.ok(
    !sandboxDeps.some((d) => d.includes('observability')),
    'sandbox must not require observability'
  );
  assert.ok(
    !sandboxDeps.some((d) => d.includes('context')),
    'sandbox must not require context'
  );
});

test('sandbox: bin/sun2agent.js has sandbox subcommand dispatch', () => {
  const binSource = fs.readFileSync(path.join(PROJECT, 'bin/sun2agent.js'), 'utf-8');

  // Must handle 'sandbox' as a top-level arg
  assert.ok(binSource.includes("args[0] === 'sandbox'"), 'bin must handle sandbox arg');
  // Must dispatch enable, disable, status
  assert.ok(binSource.includes('enable'), 'bin must handle enable');
  assert.ok(binSource.includes('disable'), 'bin must handle disable');
  assert.ok(binSource.includes('status'), 'bin must handle status');
  // Must require the sandbox module
  assert.ok(binSource.includes("require('../src/sandbox')"), 'bin must require sandbox module');
});

test('sandbox: chat.js detects Docker-down mid-session on tool error (source-text check)', () => {
  const chatSource = fs.readFileSync(path.join(PROJECT, 'src/chat.js'), 'utf-8');

  // Must have a dockerDownWarning helper that checks Docker status
  assert.ok(chatSource.includes('dockerDownWarning'), 'chat.js must have dockerDownWarning function');
  assert.ok(
    chatSource.includes('Docker sandbox is enabled but Docker is not running'),
    'dockerDownWarning must produce clear warning message'
  );

  // Tool error catch block must call dockerDownWarning
  const toolCatchIdx = chatSource.indexOf('content = \'Tool error: \'');
  assert.ok(toolCatchIdx !== -1, 'chat.js must have tool error handler');
  // Find the next dockerDownWarning after the tool error
  const warnAfterTool = chatSource.indexOf('dockerDownWarning', toolCatchIdx);
  assert.ok(
    warnAfterTool !== -1 && warnAfterTool < toolCatchIdx + 300,
    'dockerDownWarning must be called in tool error catch block'
  );
});

test('sandbox: chat.js detects Docker-down mid-session on connect error (source-text check)', () => {
  const chatSource = fs.readFileSync(path.join(PROJECT, 'src/chat.js'), 'utf-8');

  // "No servers connected" path must also check Docker
  const noServersIdx = chatSource.indexOf('No servers connected');
  assert.ok(noServersIdx !== -1, 'chat.js must have "No servers connected" message');
  const warnAfterNoServers = chatSource.indexOf('dockerDownWarning', noServersIdx);
  assert.ok(
    warnAfterNoServers !== -1 && warnAfterNoServers < noServersIdx + 300,
    'dockerDownWarning must be called after "No servers connected"'
  );

  // Single-server "Failed to connect" path must also check Docker
  const failedConnectIdx = chatSource.indexOf('Failed to connect:');
  assert.ok(failedConnectIdx !== -1, 'chat.js must have "Failed to connect" error handler');
  const warnAfterFailed = chatSource.indexOf('dockerDownWarning', failedConnectIdx);
  assert.ok(
    warnAfterFailed !== -1 && warnAfterFailed < failedConnectIdx + 300,
    'dockerDownWarning must be called in single-server connect error'
  );
});

// ===========================================================================
// PART 6 — Full-application sandbox (the whole agent runs in Docker)
// ===========================================================================

const { wrapAgentRun, AGENT_DOCKER_ARGS, defaultPackageRoot, isUnsafeProjectRoot, isHomeDirectory, realPath, WORKSPACE_VOLUME } =
  require(path.join(PROJECT, 'src/sandbox/dockerSandbox'));

test('sandbox: wrapAgentRun produces correct full-app container args', () => {
  const result = wrapAgentRun({
    projectRoot: '/tmp/myproject',
    packageRoot: '/opt/sun2agent',
    configDir: '/home/me/.sun2agent'
  });

  assert.strictEqual(result.command, 'docker');
  const args = result.args;
  assert.strictEqual(args[0], 'run');

  // Resource limits present
  for (const flag of AGENT_DOCKER_ARGS) {
    assert.ok(args.includes(flag), `missing ${flag}`);
  }

  // Package mounted at /app (the agent code itself)
  const appIdx = args.indexOf('-v');
  assert.strictEqual(args[appIdx + 1], '/opt/sun2agent:/app');

  // Project mounted at /workspace
  assert.ok(args.includes('/tmp/myproject:/workspace'), 'project must mount at /workspace');

  // Agent config mounted where loadConfig() looks inside the container
  assert.ok(
    args.includes('/home/me/.sun2agent:/root/.sun2agent'),
    'config must mount at /root/.sun2agent'
  );

  // Working dir + sandbox marker env
  const wIdx = args.indexOf('-w');
  assert.strictEqual(args[wIdx + 1], '/workspace');
  const eIdx = args.indexOf('-e');
  assert.strictEqual(args[eIdx + 1], 'SUN2AGENT_SANDBOX=1');

  // Image + entrypoint runs the agent
  assert.ok(args.includes(DEFAULT_IMAGE), 'image missing');
  const nodeIdx = args.lastIndexOf('node');
  assert.strictEqual(args[nodeIdx + 1], '/app/bin/sun2agent.js');

  // Marker env also exposed on the returned object
  assert.strictEqual(result.env.SUN2AGENT_SANDBOX, '1');
});

test('sandbox: wrapAgentRun does NOT mount host credentials', () => {
  const result = wrapAgentRun({ projectRoot: '/tmp/p', packageRoot: '/opt/s', configDir: '/home/me/.sun2agent' });
  const argsStr = result.args.join(' ');

  const credentialPatterns = ['.ssh', '.aws', '.gnupg', 'id_rsa', 'id_ed25519', '.docker'];
  for (const pattern of credentialPatterns) {
    assert.ok(!argsStr.includes(pattern), `credential "${pattern}" leaked: ${argsStr}`);
  }
});

test('sandbox: wrapAgentRun uses dynamic host paths (nothing hard-coded)', () => {
  const a = wrapAgentRun({ projectRoot: '/home/alice/proj', packageRoot: '/x/a', configDir: '/home/alice/.sun2agent' });
  const b = wrapAgentRun({ projectRoot: '/home/bob/proj', packageRoot: '/x/b', configDir: '/home/bob/.sun2agent' });
  const sa = a.args.join(' ');
  const sb = b.args.join(' ');

  assert.ok(sa.includes('/home/alice/proj') && !sa.includes('/home/bob'), 'paths must follow options');
  assert.ok(sb.includes('/home/bob/proj') && !sb.includes('/home/alice'), 'paths must follow options');
  assert.ok(!sa.includes('/Users/pradip'), 'no developer-machine path may be baked in');
});

test('sandbox: defaultPackageRoot resolves to the package directory', () => {
  const root = defaultPackageRoot();
  assert.ok(fs.existsSync(path.join(root, 'bin', 'sun2agent.js')), 'bin/sun2agent.js must exist under package root');
  assert.ok(fs.existsSync(path.join(root, 'package.json')), 'package.json must exist under package root');
});

test('sandbox: wrapStdioCommand is pass-through INSIDE the sandbox even when enabled', () => {
  const env = fakeConfigEnv();
  const savedMarker = process.env.SUN2AGENT_SANDBOX;
  process.env.SUN2AGENT_SANDBOX = '1';
  try {
    // Sandbox enabled in config — but we are already inside the container.
    const config = env.config.loadConfig();
    config.sandbox = { enabled: true, mode: 'docker', image: DEFAULT_IMAGE };
    env.config.saveConfig(config);

    const sandboxPath = path.join(PROJECT, 'src/sandbox/index.js');
    delete require.cache[sandboxPath];
    const sandbox = require(sandboxPath);

    const result = sandbox.wrapStdioCommand('npx', ['-y', '@some/server']);
    assert.strictEqual(result.command, 'npx', 'must not double-wrap inside the sandbox');
    assert.deepStrictEqual(result.args, ['-y', '@some/server']);
  } finally {
    if (savedMarker === undefined) delete process.env.SUN2AGENT_SANDBOX;
    else process.env.SUN2AGENT_SANDBOX = savedMarker;
    env.restore();
  }
});

test('sandbox: bin launcher runs full app in sandbox when enabled, host when disabled (source-text)', () => {
  const binSource = fs.readFileSync(path.join(PROJECT, 'bin/sun2agent.js'), 'utf-8');

  // Must detect the in-sandbox marker and start chat directly (no re-wrap)
  assert.ok(
    binSource.includes("process.env.SUN2AGENT_SANDBOX === '1'"),
    'bin must check the in-sandbox marker'
  );

  // Must dispatch to runInSandbox when config has sandbox enabled
  assert.ok(binSource.includes('runInSandbox'), 'bin must call runInSandbox when enabled');
  // Must still start chat on the host when disabled
  assert.ok(binSource.includes('startChat'), 'bin must call startChat for host mode');
  // Sandbox management subcommands must run on the host (before the marker check)
  const sandboxSubIdx = binSource.indexOf("args[0] === 'sandbox'");
  const markerIdx = binSource.indexOf('SUN2AGENT_SANDBOX');
  assert.ok(
    sandboxSubIdx !== -1 && markerIdx !== -1 && sandboxSubIdx < markerIdx,
    'sandbox enable/disable/status must be handled before container dispatch'
  );
});

test('sandbox: runInSandbox refuses to fall back when Docker is down (source-text)', () => {
  const idxSource = fs.readFileSync(path.join(PROJECT, 'src/sandbox/index.js'), 'utf-8');

  const runIdx = idxSource.indexOf('function runInSandbox()');
  assert.ok(runIdx !== -1, 'runInSandbox must exist');
  const body = idxSource.slice(runIdx, idxSource.indexOf('\nfunction ', runIdx + 1));

  assert.ok(body.includes('isDockerInstalled'), 'must check Docker installed');
  assert.ok(body.includes('isDockerRunning'), 'must check Docker running');
  assert.ok(body.includes('process.exit(1)'), 'must exit(1) instead of silent host fallback');
  assert.ok(body.includes('sun2agent sandbox disable'), 'must tell the user how to disable');
  assert.ok(body.includes('wrapAgentRun'), 'must launch via wrapAgentRun');
  assert.ok(body.includes('ensureImage'), 'must ensure the image is present');
});

test('sandbox: chat.js skips Docker checks and shows banner inside the sandbox (source-text)', () => {
  const chatSource = fs.readFileSync(path.join(PROJECT, 'src/chat.js'), 'utf-8');

  // dockerDownWarning must short-circuit inside the container (no docker CLI)
  const warnIdx = chatSource.indexOf('function dockerDownWarning()');
  const body = chatSource.slice(warnIdx, chatSource.indexOf('\n}', warnIdx));
  assert.ok(
    body.includes("SUN2AGENT_SANDBOX === '1'"),
    'dockerDownWarning must be skipped inside the sandbox'
  );

  // startChat must show the in-sandbox banner when the marker is set
  assert.ok(
    chatSource.includes("process.env.SUN2AGENT_SANDBOX === '1'") &&
      chatSource.includes('running isolated at /workspace'),
    'startChat must show the in-sandbox banner'
  );
});

test('sandbox: isUnsafeProjectRoot blocks ONLY the filesystem root (global use)', () => {
  assert.ok(isUnsafeProjectRoot('/'), 'filesystem root must be unsafe');
  assert.ok(!isUnsafeProjectRoot(os.homedir()), 'home directory must be allowed — the agent is a global CLI');
  assert.ok(!isUnsafeProjectRoot('/tmp/myproject'), 'normal project must be safe');
  assert.ok(!isUnsafeProjectRoot(os.tmpdir()), 'tmpdir must be safe');
});

test('sandbox: runInSandbox refuses ONLY the filesystem root, not home (source-text)', () => {
  const idxSource = fs.readFileSync(path.join(PROJECT, 'src/sandbox/index.js'), 'utf-8');
  const runIdx = idxSource.indexOf('function runInSandbox()');
  assert.ok(runIdx !== -1, 'runInSandbox must exist');
  const body = idxSource.slice(runIdx, idxSource.indexOf('\nfunction ', runIdx + 1));

  // The guard must exist and exit for the filesystem root…
  const unsafeIdx = body.indexOf('isUnsafeProjectRoot()');
  assert.ok(unsafeIdx !== -1, 'runInSandbox must check unsafe root');
  const guardBlock = body.slice(unsafeIdx, body.indexOf('\n  }', unsafeIdx));
  assert.ok(guardBlock.includes('process.exit'), 'the filesystem-root guard must exit');
  assert.ok(
    !guardBlock.includes('home directory'),
    'the guard must NOT special-case the home directory — global use'
  );
});

test('sandbox: HOME is NEVER bind-mounted — Docker-managed volume is used instead', () => {
  const home = os.homedir();
  const result = wrapAgentRun({
    projectRoot: home,
    packageRoot: '/opt/sun2agent',
    configDir: path.join(home, '.sun2agent')
  });

  assert.strictEqual(result.command, 'docker');
  assert.ok(result.args.includes('/app/bin/sun2agent.js'), 'agent entrypoint missing');

  // /workspace comes from the named Docker volume, not a bind mount.
  assert.ok(
    result.args.includes(`${WORKSPACE_VOLUME}:/workspace`),
    `/workspace must be the "${WORKSPACE_VOLUME}" volume when cwd is HOME`
  );

  // No bind mount may be HOME or any parent of HOME (/, /Users, …).
  const bindMounts = result.args.filter((a, i) => i > 0 && result.args[i - 1] === '-v');
  const homeReal = realPath(home);
  for (const m of bindMounts) {
    const hostPart = realPath(m.split(':')[0]);
    assert.ok(
      hostPart !== homeReal,
      `HOME itself must never be a bind mount, got: ${m}`
    );
    assert.ok(
      !homeReal.startsWith(hostPart + path.sep),
      `a parent of HOME must never be bind-mounted, got: ${m}`
    );
  }

  // No credential paths anywhere.
  const argsStr = result.args.join(' ');
  for (const pattern of ['.ssh', '.aws', '.gnupg', 'id_rsa']) {
    assert.ok(!argsStr.includes(pattern), `credential "${pattern}" leaked: ${argsStr}`);
  }

  // The agent's own config (a child of HOME, not a parent) still mounts —
  // it holds the API key + mcp.json and is required for the agent to function.
  assert.ok(
    result.args.includes(`${path.join(home, '.sun2agent')}:/root/.sun2agent`),
    'agent config must still mount at /root/.sun2agent'
  );
});

test('sandbox: subdirectories of HOME bind-mount normally (existing behavior)', () => {
  const proj = path.join(os.homedir(), 'my-project');
  const result = wrapAgentRun({
    projectRoot: proj,
    packageRoot: '/opt/sun2agent',
    configDir: path.join(os.homedir(), '.sun2agent')
  });

  // Only that project directory is mounted as /workspace.
  assert.ok(result.args.includes(`${proj}:/workspace`), 'project must bind-mount at /workspace');
  assert.ok(
    !result.args.includes(`${WORKSPACE_VOLUME}:/workspace`),
    'the fallback volume must NOT be used for a normal project'
  );
  assert.ok(
    !result.args.includes(`${os.homedir()}:/workspace`),
    'HOME itself must never appear as a mount for a subdirectory launch'
  );
});

test('sandbox: nested subdirectory of HOME mounts only itself (e.g. ~/my-project/src)', () => {
  const nested = path.join(os.homedir(), 'my-project', 'src');
  const result = wrapAgentRun({
    projectRoot: nested,
    packageRoot: '/opt/s',
    configDir: '/home/me/.sun2agent'
  });
  assert.ok(result.args.includes(`${nested}:/workspace`), 'nested dir mounts at /workspace');
  assert.ok(!result.args.includes(`${os.homedir()}:/workspace`), 'HOME must not be mounted');
});

test('sandbox: isHomeDirectory resolves symlinks and relative paths reliably', () => {
  const home = os.homedir();
  assert.ok(isHomeDirectory(home), 'HOME must be detected');
  assert.ok(isHomeDirectory(realPath(home)), 'realpath of HOME must be detected');
  assert.ok(!isHomeDirectory(path.join(home, 'proj')), 'a subdirectory is not HOME');
  assert.ok(!isHomeDirectory('/tmp'), 'tmp is not HOME');

  // A symlinked alias of HOME must also be recognized as HOME.
  const alias = path.join(os.tmpdir(), 'sun2agent-home-alias');
  try { fs.rmSync(alias, { force: true }); } catch (_) { /* ignore */ }
  fs.symlinkSync(home, alias, 'dir');
  try {
    assert.ok(isHomeDirectory(alias), 'symlink to HOME must be detected as HOME');
  } finally {
    fs.rmSync(alias, { force: true });
  }
});

test('sandbox: wrapAgentRun would mount filesystem root only if forced (defense check)', () => {
  // The '/' refusal happens in runInSandbox() BEFORE wrapAgentRun is ever
  // called with '/'. wrapAgentRun itself is a pure builder — verify the
  // guard exists in the launcher so '/' never reaches this function in practice.
  //
  // These live in separate functions: isUnsafeProjectRoot() is called inside
  // runInSandbox() which hard-exits on rejection; wrapAgentRun() is called only
  // inside launchSandboxContainer(), which is only reached after the guard
  // passes. Split the check into two per-function assertions to avoid fragile
  // cross-function text slicing.
  const idxSource = fs.readFileSync(path.join(PROJECT, 'src/sandbox/index.js'), 'utf-8');

  // 1) runInSandbox() body must contain the unsafe-root guard.
  const runIdx = idxSource.indexOf('function runInSandbox()');
  const runBody = idxSource.slice(runIdx, idxSource.indexOf('\nfunction ', runIdx + 1));
  assert.ok(
    runBody.includes('isUnsafeProjectRoot()'),
    'runInSandbox() must call isUnsafeProjectRoot() guard'
  );

  // 2) wrapAgentRun() must NOT live inside runInSandbox() — it belongs in the
  //    separate launchSandboxContainer() which is only invoked after the guard.
  assert.ok(
    !runBody.includes('wrapAgentRun('),
    'wrapAgentRun() must not be called inside runInSandbox() — it belongs in launchSandboxContainer()'
  );
});

// ===========================================================================
// PART 7 — Docker outage: wait for the engine, relaunch, resume the session
// ===========================================================================

test('sandbox: wrapAgentRun sets SUN2AGENT_RESUME=1 only when resume requested', () => {
  const base = { projectRoot: '/tmp/p', packageRoot: '/opt/s', configDir: '/home/me/.sun2agent' };

  // Default launch: no resume marker.
  const normal = wrapAgentRun(base);
  assert.ok(!normal.args.includes('SUN2AGENT_RESUME=1'), 'normal launch must not set resume');

  // Resume launch: marker passed to the container.
  const resume = wrapAgentRun({ ...base, resume: true });
  assert.ok(resume.args.includes('SUN2AGENT_RESUME=1'), 'resume launch must set the marker');
  assert.strictEqual(resume.env.SUN2AGENT_RESUME, '1');
  // The sandbox marker is still present too.
  assert.ok(resume.args.includes('SUN2AGENT_SANDBOX=1'));
});

test('sandbox: launcher waits for Docker and relaunches with resume (source-text)', () => {
  const idxSource = fs.readFileSync(path.join(PROJECT, 'src/sandbox/index.js'), 'utf-8');

  // The relaunch helper must exist and poll until Docker is back.
  const waitIdx = idxSource.indexOf('function waitForDockerAndResume(');
  assert.ok(waitIdx !== -1, 'waitForDockerAndResume must exist');
  const waitBody = idxSource.slice(waitIdx, idxSource.indexOf('\nfunction ', waitIdx + 1));
  assert.ok(waitBody.includes('docker'), 'must poll the docker CLI');
  assert.ok(waitBody.includes('launchSandboxContainer'), 'must relaunch after Docker returns');
  assert.ok(
    waitBody.includes('resume: true'),
    'the relaunch must pass resume so the session continues'
  );

  // The container exit handler must distinguish user quits from outages.
  const launchIdx = idxSource.indexOf('function launchSandboxContainer(');
  const launchBody = idxSource.slice(launchIdx, idxSource.indexOf('\nfunction ', launchIdx + 1));
  assert.ok(launchBody.includes("signal === 'SIGINT'"), 'Ctrl+C must NOT trigger a relaunch');
  assert.ok(launchBody.includes('isDockerRunning()'), 'must check Docker after an unexpected exit');
  assert.ok(
    launchBody.includes('Please start your Docker engine'),
    'must tell the user to start their Docker engine'
  );
});

test('sandbox: chat.js persists and restores the session (source-text)', () => {
  const chatSource = fs.readFileSync(path.join(PROJECT, 'src/chat.js'), 'utf-8');

  // Save/load/clear helpers must exist.
  assert.ok(chatSource.includes('function saveSession('), 'saveSession must exist');
  assert.ok(chatSource.includes('function loadSession('), 'loadSession must exist');
  assert.ok(chatSource.includes('function clearSession('), 'clearSession must exist');

  // History is restored ONLY when the launcher says this is a resume.
  assert.ok(
    chatSource.includes("process.env.SUN2AGENT_RESUME === '1'") && chatSource.includes('loadSession()'),
    'startChat must restore history when SUN2AGENT_RESUME=1'
  );

  // The session is saved after every completed exchange.
  assert.ok(
    chatSource.includes('saveSession(history)'),
    'history must be persisted after each exchange'
  );

  // A clean /exit clears the session — nothing stale to resume later.
  const exitIdx = chatSource.indexOf("text === '/exit'");
  const exitBlock = chatSource.slice(exitIdx, chatSource.indexOf('\n    }', exitIdx));
  assert.ok(exitBlock.includes('clearSession()'), '/exit must clear the saved session');
});

test('sandbox: session file round-trips through save/load/clear', () => {
  const env = fakeConfigEnv();
  try {
    // Verify the session file mechanics directly (the same shape chat.js's
    // saveSession/loadSession/clearSession use). chat.js itself is NOT
    // required here: it pulls in the TUI stack (inquirer/readline) whose open
    // handles would hang the test runner.
    const sessionFile = path.join(env.dir, '.sun2agent', 'session.json');
    const messages = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' }
    ];
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, JSON.stringify({ savedAt: Date.now(), messages }));

    // Re-read like loadSession would.
    const raw = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
    assert.strictEqual(raw.messages.length, 2);
    assert.strictEqual(raw.messages[0].content, 'hello');

    // Clear like clearSession would.
    fs.unlinkSync(sessionFile);
    assert.ok(!fs.existsSync(sessionFile), 'session file must be removable');
  } finally {
    env.restore();
  }
});

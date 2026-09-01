// First-run smoke test: the headline "can a real user perform the basic flow
// without the application exploding?" check.
//
//   Fresh install
//       ↓
//   Run CLI
//       ↓
//   No API key → /config prompt walks the user through setup
//       ↓
//   Config saved
//       ↓
//   REPL ready
//       ↓
//   /exit
//
// We exercise this end-to-end by spawning bin/sun2agent.js as a real child
// process with a fresh $HOME, piped stdin, and scripted keystrokes. Anything
// less realistic (mocking startChat, stubbing the prompt) would let through
// exactly the class of bug this test exists to catch — a missing import, a
// reference to a function that doesn't exist in the boot path, a banner
// that never prints, a config file that never lands.
//
// Run with: npm test

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const PROJECT = path.join(__dirname, '..');
const BIN = path.join(PROJECT, 'bin', 'sun2agent.js');
const CONFIG_PATH_PARTS = ['.sun2agent', 'config.json'];

// --- helpers ---------------------------------------------------------------

// Each test gets its own throwaway HOME so config files don't collide.
let counter = 0;
function freshHome() {
  const dir = path.join(os.tmpdir(), `sun2agent-boot-${process.pid}-${counter++}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Each CLI boot is a heavyweight child process (inquirer, banner, readline)
// that holds the event loop for ~1.5s. Running 5 of them in parallel under
// `npm test` (default concurrency = CPU count) blows past the 8s timeout on
// slower boxes. We serialize at the test level: a shared promise chain means
// tests run one at a time, in declaration order, regardless of how `node --test`
// schedules them.
let chain = Promise.resolve();
function serial(fn) {
  const next = chain.then(fn, fn);
  chain = next.catch(() => {}); // swallow so a failure doesn't poison the chain
  return next;
}

// Spawn the real CLI with a script of typed inputs. Resolves when the process
// exits, the timeout fires, or the process writes a fatal-looking line to
// stderr (we don't want to wait 8s just to find out it already crashed).
function spawnCli({ home, inputs, timeoutMs = 20000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN], {
      env: { ...process.env, HOME: home, PATH: process.env.PATH },
      cwd: PROJECT,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
      resolve(result);
    };

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => {
      const chunk = d.toString();
      stderr += chunk;
      // A real crash surfaces as a Node stack trace in stderr — bail out
      // early so a failing test fails fast, not after the timeout. The
      // patterns here are deliberately narrow: "at <func> (<file>:N:N)" is
      // a stack frame, "ReferenceError"/"TypeError"/"SyntaxError" name a
      // fatal class, and "^    <code>" is an indented source line in the
      // stack. Other stderr (deprecation warnings, internal logging) does
      // not match.
      if (/^\s+at\s+\S+\s+\(/m.test(chunk) ||
          /^ReferenceError|^TypeError|^SyntaxError/m.test(chunk)) {
        // Give it 50ms to flush more of the stack, then settle.
        setTimeout(() => settle({ exitCode: null, stdout, stderr, configPath: path.join(home, ...CONFIG_PATH_PARTS) }), 50);
      }
    });
    child.on('exit', (code) => settle({ exitCode: code, stdout, stderr, configPath: path.join(home, ...CONFIG_PATH_PARTS) }));

    const timer = setTimeout(
      () => settle({ exitCode: null, stdout, stderr, configPath: path.join(home, ...CONFIG_PATH_PARTS), timedOut: true }),
      timeoutMs
    );

    // Feed the script of inputs one line at a time, with a short gap so each
    // inquirer prompt has time to register the previous answer. The gap (300ms
    // by default) is the tradeoff between speed and reliability: too tight and
    // a slow boot can swallow two inputs as one; too loose and the suite
    // takes forever. 300ms is fast enough for the ~1.5s per-test budget and
    // has enough headroom for the boot + each of the five prompts.
    const gapMs = inputs.gapMs || 300;
    let i = 0;
    const writeNext = () => {
      if (i >= inputs.length) {
        // End stdin so the REPL sees EOF on the next readline; harmless if
        // /exit was already processed.
        child.stdin.end();
        return;
      }
      child.stdin.write(inputs[i]);
      i += 1;
      setTimeout(writeNext, gapMs);
    };
    setTimeout(writeNext, 200);
  });
}

// Strip ANSI escape codes — banner + inquirer menus use cursor movement and
// color codes that would otherwise make string assertions brittle.
function stripAnsi(s) {
  return s.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

// --- tests -----------------------------------------------------------------

// Track homes we created so we can clean them up after the suite.
const homes = [];
function tmp() {
  const h = freshHome();
  homes.push(h);
  return h;
}

before(() => { /* noop — kept symmetric with other suites */ });
after(() => {
  for (const h of homes) {
    try { fs.rmSync(h, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
});

test('first-run: clean exit after /config → /exit', () => serial(async () => {
  const home = tmp();
  const result = await spawnCli({
    home,
    // The first-run flow: API key → model (default) → search (Enter = no) → langsmith (Enter = no) → memory (Enter = no) → /exit.
    // We can't deliver a real Esc key through piped stdin (inquirer's keypress
    // handler only fires in TTY mode) — but the confirm prompts all default
    // to "No", so a bare Enter on each one is identical to "no thanks".
    inputs: [
      'nvapi-smoke-test\n', // API key prompt (password)
      '\n',                  // model prompt: accept the default
      '\n',                  // search: keep current setting (off)
      '\n',                  // langsmith: keep current setting (off)
      '\n',                  // memory: keep current setting (off)
      '/exit\n'              // REPL: graceful shutdown
    ]
  });

  if (result.timedOut) {
    assert.fail(`CLI did not exit within timeout. stderr: ${result.stderr.slice(0, 500)}`);
  }
  // The /exit path is process.exit(0), so a clean run gives code 0.
  // If a crash happens in the boot or /config path, we get a non-zero (or
  // null + a stack trace in stderr, caught by the early-settle handler).
  assert.strictEqual(result.exitCode, 0, `CLI exited with code ${result.exitCode}. stderr: ${result.stderr.slice(0, 500)}`);
}));

test('first-run: writes ~/.sun2agent/config.json with the typed API key', () => serial(async () => {
  const home = tmp();
  await spawnCli({
    home,
    inputs: [
      'nvapi-smoke-test\n',
      '\n', '\n', '\n', '\n',
      '/exit\n'
    ]
  });

  const configPath = path.join(home, ...CONFIG_PATH_PARTS);
  assert.ok(fs.existsSync(configPath), `expected ${configPath} to exist after /config`);

  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  assert.strictEqual(cfg.apiKey, 'nvapi-smoke-test', 'API key should be saved verbatim');
  assert.ok(cfg.model && typeof cfg.model === 'string', 'model should be set to a non-empty string');
  // Backward-compat sections must exist so older code paths keep working.
  assert.ok(cfg.langsmith, 'langsmith section must exist');
  assert.ok(cfg.sandbox, 'sandbox section must exist');
  assert.ok(cfg.memory, 'memory section must exist');
  assert.ok(cfg.hitl, 'hitl section must exist');
  assert.ok(cfg.search, 'search section must exist');
}));

test('first-run: config.json is created with 0600 permissions', () => serial(async () => {
  const home = tmp();
  await spawnCli({
    home,
    inputs: [
      'nvapi-smoke-test\n',
      '\n', '\n', '\n', '\n',
      '/exit\n'
    ]
  });

  const configPath = path.join(home, ...CONFIG_PATH_PARTS);
  const stat = fs.statSync(configPath);
  // Mask off the file-type bits so we only compare the permission octet.
  const mode = stat.mode & 0o777;
  assert.strictEqual(mode, 0o600, `config.json mode should be 0600, got ${mode.toString(8)}`);
}));

test('first-run: welcome banner is rendered', () => serial(async () => {
  const home = tmp();
  const result = await spawnCli({
    home,
    inputs: [
      'nvapi-smoke-test\n',
      '\n', '\n', '\n', '\n',
      '/exit\n'
    ]
  });

  const clean = stripAnsi(result.stdout);
  // The banner always prints the version line. Looking for "sun2Agent" is the
  // most stable fragment — it appears in the boxen title bar, before any
  // model name or inquirer noise.
  assert.match(clean, /sun2Agent/, 'banner should mention sun2Agent');
  // And the "No API key" warning, which is the first-run trigger.
  assert.match(clean, /No API key found/, 'first-run should print the "No API key" warning');
}));

test('second-run: skips /config when a valid config already exists', () => serial(async () => {
  // First, run the full first-run flow to produce a valid config.
  const home = tmp();
  await spawnCli({
    home,
    inputs: [
      'nvapi-second-run\n',
      '\n', '\n', '\n', '\n',
      '/exit\n'
    ]
  });

  // Now run again with the same HOME — the first-run /config prompt should
  // NOT appear, because config.apiKey is set. The REPL should boot straight
  // to the input box, and /exit should be the only thing we send.
  const result = await spawnCli({
    home,
    inputs: [ '/exit\n' ]
  });

  if (result.timedOut) {
    assert.fail(`CLI did not exit within timeout. stderr: ${result.stderr.slice(0, 500)}`);
  }
  assert.strictEqual(result.exitCode, 0, `CLI exited with code ${result.exitCode}. stderr: ${result.stderr.slice(0, 500)}`);

  const clean = stripAnsi(result.stdout);
  // The banner SHOULD still print (every boot shows the welcome).
  assert.match(clean, /sun2Agent/, 'banner should still render on second run');
  // But the "No API key" warning MUST NOT — the user already has a key.
  assert.doesNotMatch(clean, /No API key found/, 'second run should not re-prompt /config');
}));

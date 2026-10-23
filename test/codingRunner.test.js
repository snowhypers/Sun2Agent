'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const runner = require('../src/core/coding/runner');
const hitl = require('../src/core/hitl/mcpApproval');

let root;
before(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'sun2-coding-')); });
after(async () => {
  await runner.stopProjectServer();
  await fs.rm(root, { recursive: true, force: true });
});

async function project(scripts, files = {}) {
  const directory = path.join(root, `project-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await fs.mkdir(directory);
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ scripts }));
  for (const [name, contents] of Object.entries(files)) {
    await fs.writeFile(path.join(directory, name), contents);
  }
  return path.basename(directory);
}

async function loopbackListenerAvailable() {
  const server = http.createServer((_, res) => res.end('ok'));
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise((resolve, reject) => {
      const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', reject);
      req.setTimeout(500, () => {
        req.destroy();
        reject(new Error('timeout'));
      });
    });
    return true;
  } catch {
    return false;
  } finally {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

async function freeLoopbackPort() {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test('project checks run only declared supported scripts and report their actual outcome', async () => {
  const directory = await project({ test: 'node check.js' }, {
    'check.js': 'console.log("checks passed");'
  });
  assert.match(await runner.runProjectCheck(root, { script: 'test', path: directory }), /test PASSED[\s\S]*checks passed/);
  assert.match(await runner.runProjectCheck(root, { script: 'lint', path: directory }), /NOT RUN: no lint script/);
  const noTests = await project({ build: 'node -e "process.exit(0)"' });
  assert.match(await runner.runProjectCheck(root, { script: 'test', path: noTests }), /NOT CONFIGURED: no test script/);
  await assert.rejects(runner.runProjectCheck(root, { script: 'test; echo unsafe' }), /Choose an existing/);
  await assert.rejects(runner.runProjectCheck(root, { script: 'test', path: '..' }), /outside the workspace/);
});

test('project runner supports conventional API/backend test script names', async () => {
  const directory = await project({ 'test:api': 'node api-check.js' }, {
    'api-check.js': 'console.log("API checks passed");'
  });
  assert.match(await runner.runProjectCheck(root, { script: 'test:api', path: directory }), /PASSED[\s\S]*API checks passed/);
});

test('API curl smoke test is bounded, GET-only, and restricted to loopback', async (t) => {
  if (!await loopbackListenerAvailable()) {
    t.skip('environment blocks loopback listeners; run this integration test where localhost networking is enabled');
    return;
  }
  const server = http.createServer((req, res) => {
    assert.equal(req.method, 'GET');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();
  const result = await runner.curlLocalApi({ url: `http://127.0.0.1:${port}/todos` });
  assert.match(result, /Local API check PASSED: GET http:\/\/127\.0\.0\.1:\d+\/todos returned HTTP 200/);
  assert.match(result, /"ok":true/);
  await assert.rejects(runner.curlLocalApi({ url: 'https://example.com/' }), /only target localhost/);
  await assert.rejects(runner.curlLocalApi({ url: 'http://user:secret@localhost/' }), /without URL credentials/);
});

test('dependency installer skips empty manifests and requires approval', async () => {
  const directory = await project({}, { 'server.js': 'console.log("ready")' });
  assert.match(await runner.installProjectDependencies(root, { path: directory }), /skipped.*no dependencies/i);
  assert.equal(runner.installTool.name, 'install_project_dependencies');
  assert.equal(await hitl.checkApproval({
    server: 'workspace', tool: runner.installTool.name, args: { path: directory },
    enabled: true, _prompt: async () => false
  }), false);
});

test('project server starts only a declared local script and can be stopped by its owner', async (t) => {
  if (!await loopbackListenerAvailable()) {
    t.skip('environment blocks loopback listeners; run this integration test where localhost networking is enabled');
    return;
  }
  const port = await freeLoopbackPort();
  const directory = await project({ dev: 'node server.js' }, {
    'server.js': `const http = require("node:http"); const server = http.createServer((_, res) => res.end("ready")); console.log("Local: http://127.0.0.1:${port}"); setTimeout(() => server.listen(${port}, "127.0.0.1"), 300);`
  });
  const startedAt = Date.now();
  const result = await runner.startProjectServer(root, { script: 'dev', path: directory });
  assert.match(result, new RegExp(`http://127\\.0\\.0\\.1:${port}`));
  assert.match(result, /HTTP readiness check passed/);
  assert.ok(Date.now() - startedAt >= 250, 'runner waits for the server to accept HTTP requests');
  assert.equal(await runner.stopProjectServer(), true);
  await assert.rejects(new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/`, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.setTimeout(500, () => request.destroy(new Error('server still responding')));
    request.once('error', reject);
  }), /ECONNREFUSED/);
  assert.match(await runner.startProjectServer(root, { script: 'start', path: directory }), /no start script/);
});

test('backend and frontend servers can run together and cleanup stops both owned process groups', async (t) => {
  if (!await loopbackListenerAvailable()) {
    t.skip('environment blocks loopback listeners; run this integration test where localhost networking is enabled');
    return;
  }
  const apiPort = await freeLoopbackPort();
  const uiPort = await freeLoopbackPort();
  const api = await project({ start: 'node server.js' }, {
    'server.js': `const http = require("node:http"); http.createServer((_, res) => res.end("api"))` +
      `.listen(${apiPort}, "127.0.0.1"); console.log("API: http://127.0.0.1:${apiPort}");`
  });
  const frontend = await project({ dev: 'node server.js' }, {
    'server.js': `const http = require("node:http"); http.createServer((_, res) => res.end("ui"))` +
      `.listen(${uiPort}, "127.0.0.1"); console.log("Frontend: http://127.0.0.1:${uiPort}");`
  });
  assert.match(await runner.startProjectServer(root, { script: 'start', purpose: 'api', path: api }),
    /HTTP readiness check passed/);
  assert.match(await runner.startProjectServer(root, { script: 'dev', purpose: 'frontend', path: frontend }),
    /HTTP readiness check passed/);
  assert.match(await runner.startProjectServer(root, { script: 'dev', purpose: 'frontend', path: frontend }),
    /frontend process started by Sun2Agent is still running/);
  assert.equal(await runner.stopProjectServer(), true);
  for (const port of [apiPort, uiPort]) {
    await assert.rejects(new Promise((resolve, reject) => {
      const request = http.get(`http://127.0.0.1:${port}/`, (response) => {
        response.resume();
        resolve(response.statusCode);
      });
      request.setTimeout(500, () => request.destroy(new Error('owned server still responding')));
      request.once('error', reject);
    }), /ECONNREFUSED/);
  }
});

test('stopping project server kills same-group workers that ignore SIGTERM', async (t) => {
  if (!await loopbackListenerAvailable()) {
    t.skip('environment blocks loopback listeners; run this integration test where localhost networking is enabled');
    return;
  }
  const port = await freeLoopbackPort();
  const directory = await project({ dev: 'node launcher.js' }, {
    'worker.js': `const fs = require('node:fs');\nconst http = require('node:http');\nprocess.on('SIGTERM', () => {});\nhttp.createServer((_, res) => res.end('alive')).listen(${port}, '127.0.0.1');\nfs.writeFileSync('worker.pid', String(process.pid));`,
    'launcher.js': `const { spawn } = require('node:child_process');\nspawn(process.execPath, ['worker.js'], { stdio: 'ignore' });\nconsole.log('Local: http://127.0.0.1:${port}');\nsetInterval(() => {}, 1000);`
  });
  const workerPidFile = path.join(root, directory, 'worker.pid');
  t.after(async () => {
    try { process.kill(Number(await fs.readFile(workerPidFile, 'utf8')), 'SIGKILL'); }
    catch (_) { /* test worker already stopped */ }
  });
  assert.match(await runner.startProjectServer(root, { script: 'dev', path: directory }), /HTTP readiness check passed/);
  assert.equal(await runner.stopProjectServer(), true);
  await assert.rejects(new Promise((resolve, reject) => {
    const request = http.get(`http://127.0.0.1:${port}/`, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.setTimeout(500, () => request.destroy(new Error('worker still responding')));
    request.once('error', reject);
  }), /ECONNREFUSED/);
});

test('cancelling server startup waits for the owned process group to stop', async (t) => {
  if (process.platform === 'win32') {
    t.skip('process-group ownership is POSIX-specific');
    return;
  }
  const directory = await project({ dev: 'node server.js' }, {
    'server.js': 'const fs = require("node:fs"); fs.writeFileSync("server.pid", String(process.pid)); process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);'
  });
  const pidFile = path.join(root, directory, 'server.pid');
  const controller = new AbortController();
  const starting = runner.startProjectServer(root, {
    script: 'dev', path: directory, signal: controller.signal
  });
  for (let attempt = 0; attempt < 100; attempt++) {
    try { await fs.access(pidFile); break; }
    catch (_) { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  const pid = Number(await fs.readFile(pidFile, 'utf8'));
  controller.abort();
  await assert.rejects(starting, /Project server start cancelled/);
  assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
  assert.equal(await runner.stopProjectServer(), false, 'startup cleanup already released the owned process');
});

test('running project scripts remains approval-gated', async () => {
  let prompts = 0;
  const prompt = async () => { prompts++; return false; };
  assert.equal(await hitl.checkApproval({
    server: 'workspace', tool: 'run_project_check', args: { script: 'test' },
    annotations: { readOnlyHint: true }, enabled: true, _prompt: prompt
  }), false);
  assert.equal(await hitl.checkApproval({
    server: 'workspace', tool: 'start_project_server', args: { script: 'dev' },
    enabled: true, _prompt: prompt
  }), false);
  assert.equal(await hitl.checkApproval({
    server: 'workspace', tool: 'curl_local_api', args: { url: 'http://localhost:3000/todos' },
    codingMode: true, enabled: true, _prompt: prompt
  }), false);
  assert.equal(prompts, 3);
});

test('reapStaleProcesses kills stale tracked process groups and removes pid file', async (t) => {
  if (process.platform === 'win32') {
    t.skip('process-group signals are POSIX-specific');
    return;
  }
  const projectDir = path.join(root, 'stale-reap-test');
  await fs.mkdir(projectDir, { recursive: true });
  const { spawn } = require('node:child_process');
  const dummy = spawn('node', ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true, stdio: 'ignore'
  });
  const pid = dummy.pid;
  const pidFile = path.join(projectDir, '.sun2agent-pids.json');
  await fs.writeFile(pidFile, JSON.stringify([pid]));
  await runner.reapStaleProcesses(projectDir);
  await new Promise((r) => setTimeout(r, 100));
  let running = true;
  try { process.kill(pid, 0); } catch (_) { running = false; }
  assert.equal(running, false);
  await assert.rejects(fs.access(pidFile));
});

test('parseErrorContext extracts file and line numbers from stack traces', () => {
  const stack = `
Error: assertion failed
    at Object.<anonymous> (/workspace/src/app.js:23:10)
    at Module._compile (node:internal/modules/cjs/loader:1376:14)
`;
  const context = runner.parseErrorContext(stack);
  assert.match(context, /\[Error Context\]/);
  assert.match(context, /app\.js:23/);
});

test('curlLocalApi validates supported methods and request bodies', async () => {
  await assert.rejects(runner.curlLocalApi({ url: 'http://127.0.0.1:3000', method: 'PATCH' }), /supported HTTP method/);
  await assert.rejects(runner.curlLocalApi({ url: 'http://127.0.0.1:3000', body: 12345 }), /body must be a string/);
  const largeBody = 'x'.repeat(5000);
  await assert.rejects(runner.curlLocalApi({ url: 'http://127.0.0.1:3000', method: 'POST', body: largeBody }), /exceeds maximum size/);
});

test('startProjectServer normalizes command arguments and falls back to existing scripts', async () => {
  const directory = await project({ start: 'node -e "process.exit(0)"' });
  await assert.rejects(
    runner.startProjectServer(root, { command: 'npm run invalidscript', path: directory }),
    /Choose an existing dev, start, or serve script/
  );
  const result = await runner.startProjectServer(root, { path: 'nonexistent-directory' });
  assert.match(result, /no package\.json/);
});

test('runner and mcp support directory parameter aliases (projectPath, directory, dir, cwd, filePath)', async () => {
  const mcp = require('../src/core/mcp');

  // 1. Test normalizeToolArgs
  const route = { server: 'workspace', tool: 'write_file' };
  assert.equal(mcp.normalizeToolArgs(route, { projectPath: 'sub/dir' }).path, 'sub/dir');
  assert.equal(mcp.normalizeToolArgs(route, { directory: 'sub/dir2' }).path, 'sub/dir2');
  assert.equal(mcp.normalizeToolArgs(route, { dir: 'sub/dir3' }).path, 'sub/dir3');
  assert.equal(mcp.normalizeToolArgs(route, { cwd: 'sub/dir4' }).path, 'sub/dir4');
  assert.equal(mcp.normalizeToolArgs(route, { filePath: 'sub/dir5/file.js' }).path, 'sub/dir5/file.js');

  // 2. Test runner functions with nested MERN project structure
  const nestedRelPath = 'mern-todo/backend';
  const nestedFullPath = path.join(root, nestedRelPath);
  await fs.mkdir(nestedFullPath, { recursive: true });
  await fs.writeFile(
    path.join(nestedFullPath, 'package.json'),
    JSON.stringify({
      scripts: {
        'test:api': 'node -e "console.log(\'mern api test passed\')"',
        start: 'node -e "process.exit(0)"'
      }
    })
  );

  // runProjectCheck with aliases
  const checkRes1 = await runner.runProjectCheck(root, { script: 'test:api', projectPath: nestedRelPath });
  assert.match(checkRes1, /PASSED[\s\S]*mern api test passed/);

  const checkRes2 = await runner.runProjectCheck(root, { script: 'test:api', directory: nestedRelPath });
  assert.match(checkRes2, /PASSED[\s\S]*mern api test passed/);

  const checkRes3 = await runner.runProjectCheck(root, { script: 'test:api', dir: nestedRelPath });
  assert.match(checkRes3, /PASSED[\s\S]*mern api test passed/);

  const checkRes4 = await runner.runProjectCheck(root, { script: 'test:api', cwd: nestedRelPath });
  assert.match(checkRes4, /PASSED[\s\S]*mern api test passed/);

  // installProjectDependencies with aliases (empty dependencies skips cleanly without ENOENT)
  const installRes1 = await runner.installProjectDependencies(root, { projectPath: nestedRelPath });
  assert.match(installRes1, /Dependency install skipped: package\.json declares no dependencies/);

  const installRes2 = await runner.installProjectDependencies(root, { directory: nestedRelPath });
  assert.match(installRes2, /Dependency install skipped: package\.json declares no dependencies/);

  const installRes3 = await runner.installProjectDependencies(root, { dir: nestedRelPath });
  assert.match(installRes3, /Dependency install skipped: package\.json declares no dependencies/);

  // startProjectServer with aliases resolves the directory instead of complaining about missing package.json
  await assert.rejects(
    runner.startProjectServer(root, { script: 'nonexistent', projectPath: nestedRelPath }),
    /Choose an existing dev, start, or serve script/
  );
  await assert.rejects(
    runner.startProjectServer(root, { script: 'nonexistent', directory: nestedRelPath }),
    /Choose an existing dev, start, or serve script/
  );
});

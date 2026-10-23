// Runs only named scripts already declared by a project; never accepts shell text.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');
const https = require('node:https');

const CHECKS = ['test', 'test:api', 'test:backend', 'build', 'lint', 'typecheck'];
const SERVERS = ['dev', 'start', 'serve'];
const installTool = {
  name: 'install_project_dependencies',
  description: 'Run fixed npm install inside the workspace. Package lifecycle scripts execute, so this requires approval; 5-minute timeout.',
  inputSchema: {
    type: 'object', properties: { path: { type: 'string', description: 'Project directory; defaults to .' } },
    additionalProperties: false
  }
};
const checkTool = {
  name: 'run_project_check',
  description: 'Run one existing npm API/backend test, test, build, lint, or typecheck script inside the workspace. Executes project code and requires approval. No installs; 2-minute timeout and bounded output.',
  inputSchema: {
    type: 'object',
    properties: {
      script: { type: 'string', enum: CHECKS },
      path: { type: 'string', description: 'Project directory inside the workspace; defaults to .' }
    },
    required: ['script'],
    additionalProperties: false
  }
};
const curlTool = {
  name: 'curl_local_api',
  description: 'Smoke-test a local API endpoint with a bounded HTTP request. Only localhost/loopback URLs are allowed; no redirects, external hosts, or URL credentials. Requires approval as a test.',
  inputSchema: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Local HTTP(S) endpoint, e.g. http://127.0.0.1:3000/todos' },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'], description: 'HTTP method; defaults to GET' },
      body: { type: 'string', description: 'Optional request body string (JSON/text, max 4096 bytes)' }
    },
    required: ['url'],
    additionalProperties: false
  }
};
const serverTool = {
  name: 'start_project_server',
  description: 'Start an existing npm dev/start/serve script inside the workspace for a local API or frontend test. One API and one frontend process can run together for full-stack checks. Executes project code and requires approval; Sun2Agent stops only its owned process groups after checks or at task end.',
  inputSchema: {
    type: 'object',
    properties: {
      script: { type: 'string', enum: SERVERS, description: 'npm script name to run: "start", "dev", or "serve"' },
      command: { type: 'string', description: 'Alternative command format, e.g. "npm start" or "npm run dev"' },
      purpose: { type: 'string', enum: ['api', 'frontend'], description: 'Use api for a backend smoke test with curl, or frontend for Playwright E2E.' },
      path: { type: 'string', description: 'Project directory inside the workspace; defaults to .' },
      port: { type: 'string', description: 'Port number hint (optional)' }
    },
    additionalProperties: false
  }
};

const projectServers = new Map();
const SAFE_ENV = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA',
  'SYSTEMROOT', 'TMPDIR', 'TEMP', 'LANG', 'LC_ALL'];

function probeLocalServer(address, signal) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(address); } catch (_) { return resolve(false); }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) return resolve(false);
    const client = url.protocol === 'https:' ? https : http;
    const request = client.get(url, { signal }, (response) => {
      response.resume();
      resolve(response.statusCode < 500);
    });
    request.setTimeout(500, () => request.destroy());
    request.once('error', () => resolve(false));
  });
}

async function waitForLocalServer(address, signal, timeoutMs = 9500) {
  const deadline = Date.now() + timeoutMs;
  while (!signal.aborted && Date.now() < deadline) {
    if (await probeLocalServer(address, signal)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function scriptCommand(script) {
  return process.platform === 'win32'
    ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `npm run ${script}`]]
    : ['npm', ['run', script]];
}

function scriptEnvironment(ci = false) {
  const env = Object.fromEntries(SAFE_ENV.filter((key) => process.env[key] !== undefined)
    .map((key) => [key, process.env[key]]));
  if (ci) env.CI = 'true';
  return env;
}

async function projectAt(root, directory = '.') {
  if (!root || typeof directory !== 'string') throw new Error('Invalid workspace project path');
  const workspace = await fs.realpath(root);
  const cwd = await fs.realpath(path.resolve(workspace, directory));
  const relative = path.relative(workspace, cwd);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Project directory is outside the workspace');
  }
  const manifest = path.join(cwd, 'package.json');
  const stat = await fs.lstat(manifest);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('package.json must be a regular file');
  return { cwd, pkg: JSON.parse(await fs.readFile(manifest, 'utf8')) };
}

const PID_FILE = '.sun2agent-pids.json';

async function recordChildPid(root, pid) {
  if (!root || !pid) return;
  try {
    const file = path.join(root, PID_FILE);
    let pids = [];
    try { pids = JSON.parse(await fs.readFile(file, 'utf8')); } catch (_) { pids = []; }
    if (!Array.isArray(pids)) pids = [];
    if (!pids.includes(pid)) {
      pids.push(pid);
      await fs.writeFile(file, JSON.stringify(pids));
    }
  } catch (_) { /* ignore disk tracking errors */ }
}

async function unrecordChildPid(root, pid) {
  if (!root || !pid) return;
  try {
    const file = path.join(root, PID_FILE);
    let pids = [];
    try { pids = JSON.parse(await fs.readFile(file, 'utf8')); } catch (_) { return; }
    if (!Array.isArray(pids)) return;
    pids = pids.filter((p) => p !== pid);
    if (pids.length) {
      await fs.writeFile(file, JSON.stringify(pids));
    } else {
      await fs.unlink(file).catch(() => {});
    }
  } catch (_) { /* ignore disk tracking errors */ }
}

async function reapStaleProcesses(root) {
  if (!root) return;
  try {
    const file = path.join(root, PID_FILE);
    let pids = [];
    try { pids = JSON.parse(await fs.readFile(file, 'utf8')); } catch (_) { return; }
    if (!Array.isArray(pids)) return;
    for (const pid of pids) {
      if (typeof pid === 'number' && pid > 0) {
        if (process.platform === 'win32') {
          try { process.kill(pid, 'SIGKILL'); } catch (_) {}
        } else {
          try { process.kill(-pid, 'SIGKILL'); } catch (_) {}
          try { process.kill(pid, 'SIGKILL'); } catch (_) {}
        }
      }
    }
    await fs.unlink(file).catch(() => {});
  } catch (_) { /* ignore cleanup errors */ }
}

function signalTree(child, signal) {
  if (!child?.pid) return;
  if (process.platform === 'win32') child.kill(signal);
  else {
    try { process.kill(-child.pid, signal); } catch (_) { /* already exited */ }
  }
}

function processExists(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function processGroupExists(pid) {
  if (process.platform === 'win32' || !pid) return false;
  try { process.kill(-pid, 0); return true; }
  catch (error) { return error.code === 'EPERM'; }
}

function clearProjectServer(child, root) {
  for (const [purpose, server] of projectServers) {
    if (server.child !== child) continue;
    projectServers.delete(purpose);
    process.removeListener('exit', server.exitHandler);
  }
  if (root && child?.pid) unrecordChildPid(root, child.pid);
}

function collectOutput(child, maxBytes = 1024 * 1024) {
  let head = '';
  let tail = '';
  let bytes = 0;
  let overflow = false;
  const HEAD_LIMIT = 4096;
  const TAIL_LIMIT = 12000;

  const collect = (chunk) => {
    const text = chunk.toString();
    bytes += chunk.length;
    if (head.length < HEAD_LIMIT) {
      head += text;
      if (head.length > HEAD_LIMIT) head = head.slice(0, HEAD_LIMIT);
    }
    tail = (tail + text).slice(-TAIL_LIMIT);
    if (bytes > maxBytes) {
      overflow = true;
      signalTree(child, 'SIGKILL');
    }
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  return {
    get output() {
      if (bytes <= HEAD_LIMIT + TAIL_LIMIT) {
        return (head + tail).slice(0, bytes).slice(-16000);
      }
      return `${head}\n[…truncated ${bytes - HEAD_LIMIT - TAIL_LIMIT} bytes…]\n${tail}`;
    },
    get overflow() { return overflow; }
  };
}

function runProcess(command, args, { cwd, env, signal, timeoutMs, cancelMessage, maxOutputBytes = 1024 * 1024 } = {}) {
  if (signal?.aborted) return Promise.reject(new Error(cancelMessage));
  const child = spawn(command, args, {
    cwd, env, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe']
  });
  const captured = collectOutput(child, maxOutputBytes);
  let stopReason = '';
  const cancel = () => { stopReason = 'cancelled'; signalTree(child, 'SIGKILL'); };
  const onExit = () => signalTree(child, 'SIGKILL');
  process.once('exit', onExit);
  signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => { stopReason = 'timed out'; signalTree(child, 'SIGKILL'); }, timeoutMs);
  if (signal?.aborted) cancel();

  return new Promise((resolve, reject) => {
    let settled = false;
    child.once('error', (error) => finish(error));
    child.once('close', (code) => finish(null, code));
    function finish(error, code) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener('exit', onExit);
      signal?.removeEventListener('abort', cancel);
      signalTree(child, 'SIGKILL');
      if (stopReason === 'cancelled') return reject(new Error(cancelMessage));
      resolve({ error, code, stopReason, output: captured.output, overflow: captured.overflow });
    }
  });
}

function parseErrorContext(output) {
  if (!output || typeof output !== 'string') return '';
  const errors = [];
  // Node.js stack traces: "at ... (/path/to/file.js:12:5)" or "at /path/to/file.js:12:5"
  for (const match of output.matchAll(/at\s+(?:[^\s(]+\s+\(([^)]+):(\d+):\d+\)|([^\s()]+):(\d+):\d+)/g)) {
    const filePath = match[1] || match[3];
    const line = match[2] || match[4];
    if (filePath && !filePath.includes('node_modules') && !filePath.startsWith('node:')) {
      errors.push({ file: path.basename(filePath), line });
    }
  }
  // Jest/Vitest: "  src/index.js:15:3"
  for (const match of output.matchAll(/^\s+([a-zA-Z0-9_./-]+\.[a-zA-Z0-9]+):(\d+)(?::\d+)?/gm)) {
    if (!match[1].includes('node_modules')) {
      errors.push({ file: match[1], line: match[2] });
    }
  }
  if (!errors.length) return '';
  const unique = [...new Map(errors.map((e) => [`${e.file}:${e.line}`, e])).values()].slice(0, 5);
  return '\n\n[Error Context]\n' + unique.map((e) => `  → ${e.file}:${e.line}`).join('\n');
}

async function runProjectCheck(root, { script, path: requestedPath, projectPath, directory: requestedDir, dir, cwd, signal } = {}) {
  const directory = requestedPath || projectPath || requestedDir || dir || cwd || '.';
  if (!CHECKS.includes(script)) throw new Error('Choose an existing test, build, lint, or typecheck script');
  let project;
  try { project = await projectAt(root, directory); }
  catch (error) {
    if (error.code === 'ENOENT' && ['test', 'test:api', 'test:backend'].includes(script)) {
      return 'Project check NOT CONFIGURED: no package.json or npm test scripts in the selected directory.';
    }
    if (error.code === 'ENOENT') return 'Project check NOT RUN: no package.json in the selected directory.';
    throw error;
  }
  const source = project.pkg.scripts?.[script];
  if (typeof source !== 'string' || !source.trim()) {
    const testScripts = ['test', 'test:api', 'test:backend']
      .filter((name) => typeof project.pkg.scripts?.[name] === 'string' && project.pkg.scripts[name].trim());
    if (['test', 'test:api', 'test:backend'].includes(script) && testScripts.length === 0) {
      return 'Project check NOT CONFIGURED: no test script is declared in package.json.';
    }
    const available = testScripts.length ? ` Available test scripts: ${testScripts.join(', ')}.` : '';
    return `Project check NOT RUN: no ${script} script in package.json.${available}`;
  }
  const [command, args] = scriptCommand(script);
  const MAX_RETRIES = ['test', 'test:api', 'test:backend'].includes(script) ? 1 : 0;
  let result;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    result = await runProcess(command, args, {
      cwd: project.cwd, env: scriptEnvironment(true), signal, timeoutMs: 120000,
      cancelMessage: 'Project check cancelled'
    });
    if (result.code === 0 || result.stopReason || result.overflow || result.error || signal?.aborted) {
      break;
    }
    if (attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  const state = result.stopReason ? `NOT VERIFIED: ${result.stopReason}`
    : result.overflow ? 'NOT VERIFIED: output limit reached'
      : result.error ? `NOT RUN: ${result.error.code || result.error.message}`
        : result.code === 0 ? 'PASSED' : `FAILED (exit ${result.code})`;
  const errorContext = result.code !== 0 ? parseErrorContext(result.output) : '';
  return `Project check ${script} ${state}.\n${result.output.trim()}${errorContext}`;
}

async function curlLocalApi({ url: address, method: requestedMethod = 'GET', body, signal } = {}) {
  let url;
  try { url = new URL(address); } catch (_) { throw new Error('Provide a valid local API URL'); }
  if (!['http:', 'https:'].includes(url.protocol) ||
      !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
      url.username || url.password) {
    throw new Error('API smoke tests may only target localhost or a loopback IP, without URL credentials');
  }
  const method = String(requestedMethod || 'GET').toUpperCase();
  if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) {
    throw new Error('Choose a supported HTTP method: GET, POST, PUT, DELETE');
  }
  if (body !== undefined && typeof body !== 'string') {
    throw new Error('Request body must be a string');
  }
  if (body && Buffer.byteLength(body, 'utf8') > 4096) {
    throw new Error('Request body exceeds maximum size of 4096 bytes');
  }

  const curlArgs = [
    '--disable', '--silent', '--show-error', '--request', method, '--connect-timeout', '2',
    '--max-time', '5', '--max-filesize', '65536',
    '--max-redirs', '0', '--noproxy', '*', '--proto', '=http,https'
  ];
  if (body !== undefined && method !== 'GET') {
    curlArgs.push('--header', 'Content-Type: application/json', '--data-raw', body);
  }
  curlArgs.push('--write-out', '\n__SUN2_HTTP_STATUS__:%{http_code}', url.href);

  const result = await runProcess('curl', curlArgs, {
    cwd: process.cwd(), env: scriptEnvironment(), signal, timeoutMs: 7000,
    cancelMessage: 'Local API check cancelled', maxOutputBytes: 64 * 1024
  });
  if (result.stopReason || result.overflow) return `Local API check NOT VERIFIED: ${result.stopReason || 'response exceeded 64 KiB'}.`;
  if (result.error) return `Local API check NOT RUN: curl could not start (${result.error.code || result.error.message}).`;
  const match = result.output.match(/\n__SUN2_HTTP_STATUS__:(\d{3})\s*$/);
  if (!match) return `Local API check FAILED (curl exit ${result.code}).\n${result.output.trim()}`;
  const status = Number(match[1]);
  const responseBody = result.output.slice(0, match.index).trim().slice(0, 16000);
  const outcome = result.code === 0 && status >= 200 && status < 300 ? 'PASSED' : 'FAILED';
  return `Local API check ${outcome}: ${method} ${url.origin}${url.pathname} returned HTTP ${match[1]}${result.code === 0 ? '.' : ` (curl exit ${result.code}).`}${responseBody ? `\n${responseBody}` : ''}`;
}

async function installProjectDependencies(root, { path: requestedPath, projectPath, directory: requestedDir, dir, cwd, signal } = {}) {
  const directory = requestedPath || projectPath || requestedDir || dir || cwd || '.';
  const project = await projectAt(root, directory);
  const dependencies = { ...project.pkg.dependencies, ...project.pkg.devDependencies, ...project.pkg.optionalDependencies };
  if (!Object.keys(dependencies).length) return 'Dependency install skipped: package.json declares no dependencies.';
  const result = await runProcess('npm', ['install', '--no-audit', '--no-fund'], {
    cwd: project.cwd, env: scriptEnvironment(), signal, timeoutMs: 120000,
    cancelMessage: 'Dependency installation cancelled'
  });
  const state = result.stopReason ? `NOT VERIFIED: ${result.stopReason}`
    : result.overflow ? 'NOT VERIFIED: output limit reached'
      : result.error ? `FAILED TO START (${result.error.code || result.error.message})`
        : result.code === 0 ? 'COMPLETED' : `FAILED (exit ${result.code})`;
  return `Dependencies ${state}.\n${result.output.trim()}`;
}

async function startProjectServer(root, { script: requestedScript, command: requestedCommand, purpose: requestedPurpose, path: requestedPath, projectPath, directory: requestedDir, dir, cwd, signal } = {}) {
  const directory = requestedPath || projectPath || requestedDir || dir || cwd || '.';
  let project;
  try { project = await projectAt(root, directory); }
  catch (error) {
    if (error.code === 'ENOENT') return 'Project server NOT STARTED: no package.json in the selected directory.';
    throw error;
  }
  let script = requestedScript;
  if (!script && typeof requestedCommand === 'string') {
    const match = requestedCommand.match(/(?:npm\s+(?:run\s+)?)?([a-z0-9:_-]+)/i);
    if (match) script = match[1];
  }
  if (typeof script === 'string') {
    script = script.trim().replace(/^npm\s+(?:run\s+)?/i, '');
  }
  if (!script) {
    for (const fallback of SERVERS) {
      if (typeof project.pkg.scripts?.[fallback] === 'string' && project.pkg.scripts[fallback].trim()) {
        script = fallback;
        break;
      }
    }
  }
  if (!SERVERS.includes(script)) throw new Error('Choose an existing dev, start, or serve script');
  const purpose = requestedPurpose === 'api' ? 'api' : 'frontend';
  const existing = projectServers.get(purpose)?.child;
  if (existing && (existing.exitCode === null || processGroupExists(existing.pid))) {
    return `A ${purpose} process started by Sun2Agent is still running.`;
  }
  if (typeof project.pkg.scripts?.[script] !== 'string' || !project.pkg.scripts[script].trim()) {
    return `Project server NOT STARTED: no ${script} script in package.json.`;
  }
  if (signal?.aborted) throw new Error('Project server start cancelled');
  const [command, args] = scriptCommand(script);
  const child = spawn(command, args, {
    cwd: project.cwd, env: scriptEnvironment(), detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (child.pid) void recordChildPid(root, child.pid);
  const exitHandler = () => signalTree(child, 'SIGKILL');
  projectServers.set(purpose, { child, exitHandler, root });
  const captured = collectOutput(child, 256 * 1024);
  process.once('exit', exitHandler);
  child.once('close', () => {
    if (!processGroupExists(child.pid)) clearProjectServer(child, root);
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let cleaningUp = false;
    let readinessStarted = false;
    const readinessController = new AbortController();
    const timer = setTimeout(async () => {
      cleaningUp = true;
      readinessController.abort();
      let cleanupFailed = false;
      try { await stopProjectServer(); } catch (_) { cleanupFailed = true; }
      finish(`Project server NOT READY; the process started by Sun2Agent ${cleanupFailed ? 'could not be confirmed stopped' : 'was stopped'}.\n${captured.output.trim()}`);
    }, 10000);
    const finish = (result, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      readinessController.abort();
      signal?.removeEventListener('abort', cancel);
      child.stdout.removeListener('data', onOutput);
      child.stderr.removeListener('data', onOutput);
      if (error) reject(error);
      else resolve(result);
    };
    const cancel = () => {
      if (cleaningUp) return;
      cleaningUp = true;
      void stopProjectServer().then(
        () => finish(null, new Error('Project server start cancelled')),
        (error) => finish(null, new Error(`Project server start cancelled; cleanup failed: ${error.message}`))
      );
    };
    const onOutput = () => {
      if (/EADDRINUSE|address already in use/i.test(captured.output) && !settled && !cleaningUp) {
        cleaningUp = true;
        readinessController.abort();
        void stopProjectServer().then(
          () => finish(`Project server FAILED: port already in use. Kill the conflicting process or configure a different port.\n${captured.output.trim()}`),
          () => finish(`Project server FAILED: port already in use.\n${captured.output.trim()}`)
        );
        return;
      }
      const match = captured.output.match(/https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?[^\s]*/i);
      if (match && !readinessStarted) {
        readinessStarted = true;
        const address = match[0].replace('0.0.0.0', 'localhost');
        void waitForLocalServer(address, readinessController.signal).then((ready) => {
          if (ready) finish(`Project server reported ${address}\nHTTP readiness check passed.\n${captured.output.trim()}`);
        });
      }
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);
    child.once('error', (error) => finish(null, error));
    child.once('close', (code) => {
      if (!cleaningUp) finish(`Project server exited before verification (code ${code}).\n${captured.output.trim()}`);
    });
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
  });
}

async function stopProjectServer() {
  const servers = [...projectServers.values()];
  if (!servers.length) return false;
  const results = await Promise.allSettled(servers.map(async ({ child, root }) => {
    signalTree(child, 'SIGTERM');
    const isStopped = () => !processGroupExists(child.pid) &&
      (!child.pid || child.exitCode !== null || child.signalCode !== null || !processExists(child.pid));
    const waitUntil = async (deadline) => {
      while (!isStopped() && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return isStopped();
    };
    if (!await waitUntil(Date.now() + 1500)) {
      signalTree(child, 'SIGKILL');
      if (!await waitUntil(Date.now() + 1500)) {
        throw new Error('Could not confirm that a project process group started by Sun2Agent has stopped.');
      }
    }
    clearProjectServer(child, root);
  }));
  const failed = results.find((result) => result.status === 'rejected');
  if (failed) throw failed.reason;
  return true;
}

module.exports = {
  installTool, checkTool, curlTool, serverTool, installProjectDependencies,
  runProjectCheck, curlLocalApi, startProjectServer, stopProjectServer,
  reapStaleProcesses, parseErrorContext
};

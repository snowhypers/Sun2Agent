'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSession } = require('../src/core/coding/session');

test('coding session records verification phases and gates premature completion', () => {
  const session = createSession(true);
  const system = { content: '' };
  const message = { content: 'Done', tool_calls: null };
  assert.equal(session.recordToolResult({ server: 'workspace', tool: 'write_file' },
    { path: 'package.json' }, 'Wrote file'), false);
  assert.deepEqual(session.beforeFinish(message, true, system).missing, ['install declared dependencies']);
  assert.match(system.content, /Coding verification gate/);
  assert.deepEqual(session.beforeFinish(message, true, system), {
    retry: false,
    missing: ['install declared dependencies']
  });
  assert.match(message.content, /^Task incomplete:/);
});

test('approved or bold-heading plans permit changes only after workspace inspection', () => {
  const route = { server: 'workspace', tool: 'write_file' };
  const approved = createSession(true, 'create a file', true);
  assert.equal(approved.authorizeTool(route, { content: '' }, false).allowed, false);
  approved.recordToolResult({ server: 'workspace', tool: 'list_directory' }, { path: '.' }, 'Empty workspace');
  assert.equal(approved.authorizeTool(route, { content: '' }, true).allowed, true);

  const planned = createSession(true, 'create a file');
  planned.recordToolResult({ server: 'workspace', tool: 'list_directory' }, { path: '.' }, 'Empty workspace');
  assert.equal(planned.authorizeTool(route, { content: '**Plan**\n1. Create `index.html`.' }, true).allowed, true);
});

test('coding session accepts skipped installs and projects with no test scripts', () => {
  const session = createSession(true);
  const system = { content: '' };
  const message = { content: 'Done', tool_calls: null };
  session.recordToolResult({ server: 'workspace', tool: 'write_file' },
    { path: 'package.json' }, 'Wrote file');
  session.recordToolResult({ server: 'workspace', tool: 'install_project_dependencies' }, {},
    'Dependency install skipped: package.json declares no dependencies.');
  session.recordToolResult({ server: 'workspace', tool: 'run_project_check' }, { script: 'test' },
    'Project check NOT CONFIGURED: no test script is declared in package.json.');
  assert.deepEqual(session.beforeFinish(message, true, system), { retry: false, missing: [] });
});

test('coding session accepts a successful local curl check and leaves unconfigured tests optional', () => {
  const session = createSession(true);
  const message = { content: 'Done', tool_calls: null };
  const system = { content: '' };
  session.recordToolResult({ server: 'workspace', tool: 'write_file' }, { path: 'server.js' }, 'Wrote file');
  assert.equal(session.recordToolResult({ server: 'workspace', tool: 'start_project_server' }, { purpose: 'api' },
    'Project server reported http://127.0.0.1:3000'), false, 'API servers do not start Playwright');
  assert.deepEqual(session.beforeFinish(message, true, system), {
    retry: true, missing: ['run the local API smoke test']
  });
  session.recordToolResult({ server: 'workspace', tool: 'curl_local_api' },
    { url: 'http://127.0.0.1:3000/todos' }, 'Local API check PASSED: GET http://127.0.0.1:3000/todos returned HTTP 200.');
  assert.deepEqual(session.beforeFinish(message, true, system), { retry: false, missing: [] });
});

test('API smoke-test stops API-only servers but leaves full-stack teardown until Playwright finishes', () => {
  const api = createSession(true, 'create an API backend');
  api.recordToolResult({ server: 'workspace', tool: 'start_project_server' }, { purpose: 'api' },
    'Project server reported http://localhost:3000');
  assert.equal(api.shouldStopProjectServer(), false);
  api.recordToolResult({ server: 'workspace', tool: 'curl_local_api' }, {},
    'Local API check PASSED: GET http://localhost:3000/todos returned HTTP 200.');
  assert.equal(api.shouldStopProjectServer(), true);

  const fullStack = createSession(true, 'create full stack todo app');
  fullStack.recordToolResult({ server: 'workspace', tool: 'start_project_server' }, { purpose: 'api' },
    'Project server reported http://localhost:3000');
  fullStack.recordToolResult({ server: 'workspace', tool: 'curl_local_api' }, {},
    'Local API check PASSED: GET http://localhost:3000/todos returned HTTP 200.');
  assert.equal(fullStack.shouldStopProjectServer(), false);
  fullStack.recordToolResult({ server: 'coding-browser', tool: 'browser_navigate' }, { url: 'http://localhost:3000/' },
    'Page URL: http://localhost:3000/');
  fullStack.recordToolResult({ server: 'coding-browser', tool: 'browser_click' }, {}, 'Clicked button');
  fullStack.recordToolResult({ server: 'coding-browser', tool: 'browser_snapshot' }, {},
    'Page URL: http://localhost:3000/\nPage Title: Todo\nPage Snapshot:\n- heading "Todo"');
  assert.equal(fullStack.shouldStopProjectServer(), false);
});

test('full-stack Playwright tools are blocked until the backend API smoke check passes', () => {
  const session = createSession(true, 'create full stack todo app');
  const browserRoute = { server: 'coding-browser', tool: 'browser_navigate' };
  const browserArgs = { url: 'http://localhost:5173/' };
  assert.deepEqual(session.authorizeTool(browserRoute, {}, true, browserArgs), {
    allowed: false,
    reason: 'Complete the backend API check before using Playwright for this full-stack task.'
  });
  session.recordToolResult({ server: 'workspace', tool: 'start_project_server' }, { purpose: 'api' },
    'Project server reported http://localhost:3000');
  session.recordToolResult({ server: 'workspace', tool: 'curl_local_api' }, {},
    'Local API check FAILED: GET http://localhost:3000/todos returned HTTP 500.');
  assert.equal(session.authorizeTool(browserRoute, {}, true, browserArgs).allowed, false);
  session.recordToolResult({ server: 'workspace', tool: 'curl_local_api' }, {},
    'Local API check PASSED: GET http://localhost:3000/todos returned HTTP 200.');
  assert.equal(session.authorizeTool(browserRoute, {}, true, browserArgs).allowed, true);
});

test('full-stack waits to connect Playwright until the frontend server is ready', () => {
  const session = createSession(true, 'create full stack todo app');
  assert.equal(session.recordToolResult({ server: 'workspace', tool: 'start_project_server' }, { purpose: 'api' },
    'Project server reported http://localhost:3000'), false);
  session.recordToolResult({ server: 'workspace', tool: 'curl_local_api' }, {},
    'Local API check PASSED: GET http://localhost:3000/todos returned HTTP 200.');
  assert.equal(session.recordToolResult({ server: 'workspace', tool: 'start_project_server' }, { purpose: 'frontend' },
    'Project server reported http://localhost:5173'), true);
});

test('single full-stack server connects Playwright only after its API check passes', () => {
  const session = createSession(true, 'create full stack todo app');
  assert.equal(session.recordToolResult({ server: 'workspace', tool: 'start_project_server' }, { purpose: 'frontend' },
    'Project server reported http://localhost:3000'), false);
  assert.equal(session.recordToolResult({ server: 'workspace', tool: 'curl_local_api' }, {},
    'Local API check PASSED: GET http://localhost:3000/api/todos returned HTTP 200.'), true);
});

test('a later failed test or API check invalidates earlier passing evidence', () => {
  const session = createSession(true, 'create a full stack todo app');
  const message = { content: 'Done', tool_calls: null };
  const system = { content: '' };
  session.recordToolResult({ server: 'workspace', tool: 'write_file' }, { path: 'server.js' }, 'Wrote file');
  session.recordToolResult({ server: 'workspace', tool: 'run_project_check' }, { script: 'test' },
    'Project check test PASSED.');
  session.recordToolResult({ server: 'workspace', tool: 'start_project_server' }, { purpose: 'api' },
    'Project server reported http://localhost:3000');
  session.recordToolResult({ server: 'workspace', tool: 'curl_local_api' }, {},
    'Local API check PASSED: GET http://localhost:3000/todos returned HTTP 200.');
  session.recordToolResult({ server: 'workspace', tool: 'run_project_check' }, { script: 'test' },
    'Project check test FAILED (exit 1).');
  session.recordToolResult({ server: 'workspace', tool: 'curl_local_api' }, {},
    'Local API check FAILED: GET http://localhost:3000/todos returned HTTP 500.');
  assert.deepEqual(session.beforeFinish(message, true, system).missing, [
    'run and pass the relevant project tests',
    'pass the local API smoke test',
    'run a local Playwright interaction smoke check'
  ]);
});

test('coding session does not let a curl success hide a failed unit-test suite', () => {
  const session = createSession(true);
  const message = { content: 'Done', tool_calls: null };
  const system = { content: '' };
  session.recordToolResult({ server: 'workspace', tool: 'write_file' }, { path: 'server.js' }, 'Wrote file');
  session.recordToolResult({ server: 'workspace', tool: 'run_project_check' }, { script: 'test' },
    'Project check test FAILED (exit 1).');
  session.recordToolResult({ server: 'workspace', tool: 'curl_local_api' },
    { url: 'http://127.0.0.1:3000/todos' }, 'Local API check PASSED: GET http://127.0.0.1:3000/todos returned HTTP 200.');
  assert.deepEqual(session.beforeFinish(message, true, system).missing, [
    'run and pass the relevant project tests'
  ]);
});

test('coding session invalidates checks and requests a server restart after later edits', () => {
  const session = createSession(true, 'create a full stack todo app');
  const system = { content: '' };
  const message = { content: 'Done', tool_calls: null };
  session.recordToolResult({ server: 'workspace', tool: 'write_file' }, { path: 'server.js' }, 'Wrote file');
  session.recordToolResult({ server: 'workspace', tool: 'run_project_check' }, { script: 'test' },
    'Project check test PASSED.');
  session.recordToolResult({ server: 'workspace', tool: 'start_project_server' }, { purpose: 'api' },
    'Project server reported http://localhost:3000');
  session.recordToolResult({ server: 'workspace', tool: 'curl_local_api' }, {},
    'Local API check PASSED: GET http://localhost:3000/todos returned HTTP 200.');
  session.recordToolResult({ server: 'workspace', tool: 'start_project_server' }, { purpose: 'frontend' },
    'Project server reported http://localhost:5173');
  session.recordToolResult({ server: 'coding-browser', tool: 'browser_navigate' }, { url: 'http://localhost:5173/' },
    'Page URL: http://localhost:5173/');
  session.recordToolResult({ server: 'coding-browser', tool: 'browser_click' }, {}, 'Clicked button');
  session.recordToolResult({ server: 'coding-browser', tool: 'browser_snapshot' }, {},
    'Page URL: http://localhost:5173/\nPage Title: Todo\nPage Snapshot:\n- heading "Todo"');
  assert.deepEqual(session.beforeFinish(message, true, system), { retry: false, missing: [] });

  session.recordToolResult({ server: 'workspace', tool: 'edit_file' }, { path: 'server.js' }, 'Edited file');
  assert.equal(session.takeServerRestartRequest(), true);
  assert.equal(session.takeServerRestartRequest(), false);
  assert.deepEqual(session.beforeFinish(message, false, system).missing, [
    'run and pass the relevant project tests',
    'run the local API smoke test',
    'run a local Playwright interaction smoke check'
  ]);
});

test('changing package.json invalidates the prior dependency install result', () => {
  const session = createSession(true, 'create a Node API');
  const system = { content: '' };
  const message = { content: 'Done', tool_calls: null };
  session.recordToolResult({ server: 'workspace', tool: 'write_file' }, { path: 'package.json' }, 'Wrote file');
  session.recordToolResult({ server: 'workspace', tool: 'install_project_dependencies' }, {},
    'Dependencies COMPLETED.');
  session.recordToolResult({ server: 'workspace', tool: 'edit_file' }, { path: 'package.json' }, 'Edited file');
  assert.ok(session.beforeFinish(message, true, system).missing.includes('install declared dependencies'));
});

test('tool errors do not count as completed coding changes', () => {
  const session = createSession(true, 'create a utility file');
  const message = { content: 'Done', tool_calls: null };
  session.recordToolResult({ server: 'workspace', tool: 'write_file' }, { path: 'util.js' },
    'Tool error: EACCES');
  assert.deepEqual(session.beforeFinish(message, false, { content: '' }).missing, [
    'make the requested workspace changes'
  ]);
});

test('coding session does not re-request declined install or test execution', () => {
  const session = createSession(true);
  const system = { content: '' };
  const message = { content: 'Done', tool_calls: null };
  session.recordToolResult({ server: 'workspace', tool: 'write_file' }, { path: 'package.json' }, 'Wrote file');
  session.recordToolResult({ server: 'workspace', tool: 'install_project_dependencies' }, {},
    'MCP call to "install_project_dependencies" was NOT executed — declined.');
  session.recordToolResult({ server: 'workspace', tool: 'run_project_check' }, { script: 'test' },
    'MCP call to "run_project_check" was NOT executed — declined.');
  assert.deepEqual(session.beforeFinish(message, true, system), { retry: false, missing: [] });
});

test('coding session requires a local interaction followed by a rendered snapshot', () => {
  const session = createSession(true);
  const system = { content: '' };
  const message = { content: 'Done', tool_calls: null };
  session.recordToolResult({ server: 'workspace', tool: 'write_file' }, { path: 'index.html' }, 'Wrote file');
  session.recordToolResult({ server: 'workspace', tool: 'run_project_check' }, { script: 'test' },
    'Project check NOT CONFIGURED: no package.json.');
  session.recordToolResult({ server: 'workspace', tool: 'start_project_server' }, {},
    'Project server reported http://localhost:3000');
  session.recordToolResult({ server: 'coding-browser', tool: 'browser_snapshot' }, {},
    'Page URL: about:blank');
  assert.deepEqual(session.beforeFinish(message, true, system).missing, ['run a local Playwright interaction smoke check']);
  session.recordToolResult({ server: 'coding-browser', tool: 'browser_navigate' }, { url: 'http://localhost:3000/' },
    'Page URL: http://localhost:3000/');
  session.recordToolResult({ server: 'coding-browser', tool: 'browser_snapshot' }, {},
    'Page URL: http://localhost:3000/\nPage Title: Todo\nPage Snapshot:\n- heading "Todo"');
  assert.deepEqual(session.beforeFinish(message, true, system).missing, ['run a local Playwright interaction smoke check']);
  session.recordToolResult({ server: 'coding-browser', tool: 'browser_click' }, {}, 'Clicked button');
  session.recordToolResult({ server: 'coding-browser', tool: 'browser_snapshot' }, {},
    'Page URL: http://localhost:3000/\nPage Title: Todo\nPage Snapshot:\n- heading "Todo"');
  assert.deepEqual(session.beforeFinish(message, true, system), { retry: false, missing: [] });
});

test('Playwright console errors block success until code changes and a clean interaction reruns', () => {
  const session = createSession(true, 'create a frontend todo page');
  const message = { content: 'Done', tool_calls: null };
  const system = { content: '' };
  session.recordToolResult({ server: 'workspace', tool: 'write_file' }, { path: 'index.html' }, 'Wrote file');
  session.recordToolResult({ server: 'workspace', tool: 'start_project_server' }, { purpose: 'frontend' },
    'Project server reported http://127.0.0.1:3000');
  session.recordToolResult({ server: 'coding-browser', tool: 'browser_navigate' }, { url: 'http://127.0.0.1:3000/' },
    'Page URL: http://127.0.0.1:3000/');
  session.recordToolResult({ server: 'coding-browser', tool: 'browser_click' }, {}, 'Clicked button');
  session.recordToolResult({ server: 'coding-browser', tool: 'browser_snapshot' }, {},
    'Page URL: http://127.0.0.1:3000/\nPage Title: Todo\nConsole: 1 errors, 0 warnings');
  assert.deepEqual(session.beforeFinish(message, true, system).missing, [
    'fix local browser/network errors and rerun the Playwright interaction smoke check'
  ]);

  session.recordToolResult({ server: 'workspace', tool: 'edit_file' }, { path: 'app.js' }, 'Edited file');
  session.recordToolResult({ server: 'coding-browser', tool: 'browser_navigate' }, { url: 'http://127.0.0.1:3000/' },
    'Page URL: http://127.0.0.1:3000/');
  session.recordToolResult({ server: 'coding-browser', tool: 'browser_click' }, {}, 'Clicked button');
  session.recordToolResult({ server: 'coding-browser', tool: 'browser_snapshot' }, {},
    'Page URL: http://127.0.0.1:3000/\nPage Title: Todo\nConsole: 0 errors, 0 warnings\nPage Snapshot:\n- button "Add todo"');
  assert.deepEqual(session.beforeFinish(message, true, system), { retry: false, missing: [] });
});

test('a failed Playwright locator invalidates prior interaction evidence', () => {
  const session = createSession(true, 'create a frontend todo page');
  const message = { content: 'Done', tool_calls: null };
  const system = { content: '' };
  session.recordToolResult({ server: 'workspace', tool: 'write_file' }, { path: 'index.html' }, 'Wrote file');
  session.recordToolResult({ server: 'workspace', tool: 'start_project_server' }, { purpose: 'frontend' },
    'Project server reported http://localhost:3000');
  session.recordToolResult({ server: 'coding-browser', tool: 'browser_navigate' }, { url: 'http://localhost:3000/' },
    'Page URL: http://localhost:3000/');
  session.recordToolResult({ server: 'coding-browser', tool: 'browser_click' }, {}, 'Clicked button');
  session.recordToolResult({ server: 'coding-browser', tool: 'browser_fill_form' }, {},
    'Tool error: browserBackend.callTool: Unexpected token while parsing css selector');
  session.recordToolResult({ server: 'coding-browser', tool: 'browser_snapshot' }, {},
    'Page URL: http://localhost:3000/\nPage Title: Todo\nPage Snapshot:\n- button "Add todo"');
  assert.deepEqual(session.beforeFinish(message, true, system).missing, [
    'fix local browser/network errors and rerun the Playwright interaction smoke check'
  ]);

  session.recordToolResult({ server: 'coding-browser', tool: 'browser_fill_form' }, {}, 'Filled textbox "Add a new todo"');
  session.recordToolResult({ server: 'coding-browser', tool: 'browser_snapshot' }, {},
    'Page URL: http://localhost:3000/\nPage Title: Todo\nConsole: 0 errors, 0 warnings\nPage Snapshot:\n- textbox "Add a new todo"\n- text Buy milk');
  assert.deepEqual(session.beforeFinish(message, true, system), { retry: false, missing: [] });
});

test('coding session only opens Playwright after a ready server and registers its tools', async () => {
  const session = createSession(true, 'create a frontend page');
  assert.equal(session.recordToolResult({ server: 'workspace', tool: 'start_project_server' }, {},
    'Project server reported http://localhost:3000'), true);
  let updated = false;
  const system = { content: '' };
  const routes = new Map();
  const specs = [];
  const result = await session.connectBrowser({
    mcp: {
      connectCodingBrowser: async () => ({ ok: true }),
      getOpenAiTools: () => ({
        specs: [
          { function: { name: 'coding-browser__browser_navigate' } },
          { function: { name: 'coding-browser__browser_cookie_set' } }
        ],
        routes: new Map([
          ['coding-browser__browser_navigate', { server: 'coding-browser', tool: 'browser_navigate' }],
          ['coding-browser__browser_cookie_set', { server: 'coding-browser', tool: 'browser_cookie_set' }]
        ])
      })
    },
    routes, specs, system, updateTools: () => { updated = true; }
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(routes.size, 1);
  assert.equal(specs.length, 1);
  assert.ok(routes.has('coding-browser__browser_navigate'));
  assert.ok(!routes.has('coding-browser__browser_cookie_set'));
  assert.equal(updated, true);
  assert.match(system.content, /Private coding browser/);
});

test('non-coding turns do not get a coding verification gate', () => {
  const session = createSession(false);
  const message = { content: 'Answer', tool_calls: null };
  assert.deepEqual(session.beforeFinish(message, true, { content: '' }), { retry: false });
  assert.equal(session.recordToolResult({ server: 'workspace', tool: 'write_file' },
    { path: 'package.json' }, 'Wrote file'), false);
});

test('coding session gates on .gitignore when initializing a new repository or project', () => {
  const session = createSession(true, 'create new project for todolist');
  const message = { content: 'Done', tool_calls: null };
  const system = { content: '' };
  session.recordToolResult({ server: 'workspace', tool: 'write_file' }, { path: 'index.js' }, 'Wrote file');
  const gate = session.beforeFinish(message, true, system);
  assert.ok(gate.missing.includes('ensure .gitignore exists with node_modules/ and .env entries'));
  session.recordToolResult({ server: 'workspace', tool: 'write_file' }, { path: '.gitignore' }, 'node_modules/\n.env\n');
  const passedGate = session.beforeFinish(message, true, system);
  assert.ok(!passedGate.missing.includes('ensure .gitignore exists with node_modules/ and .env entries'));
});

test('coding session authorizes up to 3 local curl calls before blocking', () => {
  const session = createSession(true, 'create api server');
  const route = { server: 'workspace', tool: 'curl_local_api' };
  session.recordToolResult({ server: 'workspace', tool: 'list_directory' }, { path: '.' }, 'Listing');
  session.notePlan({ content: '**Plan**\n1. Create API.' });
  assert.equal(session.authorizeTool(route, { content: '' }, true).allowed, true);
  session.recordToolResult(route, { url: 'http://127.0.0.1:3000/todos', method: 'GET' }, 'Local API check PASSED: GET returned HTTP 200.');
  assert.equal(session.authorizeTool(route, { content: '' }, true).allowed, true);
  session.recordToolResult(route, { url: 'http://127.0.0.1:3000/todos', method: 'POST', body: '{}' }, 'Local API check PASSED: POST returned HTTP 201.');
  assert.equal(session.authorizeTool(route, { content: '' }, true).allowed, true);
  session.recordToolResult(route, { url: 'http://127.0.0.1:3000/todos/1', method: 'DELETE' }, 'Local API check PASSED: DELETE returned HTTP 204.');
  assert.equal(session.authorizeTool(route, { content: '' }, true).allowed, false);
});

test('coding session blocks repeated start_project_server on EADDRINUSE until files change', () => {
  const session = createSession(true, 'build todo api');
  const serverRoute = { server: 'workspace', tool: 'start_project_server' };
  session.recordToolResult({ server: 'workspace', tool: 'list_directory' }, { path: '.' }, 'Listing');
  session.notePlan({ content: '**Plan**\n1. Build API.' });
  assert.equal(session.authorizeTool(serverRoute, { content: '' }, true, { purpose: 'api' }).allowed, true);

  // Server fails with EADDRINUSE
  session.recordToolResult(serverRoute, { script: 'start', purpose: 'api' }, 'Project server FAILED: port already in use.\nError: listen EADDRINUSE: address already in use :::3000');

  // Next call without file changes is blocked with an informative message
  const auth = session.authorizeTool(serverRoute, { content: '' }, true, { purpose: 'api' });
  assert.equal(auth.allowed, false);
  assert.match(auth.reason, /EADDRINUSE/);

  // Missing verification does NOT force an API smoke check when server failed with port conflict
  const gate = session.beforeFinish({ content: 'Summary' }, true, { content: '' });
  assert.ok(!gate.missing?.includes('run the local API smoke test'));

  // Modifying code (e.g. changing the port in src/index.js) unblocks retrying the server
  session.recordToolResult({ server: 'workspace', tool: 'edit_file' }, { path: 'src/index.js' }, 'Updated port');
  assert.equal(session.authorizeTool(serverRoute, { content: '' }, true, { purpose: 'api' }).allowed, true);
});

test('coding session blocks repeated install_project_dependencies unless package.json changes', () => {
  const session = createSession(true, 'create a Node API');
  const installRoute = { server: 'workspace', tool: 'install_project_dependencies' };
  session.recordToolResult({ server: 'workspace', tool: 'list_directory' }, { path: '.' }, 'Listing');
  session.notePlan({ content: '**Plan**\n1. Scaffold app.' });
  session.recordToolResult({ server: 'workspace', tool: 'write_file' }, { path: 'package.json' }, 'Wrote package.json');

  // Initial install is authorized
  const firstAuth = session.authorizeTool(installRoute, { content: '' }, true, { path: '.' });
  assert.equal(firstAuth.allowed, true);

  // Install completes
  session.recordToolResult(installRoute, { path: '.' }, 'Dependencies COMPLETED.\nadded 50 packages');

  // Second install call without package.json change is blocked
  const secondAuth = session.authorizeTool(installRoute, { content: '' }, true, { path: '.' });
  assert.equal(secondAuth.allowed, false);
  assert.match(secondAuth.reason, /Dependencies are already installed/);

  // Modifying package.json allows re-installation
  session.recordToolResult({ server: 'workspace', tool: 'edit_file' }, { path: 'package.json' }, 'Added express dependency');
  const thirdAuth = session.authorizeTool(installRoute, { content: '' }, true, { path: '.' });
  assert.equal(thirdAuth.allowed, true);
});

test('reading package.json does not invalidate dependency install result', () => {
  const session = createSession(true, 'create a Node API');
  const system = { content: '' };
  const message = { content: 'Done', tool_calls: null };
  session.recordToolResult({ server: 'workspace', tool: 'write_file' }, { path: 'package.json' }, 'Wrote file');
  session.recordToolResult({ server: 'workspace', tool: 'install_project_dependencies' }, {}, 'Dependencies COMPLETED.');
  session.recordToolResult({ server: 'workspace', tool: 'read_text_file' }, { path: 'package.json' }, '{"name":"api"}');
  assert.ok(!session.beforeFinish(message, true, system).missing.includes('install declared dependencies'));
});

test('react tasks recognize frontend verification and connect Playwright on server readiness', () => {
  const session = createSession(true, 'create simple react js todo');
  const shouldConnect = session.recordToolResult(
    { server: 'workspace', tool: 'start_project_server' },
    { purpose: 'frontend', script: 'start' },
    'Project server reported http://localhost:3000\nHTTP readiness check passed.'
  );
  assert.equal(shouldConnect, true);
});



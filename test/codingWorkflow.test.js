'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  CODING_WORKFLOW_PROMPT,
  isTestFilePath,
  formatCodingPlan,
  selectCodingTools,
  isCodingToolAllowed,
  hasPlanHeading,
  isToolPayload,
  fallbackPlan,
  selectCodingBrowserTools,
  progressLabel,
  missingVerification
} = require('../src/core/coding/workflow');
const { buildTurnSystemPrompt } = require('../src/cli/turn');

test('only /coding enables the focused workflow and workspace-only MCP tools', async (t) => {
  const axios = require('axios');
  const mcp = require('../src/core/mcp');
  const specs = ['workspace__write_file', 'workspace__curl_local_api', 'tavily__search'].map((name) => ({
    type: 'function', function: { name, parameters: { type: 'object', properties: {} } }
  }));
  const routes = new Map([
    ['workspace__write_file', { server: 'workspace', tool: 'write_file' }],
    ['workspace__curl_local_api', { server: 'workspace', tool: 'curl_local_api' }],
    ['tavily__search', { server: 'tavily', tool: 'search' }]
  ]);
  t.mock.method(mcp, 'getOpenAiTools', () => ({ specs, routes }));
  t.mock.method(mcp, 'getConnections', () => []);
  const observed = { normal: 0, coding: 0, greeting: 0 };
  t.mock.method(axios, 'post', async (_url, body) => {
    const lastUserMessage = body.messages.filter((message) => message.role === 'user').at(-1)?.content;
    if (lastUserMessage === 'hi') {
      observed.greeting++;
      assert.equal(body.tools, undefined, 'a greeting should not send MCP schemas');
    } else if (/Coding task workflow/.test(body.messages[0].content)) {
      observed.coding++;
      assert.equal(body.tools, undefined, 'the initial coding plan must be tool-free');
      return { data: { choices: [{ message: { role: 'assistant', content: '**Plan**\n1. Create the requested backend files.' } }] } };
    } else {
      observed.normal++;
      const toolNames = body.tools.map((tool) => tool.function.name);
      assert.ok(toolNames.includes('tavily__search'));
      assert.ok(!toolNames.includes('workspace__curl_local_api'));
      assert.doesNotMatch(body.messages[0].content, /Coding task workflow/);
    }
    return { data: { choices: [{ message: { role: 'assistant', content: '<!doctype html>' } }] } };
  });
  const { chatTurn } = require('../src/cli/turn');
  const config = { apiKey: 'test', model: 'test', selectedSkills: [] };
  const normal = await chatTurn(config, [
    { role: 'user', content: 'create a simple backend todo api' }
  ]);
  const coding = await chatTurn(config, [
    { role: 'user', content: 'create a simple backend todo api' }
  ], undefined, undefined, undefined, undefined, { codingMode: true });
  const greeting = await chatTurn(config, [{ role: 'user', content: 'hi' }]);
  assert.equal(normal, '<!doctype html>');
  assert.match(coding, /Plan awaiting your approval/);
  assert.equal(greeting, '<!doctype html>');
  assert.ok(observed.normal > 0);
  assert.ok(observed.coding > 0);
  assert.equal(observed.greeting, 1);
});

test('coding prompts offer workspace tools without unrelated MCP schemas', () => {
  const specs = ['workspace__write_file', 'desktop-commander__write_file', 'tavily__search'].map((name) => ({
    type: 'function', function: { name }
  }));
  const routes = new Map([
    ['workspace__write_file', { server: 'workspace', tool: 'write_file' }],
    ['desktop-commander__write_file', { server: 'desktop-commander', tool: 'write_file' }],
    ['tavily__search', { server: 'tavily', tool: 'search' }]
  ]);
  assert.deepEqual(selectCodingTools(specs, routes).map((spec) => spec.function.name), [
    'workspace__write_file'
  ]);
  assert.deepEqual(selectCodingTools(specs.slice(1), new Map([...routes].slice(1))), [],
    'unrelated MCP tools are not a fallback for missing workspace tools');
});

test('selectCodingTools filters run_maven_tests unless pom.xml exists or task is Java', () => {
  const specs = ['workspace__write_file', 'workspace__run_maven_tests'].map((name) => ({
    type: 'function', function: { name }
  }));
  const routes = new Map([
    ['workspace__write_file', { server: 'workspace', tool: 'write_file' }],
    ['workspace__run_maven_tests', { server: 'workspace', tool: 'run_maven_tests' }]
  ]);
  // Non-Java task without pom.xml: excludes run_maven_tests
  assert.deepEqual(
    selectCodingTools(specs, routes, { hasPomXml: false, isJavaProject: false }).map((s) => s.function.name),
    ['workspace__write_file']
  );
  // Default (no options): excludes run_maven_tests
  assert.deepEqual(
    selectCodingTools(specs, routes).map((s) => s.function.name),
    ['workspace__write_file']
  );
  // pom.xml exists: includes run_maven_tests
  assert.deepEqual(
    selectCodingTools(specs, routes, { hasPomXml: true, isJavaProject: false }).map((s) => s.function.name),
    ['workspace__write_file', 'workspace__run_maven_tests']
  );
  // Java project requested in prompt: includes run_maven_tests
  assert.deepEqual(
    selectCodingTools(specs, routes, { hasPomXml: false, isJavaProject: true }).map((s) => s.function.name),
    ['workspace__write_file', 'workspace__run_maven_tests']
  );
});

test('plan headings accept the formats used by the coding workflow', () => {
  assert.equal(hasPlanHeading('**Plan**\n1. Create `server.js`'), true);
  assert.equal(hasPlanHeading('Plan: create `server.js`'), true);
  assert.equal(hasPlanHeading('Planning the implementation'), false);
});

test('coding plan rejects tool-shaped JSON and has a task-anchored fallback', () => {
  assert.equal(isToolPayload('{"tool":"list_directory","path":".","recursive":true}'), true);
  assert.equal(isToolPayload('**Plan**\n1. Create index.html.'), false);
  assert.match(fallbackPlan('create a simple HTML todo frontend'), /create a simple HTML todo frontend/);
});

test('coding turns may execute only tool schemas actually offered in that turn', () => {
  const offered = [
    { function: { name: 'workspace__write_file' } },
    { function: { name: 'coding-browser__browser_navigate' } }
  ];
  assert.equal(isCodingToolAllowed('workspace__write_file', offered), true);
  assert.equal(isCodingToolAllowed('coding-browser__browser_navigate', offered), true);
  assert.equal(isCodingToolAllowed('gmail__send_email', offered), false);
  assert.equal(isCodingToolAllowed('workspace__write_file', undefined), false);
});

test('coding browser exposes only the small local E2E tool set', () => {
  const specs = ['browser_navigate', 'browser_snapshot', 'browser_click', 'browser_cookie_set', 'browser_run_code_unsafe']
    .map((tool) => ({ function: { name: `coding-browser__${tool}` } }));
  const routes = new Map(specs.map((spec) => [spec.function.name, {
    server: 'coding-browser', tool: spec.function.name.split('__')[1]
  }]));
  assert.deepEqual(selectCodingBrowserTools(specs, routes).map((spec) => spec.function.name), [
    'coding-browser__browser_navigate', 'coding-browser__browser_snapshot', 'coding-browser__browser_click'
  ]);
});

test('coding progress labels show folder, file, and check steps without exposing file contents', () => {
  assert.equal(progressLabel('create_directory', { path: 'src/routes' }), 'Creating folder src/routes');
  assert.equal(progressLabel('write_file', { path: 'src/routes/todos.js', content: 'secret or code' }), 'Writing src/routes/todos.js');
  assert.equal(progressLabel('edit_file', { path: 'src/routes/todos.js' }), 'Updating src/routes/todos.js');
  assert.equal(progressLabel('run_project_check', { script: 'test:api' }), 'Running test:api checks');
  assert.equal(progressLabel('unrelated_tool', {}), null);
});

test('coding completion requires install, tests, and browser checks only when applicable', () => {
  assert.deepEqual(missingVerification({}), []);
  assert.deepEqual(missingVerification({
    installRequired: true, filesWritten: true, testsConfigured: true, serverStarted: true
  }), [
    'install declared dependencies',
    'run and pass the relevant project tests',
    'run a local Playwright interaction smoke check'
  ]);
  assert.deepEqual(missingVerification({
    installRequired: true, installed: true, filesWritten: true, testsPassed: true,
    serverStarted: true, browserSmokeChecked: true
  }), []);
});

test('coding identifies common unit-test paths without matching ordinary source files', () => {
  for (const file of ['tests/api.test.js', 'spec/app.spec.ts', 'src/test/java/UserTest.java', 'test_api.py']) {
    assert.equal(isTestFilePath(file), true, file);
  }
  for (const file of ['src/latest.js', 'src/testimonials.js', 'src/app.py']) {
    assert.equal(isTestFilePath(file), false, file);
  }
});

test('coding preflight promises a task-specific plan before tool use', () => {
  const plan = formatCodingPlan();
  assert.match(plan, /^Coding mode:/);
  assert.match(plan, /task-specific implementation plan without calling tools/i);
  assert.match(plan, /after you approve it, I’ll inspect the workspace/i);
  assert.doesNotMatch(plan, /shall I proceed/i);
});

test('coding plan instructions require task-specific files, behavior, setup, and verification', () => {
  assert.match(CODING_WORKFLOW_PROMPT, /task-specific, actionable plan—not a generic workflow summary/i);
  assert.match(CODING_WORKFLOW_PROMPT, /small file tree with each file’s purpose/i);
  assert.match(CODING_WORKFLOW_PROMPT, /implementation details and requested behavior\/endpoints/i);
  assert.match(CODING_WORKFLOW_PROMPT, /state assumptions where the existing workspace must be inspected/i);
  assert.match(CODING_WORKFLOW_PROMPT, /frontend-only tasks use Playwright, backend\/API tasks use backend tests or bounded local curl, and full-stack tasks verify APIs first then the UI in Playwright/i);
  assert.match(CODING_WORKFLOW_PROMPT, /Never use curl as a frontend\/UI test/i);
  assert.match(CODING_WORKFLOW_PROMPT, /For full-stack work, complete backend checks first, then start\/verify the frontend and use Playwright to verify the frontend-to-backend flow/i);
  assert.match(CODING_WORKFLOW_PROMPT, /wait for the separate test approval before writing them/i);
  assert.match(CODING_WORKFLOW_PROMPT, /limited to a static HTML\/CSS\/JavaScript frontend, do not assume or create an API\/backend/i);
});

test('coding instructions sequence plan, folders, setup, files, and verification', () => {
  const phases = [
    'Before any tool call, return a task-specific, actionable plan—not a generic workflow summary',
    'Stop and wait for “continue” or “do it”',
    'Once approved, inspect the workspace',
    'create missing parents before files',
    'Batch independent file writes',
    'install declared npm dependencies',
    'Before starting services, inspect package scripts and run the relevant configured unit/API tests, lint, typecheck, and build checks',
    'Start a local app with start_project_server after setup',
    'inspect browser_console_messages and browser_network_requests'
  ].map((phase) => CODING_WORKFLOW_PROMPT.toLowerCase().indexOf(phase.toLowerCase()));
  assert.ok(phases.every((index) => index >= 0));
  assert.deepEqual(phases, [...phases].sort((a, b) => a - b));
  assert.ok(CODING_WORKFLOW_PROMPT.indexOf('For full-stack work, complete backend checks first') <
    CODING_WORKFLOW_PROMPT.indexOf('use Playwright to verify the frontend-to-backend flow'));
  assert.match(CODING_WORKFLOW_PROMPT, /content must be a plain string/);
  assert.match(CODING_WORKFLOW_PROMPT, /\.env\.example/);
  assert.match(CODING_WORKFLOW_PROMPT, /always ensure the project has \.env and \.gitignore/i);
  assert.match(CODING_WORKFLOW_PROMPT, /Unit\/API test files are optional/i);
  assert.match(CODING_WORKFLOW_PROMPT, /put them in the project test directory outside src\//i);
  assert.match(CODING_WORKFLOW_PROMPT, /keep each test file minimal and focused/i);
  assert.match(CODING_WORKFLOW_PROMPT, /curl_local_api/);
  assert.match(CODING_WORKFLOW_PROMPT, /Batch independent file writes/);
  assert.match(CODING_WORKFLOW_PROMPT, /Do not repeat the same invalid call or switch to an unrelated MCP server/);
  assert.match(CODING_WORKFLOW_PROMPT, /concise \*\*Result\*\* section and a Markdown table/);
  assert.match(CODING_WORKFLOW_PROMPT, /include exact test counts\/errors and elapsed time when available/);
  assert.match(CODING_WORKFLOW_PROMPT, /Stop and wait for “continue” or “do it”/i);
  assert.match(CODING_WORKFLOW_PROMPT, /edit plan/);
});

test('coding tests are optional unless configured or the user requests them', () => {
  assert.deepEqual(missingVerification({ filesWritten: true }), []);
  assert.deepEqual(missingVerification({ filesWritten: true, testsConfigured: false }), []);
  assert.deepEqual(missingVerification({ filesWritten: true, testsConfigured: true }), [
    'run and pass the relevant project tests'
  ]);
});

test('CLI prints the coding plan before fetching tools or calling the model', () => {
  const fs = require('node:fs');
  const turn = fs.readFileSync(require.resolve('../src/cli/turn'), 'utf8');
  const plan = turn.indexOf('codingWorkflow.formatCodingPlan()');
  assert.ok(plan >= 0);
  assert.ok(plan < turn.indexOf('mcp.getOpenAiTools()', plan));
  assert.ok(plan < turn.indexOf('chatCompletion(', plan));
});

test('coding turn shows a tool-free plan before workspace inspection or changes', async (t) => {
  const axios = require('axios');
  const mcp = require('../src/core/mcp');
  const mode = require('../src/core/coding/mode');
  mode.clearPendingPlan();
  const specs = ['workspace__list_directory', 'workspace__write_file'].map((name) => ({
    type: 'function', function: { name, parameters: { type: 'object', properties: {} } }
  }));
  const routes = new Map([
    ['workspace__list_directory', { server: 'workspace', tool: 'list_directory' }],
    ['workspace__write_file', { server: 'workspace', tool: 'write_file' }]
  ]);
  t.mock.method(mcp, 'getOpenAiTools', () => ({ specs, routes }));
  t.mock.method(mcp, 'getConnections', () => []);
  let fileChanges = 0;
  let workspaceCalls = 0;
  t.mock.method(mcp, 'callTool', async (_routes, name) => {
    workspaceCalls++;
    if (name === 'workspace__write_file') fileChanges++;
    return 'Empty workspace';
  });
  let requests = 0;
  t.mock.method(axios, 'post', async (_url, body) => {
    requests++;
    assert.equal(body.tools, undefined, 'the planning request must not expose tools');
    // Providers can return a useful task-specific plan without a Plan heading.
    const message = { role: 'assistant', content: 'Create `server.js` and `package.json`, then run the available checks.' };
    return { data: { choices: [{ message }] } };
  });
  const { chatTurn } = require('../src/cli/turn');
  let streamedText = '';
  const reply = await chatTurn({ apiKey: 'test', model: 'test', selectedSkills: [] }, [
    { role: 'user', content: 'create a simple Node API' }
  ], undefined, (token) => { streamedText += token; }, undefined, undefined, { codingMode: true });
  assert.match(reply, /^\*\*Plan\*\*/);
  assert.match(reply, /Plan awaiting your approval/);
  assert.doesNotMatch(reply, /could not produce the required plan/i);
  assert.equal(fileChanges, 0);
  assert.equal(workspaceCalls, 0);
  assert.equal(requests, 1);
  assert.equal(streamedText, '', 'coding should not stream an unverified result before later tool checks');
  assert.equal(mode.getPendingPlan().task, 'create a simple Node API');
  assert.match(mode.getPendingPlan().plan, /Create `server\.js`/);
  mode.clearPendingPlan();
});

test('coding retries tool-shaped plan output and displays Markdown without executing it', async (t) => {
  const axios = require('axios');
  const mcp = require('../src/core/mcp');
  const mode = require('../src/core/coding/mode');
  mode.clearPendingPlan();
  const specs = [{ type: 'function', function: { name: 'workspace__list_directory', parameters: { type: 'object' } } }];
  const routes = new Map([['workspace__list_directory', { server: 'workspace', tool: 'list_directory' }]]);
  t.mock.method(mcp, 'getOpenAiTools', () => ({ specs, routes }));
  t.mock.method(mcp, 'getConnections', () => []);
  let toolsExecuted = 0;
  t.mock.method(mcp, 'callTool', async () => { toolsExecuted++; return 'unexpected'; });
  let requests = 0;
  t.mock.method(axios, 'post', async (_url, body) => {
    requests++;
    assert.equal(body.tools, undefined, 'planning and plan-recovery requests must not offer tools');
    if (requests === 1) {
      return { data: { choices: [{ message: { role: 'assistant', content: '{"tool":"list_directory","path":".","recursive":true}' } }] } };
    }
    assert.match(body.messages.at(-1).content, /JSON\/tool payload, not a plan/);
    return { data: { choices: [{ message: { role: 'assistant', content:
      '**Plan**\n\n1. **Project structure**\n   - `index.html` — todo interface and behavior.\n2. Implement add, complete, and delete actions.\n3. No dependencies; verify the UI with a local Playwright interaction.' } }] } };
  });
  const { chatTurn } = require('../src/cli/turn');
  const reply = await chatTurn({ apiKey: 'test', model: 'test', selectedSkills: [] }, [
    { role: 'user', content: 'create a simple html frontend for todo application' }
  ], undefined, undefined, undefined, undefined, { codingMode: true });
  assert.match(reply, /^\*\*Plan\*\*/);
  assert.match(reply, /`index\.html`/);
  assert.match(reply, /Plan awaiting your approval/);
  assert.doesNotMatch(reply, /"tool"\s*:/);
  assert.equal(requests, 2);
  assert.equal(toolsExecuted, 0);
  mode.clearPendingPlan();
});

test('coding guidance is conditional', () => {
  const config = { selectedSkills: [] };
  const base = buildTurnSystemPrompt(config, [], {
    workspaceConnected: true, browserConnected: false, computerConnected: false
  });
  const coding = buildTurnSystemPrompt(config, [], {
    workspaceConnected: true, browserConnected: false, computerConnected: false, codingTask: true
  });
  assert.doesNotMatch(base, /Coding task workflow/);
  assert.match(coding, /Coding task workflow/);
});

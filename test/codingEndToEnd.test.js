'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const codingMode = require('../src/core/coding/mode');
const codingWorkflow = require('../src/core/coding/workflow');
const { createSession } = require('../src/core/coding/session');
const runner = require('../src/core/coding/runner');

test('E2E: complete react todo workflow simulation', async (t) => {
  // 1. Enable coding mode
  if (!codingMode.isEnabled()) codingMode.toggle();
  assert.equal(codingMode.isEnabled(), true);

  // 2. Initial planning turn for "create a simple react todo"
  const userTask = 'create simple react todo';
  const session = createSession(true, userTask, false);

  // Verify taskTargets detects frontend browser requirement for "react todo"
  // Even though it doesn't say "frontend", it says "react" and "todo"
  const serverRoute = { server: 'workspace', tool: 'start_project_server' };
  const installRoute = { server: 'workspace', tool: 'install_project_dependencies' };
  const readRoute = { server: 'workspace', tool: 'read_text_file' };
  const writeRoute = { server: 'workspace', tool: 'write_file' };

  // Planning phase: changes are blocked before plan is shown and workspace inspected
  const beforePlan = session.authorizeTool(writeRoute, { content: 'hello' }, false, { path: 'App.jsx' });
  assert.equal(beforePlan.allowed, false);
  assert.match(beforePlan.reason, /Inspect the workspace first/);

  // Set plan
  const planMarkdown = '**Plan**\n\n1. Scaffold Vite+React todo app\n2. Implement TodoList, TodoItem\n3. Verify with Playwright';
  codingMode.setPendingPlan({ task: userTask, plan: planMarkdown });
  session.notePlan({ content: planMarkdown }, false);

  // Approve plan with "continue"
  const decision = codingMode.decidePendingPlan('continue');
  assert.equal(decision.action, 'approve');
  assert.equal(decision.plan.task, userTask);

  // 3. Execution phase with approved plan
  const approvedSession = createSession(true, userTask, true);

  // Inspection
  approvedSession.recordToolResult({ server: 'workspace', tool: 'list_directory' }, { path: '.' }, '[]');
  assert.equal(approvedSession.hasInspectedWorkspace(), true);

  // File writes
  const fileAuth = approvedSession.authorizeTool(writeRoute, { content: '' }, true, { path: 'todo-react/package.json' });
  assert.equal(fileAuth.allowed, true);

  approvedSession.recordToolResult(writeRoute, { path: 'todo-react/package.json' }, 'Wrote todo-react/package.json');
  approvedSession.recordToolResult(writeRoute, { path: 'todo-react/src/App.jsx' }, 'Wrote todo-react/src/App.jsx');
  approvedSession.recordToolResult(writeRoute, { path: 'todo-react/.gitignore' }, 'Wrote .gitignore');

  // Dependencies installation
  const firstInstallAuth = approvedSession.authorizeTool(installRoute, { content: '' }, true, { path: 'todo-react' });
  assert.equal(firstInstallAuth.allowed, true);

  approvedSession.recordToolResult(
    installRoute,
    { path: 'todo-react' },
    'Dependencies COMPLETED.\nnpm warn deprecated inflight@1.0.6: This module is not supported'
  );

  // 4. Verify duplicate install is intercepted and blocked
  const duplicateInstallAuth = approvedSession.authorizeTool(installRoute, { content: '' }, true, { path: 'todo-react' });
  assert.equal(duplicateInstallAuth.allowed, false);
  assert.match(duplicateInstallAuth.reason, /Dependencies are already installed/);

  // 5. Verify reading package.json DOES NOT reset installed state
  approvedSession.recordToolResult(readRoute, { path: 'todo-react/package.json' }, '{"name":"todo-react","scripts":{"start":"vite"}}');
  const gateCheck = approvedSession.beforeFinish({ content: 'Done' }, true, { content: '' });
  assert.ok(
    !gateCheck.missing?.includes('install declared dependencies'),
    'Reading package.json must not mark dependencies as uninstalled'
  );

  // 6. Verify start_project_server with command/script normalization
  // Simulated frontend server start reporting localhost URL
  const shouldConnectBrowser = approvedSession.recordToolResult(
    serverRoute,
    { command: 'npm start', port: '3000', purpose: 'frontend', path: 'todo-react' },
    'Project server reported http://localhost:3000\nHTTP readiness check passed.'
  );

  // Playwright connection MUST be triggered because purpose is frontend and task is React
  assert.equal(shouldConnectBrowser, true, 'Playwright browser connection must be triggered for react frontend');

  // 7. Verify Playwright interactions record smoke check pass
  approvedSession.recordToolResult(
    { server: 'coding-browser', tool: 'browser_navigate' },
    { url: 'http://localhost:3000' },
    'Page URL: http://localhost:3000'
  );
  approvedSession.recordToolResult(
    { server: 'coding-browser', tool: 'browser_type' },
    { locator: 'input', text: 'Buy groceries' },
    'Typed "Buy groceries"'
  );
  approvedSession.recordToolResult(
    { server: 'coding-browser', tool: 'browser_click' },
    { locator: 'button' },
    'Clicked "Add"'
  );
  approvedSession.recordToolResult(
    { server: 'coding-browser', tool: 'browser_snapshot' },
    {},
    'Page URL: http://localhost:3000\nPage Title: React Todo\n- generic [heading]: "Todo List"\n- textbox\n- button: "Add"\n- paragraph: "Buy groceries"'
  );

  // Verify completion gate cleanly passes with no missing items
  const finalCheck = approvedSession.beforeFinish({ content: 'MERN todo completed successfully' }, false, { content: '' });
  assert.deepEqual(finalCheck.missing, [], 'All verification gates must be satisfied for MERN workflow');

  codingMode.clearPendingPlan();
});

test('E2E: interrupted coding workflow resumes cleanly without generating generic plan for "continue"', async () => {
  if (!codingMode.isEnabled()) codingMode.toggle();
  assert.equal(codingMode.isEnabled(), true);

  const userTask = 'create a simple mern todo';
  const planMarkdown = '**Plan**\n\n1. Scaffold backend (Express) and frontend (React)\n2. Implement CRUD\n3. Verify';
  codingMode.setPendingPlan({ task: userTask, plan: planMarkdown });

  // 1. Initial approval
  const decision = codingMode.decidePendingPlan('continue');
  assert.equal(decision.action, 'approve');

  // 2. Partial execution before interruption
  const session1 = createSession(true, userTask, true);
  session1.recordToolResult({ server: 'workspace', tool: 'write_file' }, { path: 'mern-todo/backend/.gitignore' }, 'Successfully wrote to mern-todo/backend/.gitignore');

  // 3. Turn is interrupted (e.g. model timeout after 60s)
  codingMode.markInterrupted();
  assert.equal(codingMode.hasInterruptedPlan(), true);

  // 4. User types "continue"
  const resumeDecision = codingMode.decidePendingPlan('continue');
  assert.equal(resumeDecision.action, 'resume');
  assert.equal(resumeDecision.plan.task, userTask);
  // Crucial: it must NOT generate a fallback plan for "continue"
  assert.notEqual(resumeDecision.plan.task, 'continue');

  // 5. Resumed execution continues the active plan with approvedPlan=true
  const session2 = createSession(true, resumeDecision.plan.task, true);
  session2.recordToolResult({ server: 'workspace', tool: 'write_file' }, { path: 'mern-todo/backend/server.js' }, 'Wrote server.js');
  session2.recordToolResult({ server: 'workspace', tool: 'write_file' }, { path: 'mern-todo/backend/package.json' }, 'Wrote package.json');
  session2.recordToolResult({ server: 'workspace', tool: 'install_project_dependencies' }, { projectPath: 'mern-todo/backend' }, 'Dependencies COMPLETED.');
  session2.recordToolResult({ server: 'workspace', tool: 'run_project_check' }, { script: 'test', projectPath: 'mern-todo/backend' }, 'PASSED');

  codingMode.markCompleted();
  assert.equal(codingMode.hasInterruptedPlan(), false);
  codingMode.clearAll();
});

test('E2E: complete MERN todo full-stack workflow simulation without terminal block', async (t) => {
  if (!codingMode.isEnabled()) codingMode.toggle();
  assert.equal(codingMode.isEnabled(), true);

  const userTask = 'create a simple mern todo';
  const planMarkdown = '**Plan**\n\n1. Scaffold backend (Express) and frontend (React)\n2. Implement CRUD\n3. Verify backend with curl and frontend with Playwright';
  codingMode.setPendingPlan({ task: userTask, plan: planMarkdown });

  // Approve plan with "continue"
  const decision = codingMode.decidePendingPlan('continue');
  assert.equal(decision.action, 'approve');

  // Execution phase
  const approvedSession = createSession(true, userTask, true);
  const serverRoute = { server: 'workspace', tool: 'start_project_server' };
  const installRoute = { server: 'workspace', tool: 'install_project_dependencies' };
  const writeRoute = { server: 'workspace', tool: 'write_file' };
  const checkRoute = { server: 'workspace', tool: 'run_project_check' };
  const curlRoute = { server: 'workspace', tool: 'curl_local_api' };

  // Inspect
  approvedSession.recordToolResult({ server: 'workspace', tool: 'list_directory' }, { path: '.' }, '[]');
  assert.equal(approvedSession.hasInspectedWorkspace(), true);

  // Nested file writes (backend + frontend)
  approvedSession.recordToolResult(writeRoute, { path: 'mern-todo/backend/package.json' }, 'Wrote backend package.json');
  approvedSession.recordToolResult(writeRoute, { path: 'mern-todo/backend/server.js' }, 'Wrote backend server.js');
  approvedSession.recordToolResult(writeRoute, { path: 'mern-todo/backend/test/api.test.js' }, 'Wrote backend test');
  approvedSession.recordToolResult(writeRoute, { path: 'mern-todo/frontend/package.json' }, 'Wrote frontend package.json');
  approvedSession.recordToolResult(writeRoute, { path: 'mern-todo/frontend/src/App.js' }, 'Wrote frontend App.js');

  // Install dependencies using projectPath alias
  const backendInstallAuth = approvedSession.authorizeTool(installRoute, { content: '' }, true, { projectPath: 'mern-todo/backend' });
  assert.equal(backendInstallAuth.allowed, true);
  approvedSession.recordToolResult(installRoute, { projectPath: 'mern-todo/backend' }, 'Dependencies COMPLETED.');

  // Frontend dependencies install must be allowed even after backend installed
  const frontendInstallAuth = approvedSession.authorizeTool(installRoute, { content: '' }, true, { projectPath: 'mern-todo/frontend' });
  assert.equal(frontendInstallAuth.allowed, true, 'Frontend install must not be blocked by prior backend install');
  approvedSession.recordToolResult(installRoute, { projectPath: 'mern-todo/frontend' }, 'Dependencies COMPLETED.');

  // But duplicate frontend install should be blocked
  const duplicateFrontendAuth = approvedSession.authorizeTool(installRoute, { content: '' }, true, { projectPath: 'mern-todo/frontend' });
  assert.equal(duplicateFrontendAuth.allowed, false, 'Duplicate frontend install should be blocked');
  assert.match(duplicateFrontendAuth.reason, /Dependencies are already installed/);

  // Run backend unit test using projectPath alias
  const backendCheckAuth = approvedSession.authorizeTool(checkRoute, { content: '' }, true, { script: 'test', projectPath: 'mern-todo/backend' });
  assert.equal(backendCheckAuth.allowed, true);
  approvedSession.recordToolResult(checkRoute, { script: 'test', projectPath: 'mern-todo/backend' }, 'Project check test PASSED.\n1 passing');

  // Start backend server
  approvedSession.recordToolResult(
    serverRoute,
    { script: 'start', purpose: 'api', projectPath: 'mern-todo/backend' },
    'Project server reported http://localhost:5000\nHTTP readiness check passed.'
  );

  // Curl local API smoke test
  approvedSession.recordToolResult(
    curlRoute,
    { url: 'http://localhost:5000/api/health' },
    'Local API check PASSED: GET http://localhost:5000/api/health returned HTTP 200.'
  );

  // Start frontend server
  const shouldConnectBrowser = approvedSession.recordToolResult(
    serverRoute,
    { command: 'npm start', purpose: 'frontend', projectPath: 'mern-todo/frontend' },
    'Project server reported http://localhost:3000\nHTTP readiness check passed.'
  );
  assert.equal(shouldConnectBrowser, true, 'Frontend server readiness triggers Playwright');

  // Playwright E2E interactions
  approvedSession.recordToolResult(
    { server: 'coding-browser', tool: 'browser_navigate' },
    { url: 'http://localhost:3000' },
    'Page URL: http://localhost:3000'
  );
  approvedSession.recordToolResult(
    { server: 'coding-browser', tool: 'browser_type' },
    { locator: 'input', text: 'MERN task' },
    'Typed "MERN task"'
  );
  approvedSession.recordToolResult(
    { server: 'coding-browser', tool: 'browser_click' },
    { locator: 'button' },
    'Clicked "Add"'
  );
  approvedSession.recordToolResult(
    { server: 'coding-browser', tool: 'browser_snapshot' },
    {},
    'Page URL: http://localhost:3000\nPage Title: MERN Todo\n- textbox\n- button: "Add"\n- paragraph: "MERN task"'
  );

  // Verify completion gate cleanly passes with no missing items
  const finalCheck = approvedSession.beforeFinish({ content: 'MERN todo completed successfully' }, false, { content: '' });
  assert.deepEqual(finalCheck.missing, [], 'All verification gates must be satisfied for MERN workflow');

  codingMode.clearPendingPlan();
});

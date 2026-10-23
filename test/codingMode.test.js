'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const mode = require('../src/core/coding/mode');
const commands = require('../src/cli/commands');
const { renderFooter } = require('../src/cli/ui/input');

test('/coding toggles focused mode and the command is registered', async () => {
  if (mode.isEnabled()) mode.toggle();
  assert.equal(commands.COMMANDS['/coding'], commands.handleCoding);
  const originalLog = console.log;
  console.log = () => {};
  try {
    await commands.handleCoding();
    assert.equal(mode.isEnabled(), true);
    await commands.handleCoding();
    assert.equal(mode.isEnabled(), false);
  } finally {
    console.log = originalLog;
    if (mode.isEnabled()) mode.toggle();
  }
});

test('coding plan requires explicit approval, supports edits, and clears on cancel', () => {
  mode.setPendingPlan({ task: 'create todo app', plan: '**Plan**\n1. Create files.' });
  assert.deepEqual(mode.decidePendingPlan('edit plan: add API tests'), {
    action: 'edit', plan: { task: 'create todo app', plan: '**Plan**\n1. Create files.' },
    instruction: 'add API tests'
  });
  assert.equal(mode.getPendingPlan().task, 'create todo app', 'editing keeps the draft pending');
  assert.equal(mode.decidePendingPlan('continue').action, 'approve');
  assert.equal(mode.getPendingPlan(), null);
  mode.setPendingPlan({ task: 'create todo app', plan: 'Plan: create files' });
  assert.equal(mode.decidePendingPlan('cancel').action, 'cancel');
  assert.equal(mode.getPendingPlan(), null);
});

test('footer shows @codeMode only while coding mode is supplied', () => {
  const stdout = { columns: 100 };
  assert.match(renderFooter({ modeTag: '@codeMode' }, stdout), /@codeMode/);
  assert.doesNotMatch(renderFooter({}, stdout), /@codeMode/);
});

test('interrupted coding plan resumes on continue/retry without generating a new plan', () => {
  mode.clearAll();
  mode.setPendingPlan({ task: 'create mern todo', plan: '**Plan**\n1. Scaffold backend\n2. Scaffold frontend' });

  // 1. Initial approval
  const approved = mode.decidePendingPlan('continue');
  assert.equal(approved.action, 'approve');
  assert.equal(mode.getActivePlan().task, 'create mern todo');
  assert.equal(mode.getActivePlan().status, 'in_progress');

  // 2. An error or timeout interrupts execution
  mode.markInterrupted();
  assert.equal(mode.hasInterruptedPlan(), true);

  // 3. User types "continue" after error: resumes the existing plan, does not re-plan
  const resumed = mode.decidePendingPlan('continue');
  assert.equal(resumed.action, 'resume');
  assert.equal(resumed.plan.task, 'create mern todo');

  // 4. Another error occurs, user types guidance: "retry with port 5001"
  mode.markInterrupted();
  const retryWithGuidance = mode.decidePendingPlan('retry with port 5001');
  assert.equal(retryWithGuidance.action, 'resume');
  assert.equal(retryWithGuidance.userGuidance, 'retry with port 5001');

  // 5. Completion marks it completed so subsequent inputs do not resume
  mode.markCompleted();
  assert.equal(mode.hasInterruptedPlan(), false);
  assert.equal(mode.decidePendingPlan('continue'), null);
});

test('scanWorkspaceCodebase captures existing files and npm scripts for context-aware planning', async () => {
  const { scanWorkspaceCodebase } = require('../src/core/coding/workspaceScan');
  const scan = await scanWorkspaceCodebase('.');
  assert.match(scan, /Existing workspace codebase context/);
  assert.match(scan, /package\.json/);
  assert.match(scan, /Root npm scripts/);
  assert.match(scan, /Instructions for planning/);
});

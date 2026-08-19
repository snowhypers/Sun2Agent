// Test suite for the HITL MCP approval gate. Run with: npm test
//
// Uses node:test + node:assert, matching the style of the existing suites.
// The interactive TTY prompt is not exercised here — it needs a real terminal.

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('path');

const hitl = require('../src/HITL/mcpApproval');

test('HITL: approval gate is enabled by default', () => {
  assert.strictEqual(hitl.isEnabled(), true);
});

test('HITL: disabled config bypasses approval without touching stdin', async () => {
  const ok = await hitl.checkApproval({
    server: 'filesystem',
    tool: 'read_file',
    args: { path: '/tmp/secret.txt' },
    enabled: false
  });
  assert.strictEqual(ok, true);
});

test('HITL: auto-approves on non-interactive stdin (no one to ask)', async () => {
  const ok = await hitl.checkApproval({
    server: 'filesystem',
    tool: 'write_file',
    args: { path: '/tmp/out.txt', content: 'x'.repeat(5000) }
  });
  assert.strictEqual(ok, true);
});

test('HITL: one decision covers every MCP call within a prompt', async () => {
  hitl.startPrompt();
  let calls = 0;
  const fakePrompt = async () => {
    calls++;
    return true;
  };
  const first = await hitl.checkApproval({ server: 'fs', tool: 'read_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(first, true);
  // Follow-up / retry call — even a different server or tool: no re-asking.
  const second = await hitl.checkApproval({ server: 'other', tool: 'write_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(second, true);
  assert.strictEqual(calls, 1);
});

test('HITL: a new prompt resets the decision and asks again', async () => {
  hitl.startPrompt();
  let calls = 0;
  const fakePrompt = async () => {
    calls++;
    return true;
  };
  await hitl.checkApproval({ server: 'fs', tool: 'read_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(calls, 1);
  // Next user prompt: approval starts clean.
  hitl.startPrompt();
  await hitl.checkApproval({ server: 'fs', tool: 'read_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(calls, 2);
});

test('HITL: a denied decision blocks every MCP call for the prompt, then resets', async () => {
  hitl.startPrompt();
  let calls = 0;
  const fakePrompt = async () => {
    calls++;
    return false;
  };
  const first = await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(first, false);
  assert.strictEqual(hitl.isApproved('fs', 'write_file'), false);
  // Rest of the prompt: denied without asking again.
  const second = await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(second, false);
  assert.strictEqual(calls, 1);
  // Next prompt asks again.
  hitl.startPrompt();
  await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(calls, 2);
});
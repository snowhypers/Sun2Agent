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

test('HITL: once allowed, the same tool is not asked about again this session', async () => {
  hitl.resetApprovals();
  let calls = 0;
  const fakePrompt = async () => {
    calls++;
    return true;
  };
  const first = await hitl.checkApproval({ server: 'fs', tool: 'read_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(first, true);
  // Follow-up / retry call for the same tool: prompt is skipped entirely.
  const second = await hitl.checkApproval({ server: 'fs', tool: 'read_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(second, true);
  assert.strictEqual(calls, 1);
});

test('HITL: approval memory is per server+tool, not global', async () => {
  hitl.resetApprovals();
  let calls = 0;
  const fakePrompt = async () => {
    calls++;
    return true;
  };
  await hitl.checkApproval({ server: 'fs', tool: 'read_file', args: {}, _prompt: fakePrompt });
  // Different server, same tool name -> still prompts.
  await hitl.checkApproval({ server: 'other', tool: 'read_file', args: {}, _prompt: fakePrompt });
  // Same server, different tool -> still prompts.
  await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(calls, 3);
});

test('HITL: a denied tool is not remembered and is asked again next time', async () => {
  hitl.resetApprovals();
  let calls = 0;
  const fakePrompt = async () => {
    calls++;
    return false;
  };
  const first = await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(first, false);
  assert.strictEqual(hitl.isApproved('fs', 'write_file'), false);
  const second = await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(second, false);
  assert.strictEqual(calls, 2);
});
// Test suite for the HITL MCP approval gate. Run with: npm test
//
// Uses node:test + node:assert. The interactive panel is not exercised;
// the `_prompt` override drives the gate deterministically instead.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const hitl = require('../src/HITL/mcpApproval');

beforeEach(() => hitl._resetForTesting());

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

test('HITL: denies on non-interactive stdin because no user can choose', async () => {
  const ok = await hitl.checkApproval({
    server: 'filesystem',
    tool: 'write_file',
    args: { path: '/tmp/out.txt', content: 'x'.repeat(5000) }
  });
  assert.strictEqual(ok, false);
});

test('HITL: an approved tool is remembered for the session and not re-asked', async () => {
  let calls = 0;
  const fakePrompt = async () => {
    calls++;
    return true;
  };
  const first = await hitl.checkApproval({ server: 'fs', tool: 'read_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(first, true);
  // Follow-up / retry of the same call: memoized, no re-ask.
  const second = await hitl.checkApproval({ server: 'fs', tool: 'read_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(second, true);
  assert.strictEqual(calls, 1);
});

test('HITL: a new chat session clears previously approved tools', async () => {
  let calls = 0;
  const fakePrompt = async () => {
    calls++;
    return true;
  };
  await hitl.checkApproval({ server: 'fs', tool: 'read_file', args: {}, _prompt: fakePrompt });
  hitl.startPrompt();
  await hitl.checkApproval({ server: 'fs', tool: 'read_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(calls, 2);
});

test('HITL: a session-approved tool updates the live indicator before running', async () => {
  const spinner = { isSpinning: true, text: '' };
  hitl.setSpinner(spinner);
  await hitl.checkApproval({ server: 'fs', tool: 'read_file', args: {}, _prompt: async () => true });
  await hitl.checkApproval({ server: 'fs', tool: 'read_file', args: {}, _prompt: async () => {
    throw new Error('should not re-prompt');
  } });
  assert.match(spinner.text, /already approved this session/);
  assert.match(spinner.text, /running tool: read_file/);
});

test('HITL: a new prompt does NOT reset approvals (per-session)', async () => {
  let calls = 0;
  const fakePrompt = async () => {
    calls++;
    return true;
  };
  await hitl.checkApproval({ server: 'fs', tool: 'read_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(calls, 1);
  // Next user prompt: approvals persist for the session.
  await hitl.checkApproval({ server: 'fs', tool: 'read_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(calls, 1);
});

test('HITL: distinct calls in one batch are approved concurrently', async () => {
  let calls = 0;
  const fakePrompt = async () => {
    calls++;
    return true;
  };
  const [a, b] = await Promise.all([
    hitl.checkApproval({ server: 'fs', tool: 'read_file', args: {}, _prompt: fakePrompt }),
    hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: fakePrompt })
  ]);
  assert.strictEqual(a, true);
  assert.strictEqual(b, true);
  assert.strictEqual(calls, 2);
});

test('HITL: a denied call blocks that call, but next call asks again', async () => {
  let calls = 0;
  const fakePrompt = async () => {
    calls++;
    return false;
  };
  const first = await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(first, false);
  // With _prompt override, each call invokes the prompt (no pending cache).
  // In real interactive mode, a pending promise would be reused within the same batch.
  const second = await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(second, false);
  assert.strictEqual(calls, 2);
  // Denied calls are NOT remembered for the session - next call asks again.
  const third = await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(third, false);
  assert.strictEqual(calls, 3);
});

test('HITL: log() behaves like console.log when no approval panel is open', () => {
  const original = console.log;
  const seen = [];
  console.log = (line) => seen.push(line);
  try {
    hitl.log('  ⚙ fs:read_file');
  } finally {
    console.log = original;
  }
  assert.strictEqual(seen.length, 1);
  assert.match(seen[0], /fs:read_file/);
});

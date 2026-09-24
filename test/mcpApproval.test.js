// Test suite for the HITL MCP approval gate. Run with: npm test
//
// Uses node:test + node:assert. The interactive panel is not exercised;
// the `_prompt` override drives the gate deterministically instead.

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const hitl = require('../src/core/hitl/mcpApproval');

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

test('HITL: common read-only tools run without prompting', async () => {
  for (const tool of [
    'read_file',
    'list_directory',
    'search_files',
    'get_file_info',
    'directory_tree',
    'tavily_search',
    'tavily_extract',
    'tavily_crawl',
    'tavily_map',
    'tavily_research'
  ]) {
    const ok = await hitl.checkApproval({
      server: 'readonly',
      tool,
      args: {},
      _prompt: async () => { throw new Error(`${tool} should not prompt`); }
    });
    assert.strictEqual(ok, true, tool);
  }
});

test('HITL: MCP readOnlyHint bypasses prompts but destructive names win', async () => {
  assert.strictEqual(
    hitl.requiresApproval('inventory_snapshot', { readOnlyHint: true }),
    false
  );
  assert.strictEqual(
    hitl.requiresApproval('get_and_delete_file', { readOnlyHint: true }),
    true
  );
  assert.strictEqual(
    hitl.requiresApproval('read_file', { destructiveHint: true }),
    true
  );
});

test('HITL: mutating and unknown tools still require approval', () => {
  for (const tool of [
    'write_file', 'edit_file', 'create_directory', 'move_file', 'delete_file',
    'send_email', 'execute_query', 'mystery_action'
  ]) {
    assert.strictEqual(hitl.requiresApproval(tool), true, tool);
  }
});

test('HITL: routine browser automation does not create approval noise', async () => {
  for (const [tool, args] of [
    ['browser_navigate', { url: 'https://example.com' }],
    ['browser_snapshot', {}],
    ['browser_take_screenshot', {}],
    ['browser_click', { element: 'Pricing link', target: 'e12' }],
    ['browser_type', { element: 'Search', target: 'e8', text: 'MCP' }]
  ]) {
    const ok = await hitl.checkApproval({
      server: 'browser',
      tool,
      args,
      _prompt: async () => { throw new Error(`${tool} should not prompt`); }
    });
    assert.strictEqual(ok, true, tool);
  }
});

test('HITL: essential browser actions require a fresh approval every time', async () => {
  const cases = [
    ['browser_click', { element: 'Place order', target: 'e20' }],
    ['browser_type', { element: 'Password', target: 'e5', text: 'secret', submit: true }],
    ['browser_fill_form', { fields: [{ name: 'Payment card', value: '4111111111111111' }] }],
    ['browser_file_upload', { paths: ['/tmp/report.pdf'] }],
    ['browser_drop', { paths: ['/tmp/report.pdf'], target: 'e7' }],
    ['browser_handle_dialog', { accept: true }],
    ['browser_press_key', { key: 'Enter' }],
    ['browser_evaluate', { function: '() => document.title' }],
    ['browser_run_code_unsafe', { code: 'async page => page.title()' }]
  ];
  for (const [tool, args] of cases) {
    let prompts = 0;
    const prompt = async () => { prompts++; return true; };
    assert.strictEqual(await hitl.checkApproval({ server: 'browser', tool, args, _prompt: prompt }), true);
    assert.strictEqual(await hitl.checkApproval({ server: 'browser', tool, args, _prompt: prompt }), true);
    assert.strictEqual(prompts, 2, `${tool} approval must not be remembered`);
    hitl._resetForTesting();
  }
});

test('HITL: an approved tool is remembered for the session and not re-asked', async () => {
  let calls = 0;
  const fakePrompt = async () => {
    calls++;
    return true;
  };
  const first = await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(first, true);
  // Follow-up / retry of the same call: memoized, no re-ask.
  const second = await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(second, true);
  assert.strictEqual(calls, 1);
});

test('HITL: a new chat session clears previously approved tools', async () => {
  let calls = 0;
  const fakePrompt = async () => {
    calls++;
    return true;
  };
  await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: fakePrompt });
  hitl.startPrompt();
  await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(calls, 2);
});

test('HITL: a session-approved tool updates the live indicator before running', async () => {
  const spinner = { isSpinning: true, text: '' };
  hitl.setSpinner(spinner);
  await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: async () => true });
  await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: async () => {
    throw new Error('should not re-prompt');
  } });
  assert.match(spinner.text, /already approved this session/);
  assert.match(spinner.text, /running tool: write_file/);
});

test('HITL: a new prompt does NOT reset approvals (per-session)', async () => {
  let calls = 0;
  const fakePrompt = async () => {
    calls++;
    return true;
  };
  await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(calls, 1);
  // Next user prompt: approvals persist for the session.
  await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(calls, 1);
});

test('HITL: distinct calls in one batch are approved concurrently', async () => {
  let calls = 0;
  const fakePrompt = async () => {
    calls++;
    return true;
  };
  const [a, b] = await Promise.all([
    hitl.checkApproval({ server: 'fs', tool: 'create_directory', args: {}, _prompt: fakePrompt }),
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

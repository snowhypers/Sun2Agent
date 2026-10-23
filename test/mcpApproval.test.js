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
    tool: 'delete_file',
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
    'tavily_research',
    'firecrawl_scrape',
    'server_status',
    'health',
    'ping',
    'version'
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

test('HITL: routine changes on a user MCP run without prompts, high risk still asks', async () => {
  for (const tool of ['create_event', 'edit_note', 'update_document']) {
    assert.strictEqual(await hitl.checkApproval({ server: 'remote', tool,
      _prompt: async () => { throw new Error(`${tool} should not prompt`); } }), true);
  }
  let prompts = 0;
  await hitl.checkApproval({ server: 'remote', tool: 'send_message',
    _prompt: async () => { prompts++; return true; } });
  assert.strictEqual(prompts, 1);
});

test('HITL: routine workspace edits do not prompt; deletion still does', async () => {
  for (const tool of ['write_file', 'edit_file', 'create_directory']) {
    const ok = await hitl.checkApproval({ server: 'workspace', tool,
      _prompt: async () => { throw new Error(`${tool} should not prompt`); } });
    assert.strictEqual(ok, true);
  }
  let prompts = 0;
  await hitl.checkApproval({ server: 'workspace', tool: 'delete_file',
    _prompt: async () => { prompts++; return true; } });
  assert.strictEqual(prompts, 1);
});

test('HITL: coding mode asks for install, test-file writes, and one test phase only', async () => {
  const promptCalls = [];
  const prompt = async (call) => { promptCalls.push(call); return false; };
  assert.equal(await hitl.checkApproval({ server: 'workspace', tool: 'write_file', codingMode: true,
    args: { path: 'src/index.js' }, _prompt: prompt }), true);
  assert.equal(await hitl.checkApproval({ server: 'workspace', tool: 'write_file', codingMode: true,
    args: { path: 'tests/index.test.js' }, _prompt: prompt }), false);
  assert.equal(await hitl.checkApproval({ server: 'workspace', tool: 'edit_file', codingMode: true,
    args: { path: 'spec/another.spec.js' }, _prompt: prompt }), false);
  assert.equal(await hitl.checkApproval({ server: 'workspace', tool: 'install_project_dependencies', codingMode: true,
    args: { path: '.' }, _prompt: prompt }), false);
  assert.equal(await hitl.checkApproval({ server: 'workspace', tool: 'run_project_check', codingMode: true,
    args: { script: 'test' }, _prompt: prompt }), false);
  assert.equal(await hitl.checkApproval({ server: 'workspace', tool: 'start_project_server', codingMode: true,
    args: { script: 'start' }, _prompt: prompt }), false);
  assert.equal(promptCalls.length, 3, 'one denied test-write prompt and one prompt per protected phase');
  assert.equal(await hitl.checkApproval({ server: 'workspace', tool: 'write_file',
    args: { path: 'tests/index.test.js' }, _prompt: prompt }), true,
  'the coding-only test-file rule does not affect normal mode');
  hitl.startPrompt();
  await hitl.checkApproval({ server: 'workspace', tool: 'write_file', codingMode: true,
    args: { path: 'tests/index.test.js' }, _prompt: prompt });
  assert.equal(promptCalls.length, 4, 'a new prompt gets a fresh test-write decision');
});

test('HITL: shortcut row places Enter and Esc below their choices', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../src/core/hitl/mcpApproval'), 'utf8');
  assert.match(source, /\[Enter\].*\[Esc\]/);
  assert.doesNotMatch(source, /\[Enter\].*Allow.*\[Esc\].*Don't allow/);
});

test('HITL: MCP readOnlyHint is not authority', async () => {
  assert.strictEqual(
    hitl.requiresApproval('inventory_snapshot', { readOnlyHint: true }),
    true
  );
  assert.strictEqual(hitl.requiresApproval('query_and_charge', { readOnlyHint: true }), true);
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

test('HITL: browser observation and navigation do not create approval noise', async () => {
  for (const [tool, args] of [
    ['browser_navigate', { url: 'https://example.com' }],
    ['browser_snapshot', {}],
    ['browser_take_screenshot', {}]
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

test('HITL: user-added Playwright reads stay quiet but clicks still ask', async () => {
  for (const tool of ['browser_navigate', 'browser_snapshot', 'browser_wait_for']) {
    assert.strictEqual(await hitl.checkApproval({ server: 'microsoft_playwright-mcp', tool,
      _prompt: async () => { throw new Error(`${tool} should not prompt`); } }), true);
  }
  let prompts = 0;
  await hitl.checkApproval({ server: 'microsoft_playwright-mcp', tool: 'browser_click',
    _prompt: async () => { prompts++; return true; } });
  assert.strictEqual(prompts, 1);
});

test('HITL: essential browser actions require a fresh approval every time', async () => {
  const cases = [
    ['browser_click', { element: 'Place order', target: 'e20' }],
    ['browser_click', { target: 'e42' }],
    ['browser_drag', { start: 'e1', end: 'e2' }],
    ['browser_type', { element: 'Search', target: 'e8', text: 'MCP' }],
    ['browser_type', { element: 'Password', target: 'e5', text: 'secret', submit: true }],
    ['browser_fill_form', { fields: [{ name: 'Payment card', value: '4111111111111111' }] }],
    ['browser_file_upload', { paths: ['/tmp/report.pdf'] }],
    ['browser_drop', { paths: ['/tmp/report.pdf'], target: 'e7' }],
    ['browser_handle_dialog', { accept: true }],
    ['browser_press_key', { key: 'Enter' }],
    ['browser_press_key', { key: 'Space' }],
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

test('HITL: routine changes on one server need no approval', async () => {
  let calls = 0;
  const fakePrompt = async () => {
    calls++;
    return true;
  };
  const first = await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(first, true);
  // Creating a directory and editing another file on this server are covered.
  const second = await hitl.checkApproval({ server: 'fs', tool: 'create_directory', args: {}, _prompt: fakePrompt });
  const third = await hitl.checkApproval({ server: 'fs', tool: 'edit_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(second, true);
  assert.strictEqual(third, true);
  assert.strictEqual(calls, 0);
});

test('HITL: routine changes stay quiet across user prompts', async () => {
  let calls = 0;
  const fakePrompt = async () => {
    calls++;
    return true;
  };
  await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: fakePrompt });
  hitl.startPrompt();
  await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(calls, 0);
});

test('HITL: exact workspace execution retries reuse approval only within one prompt', async () => {
  let prompts = 0;
  const prompt = async () => { prompts++; return true; };
  const args = { script: 'test:api', path: '.' };
  await hitl.checkApproval({ server: 'workspace', tool: 'run_project_check', args, _prompt: prompt });
  await hitl.checkApproval({ server: 'workspace', tool: 'run_project_check', args, _prompt: prompt });
  assert.strictEqual(prompts, 1);
  hitl.startPrompt();
  await hitl.checkApproval({ server: 'workspace', tool: 'run_project_check', args, _prompt: prompt });
  assert.strictEqual(prompts, 2);
});

test('HITL: a routine tool updates the live indicator before running', async () => {
  const spinner = { isSpinning: true, text: '' };
  hitl.setSpinner(spinner);
  await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: async () => true });
  await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: async () => {
    throw new Error('should not re-prompt');
  } });
  assert.match(spinner.text, /routine tool/);
  assert.match(spinner.text, /running: write_file/);
});

test('HITL: another server requires its own approval in the same prompt', async () => {
  let calls = 0;
  const fakePrompt = async () => {
    calls++;
    return true;
  };
  await hitl.checkApproval({ server: 'fs', tool: 'send_message', args: {}, _prompt: fakePrompt });
  assert.strictEqual(calls, 1);
  await hitl.checkApproval({ server: 'other', tool: 'send_message', args: {}, _prompt: fakePrompt });
  assert.strictEqual(calls, 2);
});

test('HITL: distinct sequential routine calls need no approval', async () => {
  let calls = 0;
  const fakePrompt = async () => {
    calls++;
    return true;
  };
  const a = await hitl.checkApproval({ server: 'fs', tool: 'create_directory', args: {}, _prompt: fakePrompt });
  const b = await hitl.checkApproval({ server: 'fs', tool: 'write_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(a, true);
  assert.strictEqual(b, true);
  assert.strictEqual(calls, 0);
});

test('HITL: deletes, sends, execution, unknown tools and destructive hints always ask', async () => {
  for (const [tool, annotations] of [
    ['delete_file', {}], ['send_message', {}], ['run_command', {}],
    ['mystery_action', {}], ['write_file', { destructiveHint: true }]
  ]) {
    let calls = 0;
    const options = { server: 'fs', tool, annotations,
      _prompt: async () => { calls++; return true; } };
    await hitl.checkApproval(options);
    await hitl.checkApproval(options);
    assert.strictEqual(calls, 2, tool);
    hitl.startPrompt();
  }
});

test('HITL: a denied call blocks that call, but next call asks again', async () => {
  let calls = 0;
  const fakePrompt = async () => {
    calls++;
    return false;
  };
  const first = await hitl.checkApproval({ server: 'fs', tool: 'delete_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(first, false);
  // With _prompt override, each call invokes the prompt (no pending cache).
  // In real interactive mode, a pending promise would be reused within the same batch.
  const second = await hitl.checkApproval({ server: 'fs', tool: 'delete_file', args: {}, _prompt: fakePrompt });
  assert.strictEqual(second, false);
  assert.strictEqual(calls, 2);
  // Denied calls are NOT remembered for the session - next call asks again.
  const third = await hitl.checkApproval({ server: 'fs', tool: 'delete_file', args: {}, _prompt: fakePrompt });
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

test('HITL: promptApproval restores keypress listeners and enforces rawMode when TTY', async () => {
  const stdin = process.stdin;
  const originalIsTTY = stdin.isTTY;
  const originalSetRawMode = stdin.setRawMode;
  const rawModeCalls = [];
  stdin.isTTY = true;
  stdin.setRawMode = (mode) => { rawModeCalls.push(mode); };

  let fakeEscWatcherRan = false;
  const fakeEscWatcher = () => { fakeEscWatcherRan = true; };
  stdin.on('keypress', fakeEscWatcher);

  try {
    const promptPromise = hitl._promptApproval({ server: 'workspace', tool: 'write_file', args: { path: 'foo.txt' } });
    // Simulate user pressing Enter to approve
    stdin.emit('keypress', '\r', { name: 'return' });
    const allowed = await promptPromise;
    assert.strictEqual(allowed, true);
    // Keypress listener was restored
    assert.ok(stdin.listeners('keypress').includes(fakeEscWatcher));
    // Raw mode was kept active (last call setRawMode(true))
    assert.strictEqual(rawModeCalls[rawModeCalls.length - 1], true);
  } finally {
    stdin.removeListener('keypress', fakeEscWatcher);
    stdin.isTTY = originalIsTTY;
    stdin.setRawMode = originalSetRawMode;
    stdin.pause();
  }
});

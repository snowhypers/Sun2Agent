const { test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../src/core/mcp/registry');
const computer = require('../src/core/mcp/computer');
const mcp = require('../src/core/mcp');
const hitl = require('../src/core/hitl/mcpApproval');
const { formatToolResult } = require('../src/core/mcp/toolResult');
const { requestWithRetry, retryDelay } = require('../src/core/modelRetry');
const { sanitize } = require('../src/core/observability/langsmith');
const connection = (builtin) => ({ builtin, type: 'stdio', tools: [], client: { close: async () => {} } });

afterEach(async () => { await computer.disconnect(); await registry.disconnectAll(); hitl._resetForTesting(); });

test('computer: pinned opt-in npx server with bounded connection', () => {
  assert.equal(computer.isConnected(), false);
  assert.deepEqual(computer.createServer().args, ['-y', '@zavora-ai/computer-use-mcp@7.4.0']);
  assert.equal(computer.createServer().connectTimeoutMs, 30000);
  assert.equal(computer.isReservedUserServer({ name: 'computer' }), true);
});

test('computer: independent connection, visible tag, idempotence, disconnect', async () => {
  registry.set('browser', connection(true));
  registry.set('workspace', connection(true));
  registry.set('remote', connection(false));
  let calls = 0;
  const connect = async (server) => { calls++; registry.set(server.name, connection(true)); return []; };
  assert.equal((await computer.connect(connect)).ok, true);
  await computer.connect(connect);
  assert.equal(calls, 1);
  computer.setVision(true);
  assert.equal(computer.usesVision(), true);
  assert.equal(mcp.getTag(), 'browser @computer @remote');
  await computer.disconnect();
  assert.equal(computer.usesVision(), false);
  assert.equal(mcp.getTag(), 'browser @remote');
  assert.equal(registry.has('workspace'), true);
});

test('computer: failed connection cleans up and returns error', async () => {
  const result = await computer.connect(async () => {
    registry.set('computer', connection(true));
    throw new Error('Connection cancelled');
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /cancelled/);
  assert.equal(computer.isConnected(), false);
});

test('computer: fresh approval for every desktop change despite readOnlyHint', async () => {
  let prompts = 0;
  const check = (tool) => hitl.checkApproval({ server: 'computer', tool,
    annotations: { readOnlyHint: true }, enabled: true, _prompt: async () => { prompts++; return true; } });
  await check('get_ui_tree');
  await check('doctor');
  assert.equal(prompts, 0);
  await check('left_click');
  await check('left_click');
  await check('run_script');
  assert.equal(prompts, 3);
});

test('computer: screenshot is omitted for text-only models, preserved as image for vision', () => {
  const result = { content: [{ type: 'text', text: 'Window opened' },
    { type: 'image', mimeType: 'image/png', data: 'YWJjZA==' }] };
  assert.doesNotMatch(formatToolResult(result), /YWJjZA/);
  assert.match(formatToolResult(result), /Do not claim/);
  const rich = formatToolResult(result, true);
  assert.equal(rich.images[0].image_url.url, 'data:image/png;base64,YWJjZA==');
  assert.doesNotMatch(rich.text, /YWJjZA/);
  assert.doesNotMatch(JSON.stringify(sanitize(rich)), /YWJjZA/);
  assert.doesNotMatch(JSON.stringify(sanitize(rich.images)), /YWJjZA/);
});

test('computer: unsupported, invalid and oversized screenshots are not sent', () => {
  for (const block of [
    { mimeType: 'image/svg+xml', data: 'YWJjZA==' },
    { mimeType: 'image/png', data: '<script>' },
    { mimeType: 'image/png', data: 'a'.repeat(4 * 1024 * 1024 + 1) }
  ]) assert.equal(formatToolResult({ content: [{ type: 'image', ...block }] }, true).images.length, 0);
});

test('computer: retry once with Retry-After; original request closure reused', async () => {
  let calls = 0;
  let waitMs;
  const result = await requestWithRetry(async () => {
    calls++;
    if (calls === 1) throw { response: { status: 429, headers: { 'retry-after': '2' } } };
    return 'ok';
  }, { enabled: true, wait: async (ms) => { waitMs = ms; } });
  assert.equal(result, 'ok');
  assert.equal(calls, 2);
  assert.equal(waitMs, 2000);
});

test('computer: does not retry validation/auth errors or long cooldowns', async () => {
  for (const status of [400, 401, 403]) assert.equal(retryDelay({ response: { status } }), null);
  assert.equal(retryDelay({ response: { status: 429, headers: { 'retry-after': '90' } } }), null);
  let calls = 0;
  await assert.rejects(requestWithRetry(async () => { calls++; throw new Error('bad request'); }, { enabled: true }));
  assert.equal(calls, 1);
});

test('computer: two failed model requests terminate; retry disabled elsewhere', async () => {
  let calls = 0;
  const send = async () => { calls++; throw Object.assign(new Error('unavailable'), { response: { status: 503 } }); };
  await assert.rejects(requestWithRetry(send, { enabled: true, wait: async () => {} }), /unavailable/);
  assert.equal(calls, 2);
  calls = 0;
  await assert.rejects(requestWithRetry(send), /unavailable/);
  assert.equal(calls, 1);
});

test('computer: Esc cancels backoff before a second model request', async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(requestWithRetry(async () => {
    calls++; throw { response: { status: 503 } };
  }, { enabled: true, signal: controller.signal, onRetry: () => controller.abort() }), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('computer: commands and empty-input Esc disconnect are wired', () => {
  const { COMMANDS } = require('../src/cli/commands');
  assert.equal(typeof COMMANDS['/computer'], 'function');
  assert.equal(typeof COMMANDS['/computer disconnect'], 'function');
  const source = require('node:fs').readFileSync(require.resolve('../src/cli/index'), 'utf8');
  assert.match(source, /input === ESC_BACK[\s\S]*mcp.isComputerConnected\(\)[\s\S]*mcp.disconnectComputer\(\)/);
});

test('computer: full turn retries the model after tool success without replaying the tool', async (t) => {
  const axios = require('axios');
  const { chatTurn } = require('../src/cli/turn');
  let toolCalls = 0;
  let modelCalls = 0;
  registry.set('computer', { ...connection(true),
    tools: [{ name: 'screenshot', inputSchema: { type: 'object', properties: {} } }],
    client: { close: async () => {}, request: async () => {
      toolCalls++;
      return { content: [{ type: 'image', mimeType: 'image/png', data: 'YWJjZA==' }] };
    } }
  });
  computer.setVision(true);
  t.mock.method(axios, 'post', async (_url, body) => {
    modelCalls++;
    if (modelCalls === 1) return { data: { choices: [{ message: {
      role: 'assistant', content: '', tool_calls: [{ id: 'shot', type: 'function',
        function: { name: 'computer__screenshot', arguments: '{}' } }]
    } }] } };
    assert.equal(body.messages.at(-1).content[1].type, 'image_url');
    if (modelCalls === 2) throw Object.assign(new Error('rate limited'), {
      response: { status: 429, headers: { 'retry-after': '0' } }
    });
    return { data: { choices: [{ message: { role: 'assistant', content: 'Observed the window.' } }] } };
  });
  const history = [{ role: 'user', content: 'Inspect the window' }];
  assert.equal(await chatTurn({ apiKey: 'test', model: 'test', selectedSkills: [] }, history), 'Observed the window.');
  assert.equal(modelCalls, 3);
  assert.equal(toolCalls, 1);
  assert.doesNotMatch(JSON.stringify(history), /YWJjZA/);
});
